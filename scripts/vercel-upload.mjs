import {
  mkdtempSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { callNotaApi, NotaApiError } from "./nota-api.mjs";
import { deployOrRecover, VercelProviderError } from "./vercel-provider.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(code) {
  throw new VercelProviderError(code);
}

async function beginProvider(env, callApi) {
  if (!env.RUNNER_TEMP?.startsWith("/")) fail("INVALID_RUNNER_TEMP");
  if (!UUID.test(env.NOTA_ATTESTATION_ID ?? "")) fail("INVALID_ATTESTATION_ID");
  if (env.NOTA_PROVIDER_OPERATION !== "DEPLOY" && env.NOTA_PROVIDER_OPERATION !== "RECOVER") {
    fail("INVALID_PROVIDER_OPERATION");
  }
  const directory = mkdtempSync(join(env.RUNNER_TEMP, "nota-provider-begin-"));
  const requestFile = join(directory, "request.json");
  try {
    writeFileSync(
      requestFile,
      `${JSON.stringify({
        operation: "BEGIN_VERCEL_UPLOAD",
        attestationId: env.NOTA_ATTESTATION_ID,
        providerOperation: env.NOTA_PROVIDER_OPERATION,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const response = await callApi("attest", {
      ...env,
      NOTA_REQUEST_FILE: requestFile,
    });
    if (
      response.attestationId !== env.NOTA_ATTESTATION_ID ||
      response.providerOperation !== env.NOTA_PROVIDER_OPERATION
    ) {
      fail("NOTA_BEGIN_RESPONSE_MISMATCH");
    }
    return response;
  } finally {
    try {
      unlinkSync(requestFile);
    } catch {}
    try {
      rmdirSync(directory);
    } catch {}
  }
}

export async function uploadVercelWithAttestation(
  env = process.env,
  dependencies = {},
) {
  await beginProvider(env, dependencies.callNotaApi ?? callNotaApi);
  return (dependencies.deployOrRecover ?? deployOrRecover)(env, dependencies.providerDependencies);
}

async function main() {
  try {
    const result = await uploadVercelWithAttestation();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof NotaApiError || error instanceof VercelProviderError
        ? error.code
        : "VERCEL_UPLOAD_HELPER_UNAVAILABLE";
    process.stderr.write(`Nota Vercel upload failed: ${code}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
