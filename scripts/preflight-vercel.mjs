import { pathToFileURL } from "node:url";

const API = "https://api.vercel.com";
const LIMIT = 128 * 1024;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function required(env, name, pattern) {
  const value = env[name];
  if (!value || !pattern.test(value)) fail(`INVALID_${name}`);
  return value;
}

async function json(path, token, fetchImpl) {
  const response = await fetchImpl(`${API}${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) fail("VERCEL_PREFLIGHT_UNAVAILABLE");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > LIMIT) {
    fail("VERCEL_PREFLIGHT_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) fail("VERCEL_PREFLIGHT_INVALID");
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > LIMIT) {
      await reader.cancel();
      fail("VERCEL_PREFLIGHT_TOO_LARGE");
    }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks, bytes).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    fail("VERCEL_PREFLIGHT_INVALID");
  }
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("VERCEL_PREFLIGHT_INVALID");
  }
  return value;
}

function containsExactString(
  value,
  expected,
  depth = 0,
  budget = { remaining: 10_000 },
) {
  if (budget.remaining-- <= 0 || depth > 20) fail("VERCEL_PREFLIGHT_TOO_LARGE");
  if (value === expected) return true;
  if (Array.isArray(value)) {
    return value.some((item) =>
      containsExactString(item, expected, depth + 1, budget),
    );
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((item) =>
      containsExactString(item, expected, depth + 1, budget),
    );
  }
  return false;
}

function targetIncludesPreview(value) {
  const targets = Array.isArray(value) ? value : value ? [value] : [];
  return targets.length === 0 || targets.includes("preview");
}

const CONFIGURATION_STATUSES = new Set([
  "error",
  "onboarding",
  "pending",
  "ready",
  "resumed",
  "suspended",
  "uninstalled",
]);

function configurationCanAccessProject(configurations, projectId) {
  if (!Array.isArray(configurations)) fail("VERCEL_PREFLIGHT_INVALID");
  for (const value of configurations) {
    const configuration = record(value);
    const status = configuration.status ?? "ready";
    if (typeof status !== "string" || !CONFIGURATION_STATUSES.has(status)) {
      fail("VERCEL_PREFLIGHT_INVALID");
    }
    if (
      configuration.deletedAt !== undefined &&
      configuration.deletedAt !== null &&
      (!Number.isSafeInteger(configuration.deletedAt) ||
        configuration.deletedAt < 1)
    ) {
      fail("VERCEL_PREFLIGHT_INVALID");
    }
    const inactive =
      status === "uninstalled" ||
      (typeof configuration.deletedAt === "number" &&
        configuration.deletedAt > 0);
    if (inactive) continue;

    // Vercel defines an absent `projects` field as full-account access. Treat
    // null and every unknown shape as broad authority, never as credential-free.
    if (!Array.isArray(configuration.projects)) return true;
    if (
      configuration.projects.some(
        (project) =>
          typeof project !== "string" ||
          !/^prj_[A-Za-z0-9]{8,128}$/.test(project),
      )
    ) {
      fail("VERCEL_PREFLIGHT_INVALID");
    }
    if (configuration.projects.includes(projectId)) return true;
  }
  return false;
}

async function projectEnvironmentVariables(projectId, team, token, fetchImpl) {
  const values = [];
  let until = null;
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({
      teamId: team,
      decrypt: "false",
      limit: "100",
    });
    if (until !== null) query.set("until", String(until));
    const payload = record(
      await json(
        `/v10/projects/${encodeURIComponent(projectId)}/env?${query}`,
        token,
        fetchImpl,
      ),
    );
    if (!Array.isArray(payload.envs)) fail("VERCEL_PREFLIGHT_INVALID");
    values.push(...payload.envs);
    const pagination =
      payload.pagination == null ? {} : record(payload.pagination);
    if (pagination.next == null) return values;
    until = pagination.next;
  }
  fail("VERCEL_PREFLIGHT_PAGINATION_LIMIT");
}

async function sharedEnvironmentVariables(projectId, team, token, fetchImpl) {
  const values = [];
  let until = null;
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({
      teamId: team,
      projectId,
      limit: "100",
    });
    if (until !== null) query.set("until", String(until));
    const payload = record(await json(`/v1/env?${query}`, token, fetchImpl));
    if (!Array.isArray(payload.data)) fail("VERCEL_PREFLIGHT_INVALID");
    values.push(...payload.data);
    const pagination = record(payload.pagination);
    if (pagination.next == null) return values;
    until = pagination.next;
  }
  fail("VERCEL_PREFLIGHT_PAGINATION_LIMIT");
}

export async function preflightVercel(env = process.env, fetchImpl = fetch) {
  const projectId = required(
    env,
    "VERCEL_PROJECT_ID",
    /^prj_[A-Za-z0-9]{8,128}$/,
  );
  const teamId = required(env, "VERCEL_ORG_ID", /^team_[A-Za-z0-9]{8,128}$/);
  const token = required(
    env,
    "VERCEL_TOKEN",
    /^[^\u0000-\u001f\u007f]{20,512}$/,
  );
  const team = encodeURIComponent(teamId);
  const project = record(
    await json(
      `/v9/projects/${encodeURIComponent(projectId)}?teamId=${team}`,
      token,
      fetchImpl,
    ),
  );
  if (
    project.id !== projectId ||
    (project.accountId ?? project.teamId) !== teamId ||
    project.link != null ||
    record(project.oidcTokenConfig ?? {}).enabled === true ||
    project.autoExposeSystemEnvs === true ||
    project.ssoProtection != null ||
    project.passwordProtection != null ||
    project.deploymentProtection != null ||
    (project.protectionBypass != null &&
      Object.keys(record(project.protectionBypass)).length > 0)
  ) {
    fail("VERCEL_PROJECT_NOT_CREDENTIAL_FREE");
  }
  const [projectVariables, sharedVariables, configurations, stores] =
    await Promise.all([
      projectEnvironmentVariables(projectId, team, token, fetchImpl),
      sharedEnvironmentVariables(projectId, team, token, fetchImpl),
      json(
        `/v2/integrations/configurations?teamId=${team}&view=account`,
        token,
        fetchImpl,
      ),
      json(`/v1/storage/stores?teamId=${team}`, token, fetchImpl),
    ]);
  for (const entry of [...projectVariables, ...sharedVariables]) {
    const variable = record(entry);
    if (targetIncludesPreview(variable.target)) {
      fail("VERCEL_PREVIEW_VARIABLES_PRESENT");
    }
  }
  if (
    configurationCanAccessProject(configurations, projectId) ||
    containsExactString(stores, projectId)
  ) {
    fail("VERCEL_PROJECT_INTEGRATIONS_PRESENT");
  }
  return {
    projectId,
    teamId,
    credentialFree: true,
    previewVariables: 0,
    projectIntegrations: 0,
    automationBypass: false,
  };
}

async function main() {
  try {
    process.stdout.write(`${JSON.stringify(await preflightVercel())}\n`);
  } catch (error) {
    process.stderr.write(
      `Nota Vercel preflight failed: ${error.code ?? "VERCEL_PREFLIGHT_UNAVAILABLE"}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
