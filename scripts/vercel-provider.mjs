import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const API = "https://api.vercel.com";
const OUTPUT_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const PROJECT = /^prj_[A-Za-z0-9]{8,128}$/;
const TEAM = /^team_[A-Za-z0-9]{8,128}$/;
const KEY = /^[A-Za-z0-9._:-]{16,160}$/;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{8,160}$/;

export class VercelProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = "VercelProviderError";
    this.code = code;
  }
}

function fail(code) {
  throw new VercelProviderError(code);
}

function required(env, name, pattern) {
  const value = env[name];
  if (!value || !pattern.test(value)) fail(`INVALID_${name}`);
  return value;
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === "") return fallback;
  if (!/^[0-9]+$/.test(value)) fail("INVALID_TIMEOUT");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail("INVALID_TIMEOUT");
  }
  return parsed;
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function deploymentUrl(value) {
  let url;
  try {
    url = new URL(value.startsWith("https://") ? value : `https://${value}`);
  } catch {
    fail("INVALID_PROVIDER_URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash ||
    !url.hostname.endsWith(".vercel.app")
  ) {
    fail("INVALID_PROVIDER_URL");
  }
  return url.origin;
}

async function apiJson(path, token, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    fail("PROVIDER_READ_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) fail("PROVIDER_READ_REJECTED");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > OUTPUT_LIMIT) {
    fail("PROVIDER_RESPONSE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) fail("PROVIDER_RESPONSE_INVALID");
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > OUTPUT_LIMIT) {
      await reader.cancel();
      fail("PROVIDER_RESPONSE_TOO_LARGE");
    }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks, bytes).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    fail("PROVIDER_RESPONSE_INVALID");
  }
}

function record(value, code = "PROVIDER_RESPONSE_INVALID") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

export function verifyDeployment(value, expected) {
  const item = record(value);
  const id = item.uid ?? item.id;
  const projectId = item.projectId ?? record(item.project ?? {}).id;
  const ownerId = item.teamId ?? item.ownerId ?? record(item.team ?? {}).id;
  const meta = record(item.meta ?? {});
  const state = item.readyState ?? item.state;
  if (
    typeof id !== "string" ||
    !DEPLOYMENT_ID.test(id) ||
    projectId !== expected.projectId ||
    ownerId !== expected.teamId ||
    meta.notaAttestation !== expected.recoveryKey ||
    item.target === "production"
  ) {
    fail("PROVIDER_METADATA_MISMATCH");
  }
  if (state !== "READY") fail("PROVIDER_NOT_READY");
  const origin = deploymentUrl(String(item.url ?? ""));
  if (expected.candidateOrigin && origin !== expected.candidateOrigin) {
    fail("PROVIDER_URL_MISMATCH");
  }
  return { deploymentId: id, origin, projectId, teamId: ownerId, state };
}

async function getDeployment(idOrHost, settings) {
  const value = await apiJson(
    `/v13/deployments/${encodeURIComponent(idOrHost)}?teamId=${encodeURIComponent(settings.teamId)}`,
    settings.token,
    settings.fetchImpl,
  );
  return verifyDeployment(value, settings);
}

function listItems(value) {
  const payload = record(value);
  if (!Array.isArray(payload.deployments)) fail("PROVIDER_RESPONSE_INVALID");
  return payload.deployments;
}

async function recoverDeployment(settings) {
  const matches = new Map();
  let until = "";
  let exhausted = false;
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({
      projectId: settings.projectId,
      teamId: settings.teamId,
      limit: "100",
      "meta-notaAttestation": settings.recoveryKey,
    });
    if (until) query.set("until", until);
    const value = await apiJson(
      `/v6/deployments?${query}`,
      settings.token,
      settings.fetchImpl,
    );
    const items = listItems(value);
    for (const item of items) {
      const deployment = record(item);
      const meta = record(deployment.meta ?? {});
      if (meta.notaAttestation === settings.recoveryKey) {
        const id = deployment.uid ?? deployment.id;
        if (typeof id !== "string" || !DEPLOYMENT_ID.test(id)) {
          fail("PROVIDER_RESPONSE_INVALID");
        }
        matches.set(id, id);
      }
    }
    if (items.length < 100) {
      exhausted = true;
      break;
    }
    const pagination = record(value.pagination ?? {});
    const next = pagination.next ?? pagination.until;
    if (typeof next !== "number" && typeof next !== "string") {
      fail("PROVIDER_PAGINATION_INCOMPLETE");
    }
    until = String(next);
  }
  if (!exhausted) fail("PROVIDER_PAGINATION_INCOMPLETE");
  if (matches.size === 0) fail("PROVIDER_MUTATION_UNCERTAIN");
  if (matches.size !== 1) fail("PROVIDER_METADATA_COLLISION");
  return getDeployment([...matches.keys()][0], settings);
}

