import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const LIMIT = 128 * 1024;
const ENDPOINTS = {
  production: "https://app.trynota.ai",
  development: "https://dev.trynota.ai",
};
const PATHS = {
  preflight: "/api/ci/v1/github/attestations/preflight",
  attest: "/api/ci/v1/github/attestations",
  smoke: "/api/ci/v1/github/static-smoke",
};

export class NotaApiError extends Error {
  constructor(code) {
    super(code);
    this.name = "NotaApiError";
    this.code = code;
  }
}

function fail(code) {
  throw new NotaApiError(code);
}

async function boundedJson(response, code) {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > LIMIT) fail(`${code}_TOO_LARGE`);
  const reader = response.body?.getReader();
  if (!reader) fail(`${code}_INVALID`);
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > LIMIT) {
      await reader.cancel();
      fail(`${code}_TOO_LARGE`);
    }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks, bytes).toString("utf8");
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${code}_INVALID`);
    return value;
  } catch (error) {
    if (error instanceof NotaApiError) throw error;
    fail(`${code}_INVALID`);
  }
}

export async function callNotaApi(
  command,
  env = process.env,
  fetchImpl = fetch,
) {
  const base = ENDPOINTS[env.NOTA_ENVIRONMENT];
  const path = PATHS[command];
  if (!base || !path) fail("INVALID_NOTA_ENDPOINT");
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (
    !requestUrl?.startsWith("https://") ||
    !requestToken ||
    requestToken.length > 16 * 1024
  ) {
    fail("GITHUB_OIDC_UNAVAILABLE");
  }
  const file = env.NOTA_REQUEST_FILE;
  if (!file?.startsWith("/")) fail("INVALID_NOTA_REQUEST_FILE");
  const bytes = readFileSync(file);
  if (bytes.length < 2 || bytes.length > LIMIT) fail("INVALID_NOTA_REQUEST");
  let body;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("INVALID_NOTA_REQUEST");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    fail("INVALID_NOTA_REQUEST");
  }
  const endpoint = `${base}${path}`;
  const oidcUrl = new URL(requestUrl);
  oidcUrl.searchParams.set("audience", endpoint);
  const oidcResponse = await fetchImpl(oidcUrl, {
    headers: { Authorization: `Bearer ${requestToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!oidcResponse.ok) fail("GITHUB_OIDC_UNAVAILABLE");
  const oidc = await boundedJson(oidcResponse, "GITHUB_OIDC_RESPONSE");
  if (typeof oidc.value !== "string" || oidc.value.length > 16 * 1024) {
    fail("GITHUB_OIDC_RESPONSE_INVALID");
  }
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${oidc.value}`,
      "Content-Type": "application/json",
    },
    body: bytes,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const result = await boundedJson(response, "NOTA_RESPONSE");
  if (!response.ok) {
    const code =
      typeof result.error === "string" && /^[A-Z0-9_]{1,80}$/.test(result.error)
        ? result.error
        : "NOTA_REQUEST_REJECTED";
    fail(code);
  }
  return result;
}

async function main() {
  try {
    process.stdout.write(`${JSON.stringify(await callNotaApi(process.argv[2]))}\n`);
  } catch (error) {
    const code = error instanceof NotaApiError ? error.code : "NOTA_API_UNAVAILABLE";
    process.stderr.write(`Nota attestation request failed: ${code}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
