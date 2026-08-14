import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { callNotaApi, NotaApiError } from "../scripts/nota-api.mjs";

function requestFile() {
  const directory = mkdtempSync(join(tmpdir(), "nota-api-test-"));
  const file = join(directory, "request.json");
  writeFileSync(file, '{"operation":"PREFLIGHT_VERCEL"}\n');
  return file;
}

const env = {
  NOTA_ENVIRONMENT: "development",
  NOTA_REQUEST_FILE: requestFile(),
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?x=1",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
};

test("uses a fixed control plane and endpoint-specific OIDC audience", async () => {
  const calls = [];
  const result = await callNotaApi("preflight", env, async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://oidc.example/")) {
      return new Response('{"value":"signed-oidc"}', { status: 200 });
    }
    return new Response('{"ok":true}', { status: 200 });
  });
  assert.deepEqual(result, { ok: true });
  const audience = new URL(calls[0].url).searchParams.get("audience");
  assert.equal(
    audience,
    "https://dev.trynota.ai/api/ci/v1/github/attestations/preflight",
  );
  assert.equal(calls[1].url, audience);
  assert.equal(calls[1].init.headers.Authorization, "Bearer signed-oidc");
});

test("rejects arbitrary control planes and returns only bounded safe errors", async () => {
  await assert.rejects(
    callNotaApi("preflight", {
      ...env,
      NOTA_ENVIRONMENT: "https://evil.example",
    }),
    NotaApiError,
  );
  await assert.rejects(
    callNotaApi("preflight", env, async (url) =>
      String(url).startsWith("https://oidc.example/")
        ? new Response('{"value":"signed-oidc"}', { status: 200 })
        : new Response('{"error":"unsafe error with spaces"}', { status: 401 }),
    ),
    (error) =>
      error instanceof NotaApiError && error.code === "NOTA_REQUEST_REJECTED",
  );
  await assert.rejects(
    callNotaApi(
      "preflight",
      env,
      async () => new Response("x".repeat(130 * 1024)),
    ),
    /GITHUB_OIDC_RESPONSE_TOO_LARGE/,
  );
});

test("retries an ambiguous BEGIN response once with the same OIDC token and body", async () => {
  const calls = [];
  let posts = 0;
  const result = await callNotaApi(
    "attest",
    { ...env, NOTA_REQUEST_FILE: requestFile() },
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("https://oidc.example/")) {
        return new Response('{"value":"signed-oidc"}', { status: 200 });
      }
      posts += 1;
      if (posts === 1) throw new TypeError("response lost");
      return new Response('{"attestationId":"ok"}', { status: 200 });
    },
    { retryIdenticalPostOnce: true },
  );

  assert.deepEqual(result, { attestationId: "ok" });
  assert.equal(
    calls.filter((call) => call.url.startsWith("https://oidc.example/")).length,
    1,
  );
  const postCalls = calls.filter((call) =>
    call.url.startsWith("https://dev.trynota.ai/"),
  );
  assert.equal(postCalls.length, 2);
  assert.equal(postCalls[0].init.headers.Authorization, "Bearer signed-oidc");
  assert.equal(postCalls[1].init.headers.Authorization, "Bearer signed-oidc");
  assert.deepEqual(postCalls[0].init.body, postCalls[1].init.body);
});