function runCli(executable, args, options) {
  return new Promise((resolveRun) => {
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    let started = false;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.once("spawn", () => {
      started = true;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > OUTPUT_LIMIT) {
        overflow = true;
        child.kill("SIGKILL");
      } else {
        stdout = Buffer.concat([stdout, chunk]);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > OUTPUT_LIMIT) {
        overflow = true;
        child.kill("SIGKILL");
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolveRun({ started, code: null, stdout: "", timedOut, overflow });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveRun({
        started,
        code,
        stdout: stdout.toString("utf8").trim(),
        timedOut,
        overflow,
      });
    });
  });
}

export function prepareVercelOperation(env = process.env, dependencies = {}) {
  const operation = env.NOTA_PROVIDER_OPERATION;
  if (operation !== "DEPLOY" && operation !== "RECOVER") {
    fail("INVALID_PROVIDER_OPERATION");
  }
  const helperRoot = realpathSync(required(env, "NOTA_HELPER_ROOT", /^\/.+/));
  const uploadRoot = realpathSync(required(env, "NOTA_UPLOAD_ROOT", /^\/.+/));
  if (
    !isAbsolute(uploadRoot) ||
    inside(uploadRoot, helperRoot) ||
    inside(helperRoot, uploadRoot)
  ) {
    fail("INVALID_UPLOAD_ROOT");
  }
  const executable = realpathSync(resolve(helperRoot, "node_modules/.bin/vercel"));
  if (!inside(helperRoot, executable)) fail("INVALID_VERCEL_EXECUTABLE");
  const settings = {
    projectId: required(env, "VERCEL_PROJECT_ID", PROJECT),
    teamId: required(env, "VERCEL_ORG_ID", TEAM),
    recoveryKey: required(env, "NOTA_RECOVERY_KEY", KEY),
    token: required(env, "VERCEL_TOKEN", /^[^\u0000-\u001f\u007f]{20,512}$/),
    fetchImpl: dependencies.fetchImpl ?? fetch,
    candidateOrigin: null,
  };
  const timeout =
    operation === "DEPLOY"
      ? boundedInteger(env.NOTA_PROVIDER_TIMEOUT_SECONDS, 900, 60, 1_800)
      : null;
  const minimalEnv = {
    HOME: env.RUNNER_TEMP,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    NODE_ENV: "production",
    NO_COLOR: "1",
    VERCEL_TOKEN: settings.token,
    VERCEL_ORG_ID: settings.teamId,
    VERCEL_PROJECT_ID: settings.projectId,
  };
  if (!minimalEnv.HOME || !isAbsolute(minimalEnv.HOME)) fail("INVALID_RUNNER_TEMP");
  return {
    operation,
    executable,
    uploadRoot,
    settings,
    timeout,
    minimalEnv,
    runCli: dependencies.runCli ?? runCli,
  };
}

export async function executePreparedVercelOperation(prepared) {
  if (prepared.operation === "RECOVER") {
    return recoverDeployment(prepared.settings);
  }
  const result = await prepared.runCli(
    prepared.executable,
    [
      "deploy",
      ".",
      "--yes",
      "--no-color",
      "--target=preview",
      "--skip-domain",
      "--project",
      prepared.settings.projectId,
      "--meta",
      `notaAttestation=${prepared.settings.recoveryKey}`,
      "--scope",
      prepared.settings.teamId,
    ],
    {
      cwd: prepared.uploadRoot,
      env: prepared.minimalEnv,
      timeoutMs: prepared.timeout * 1000,
    },
  );
  if (!result.started) fail("PROVIDER_DEFINITELY_NOT_SENT");
  if (
    result.code === 0 &&
    !result.timedOut &&
    !result.overflow &&
    result.stdout
  ) {
    prepared.settings.candidateOrigin = deploymentUrl(result.stdout);
    return getDeployment(
      new URL(prepared.settings.candidateOrigin).hostname,
      prepared.settings,
    );
  }
  return recoverDeployment(prepared.settings);
}

export async function deployOrRecover(env = process.env, dependencies = {}) {
  return executePreparedVercelOperation(
    prepareVercelOperation(env, dependencies),
  );
}

async function main() {
  try {
    const result = await deployOrRecover();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof VercelProviderError
        ? error.code
        : "PROVIDER_HELPER_UNAVAILABLE";
    process.stderr.write(`Nota Vercel attestation failed: ${code}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
