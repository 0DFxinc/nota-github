import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";

import { NotaApiError } from "../scripts/nota-api.mjs";
import { uploadVercelWithAttestation } from "../scripts/vercel-upload.mjs";

const attestationId = "22222222-2222-4222-8222-222222222222";

function environment() {
  return {
    RUNNER_TEMP: tmpdir(),
    NOTA_ATTESTATION_ID: attestationId,
    NOTA_PROVIDER_OPERATION: "DEPLOY",
  };
}

test("durably begins the exact provider operation before invoking Vercel", async () => {
  const order = [];
  const result = await uploadVercelWithAttestation(environment(), {
    prepareVercelOperation: () => ({ operation: "DEPLOY" }),
    callNotaApi: async (command, env, fetchImpl, options) => {
      order.push(`nota:${command}`);
      assert.equal(command, "attest");
      assert.match(env.NOTA_REQUEST_FILE, /nota-provider-begin-/);
      assert.equal(fetchImpl, undefined);
      assert.deepEqual(options, { retryIdenticalPostOnce: true });
      return { attestationId, providerOperation: "DEPLOY" };
    },
    executePreparedVercelOperation: async () => {
      order.push("vercel");
      return { deploymentId: "dpl_12345678" };
    },
  });

  assert.deepEqual(order, ["nota:attest", "vercel"]);
  assert.deepEqual(result, { deploymentId: "dpl_12345678" });
});

test("never invokes Vercel when the durable begin response is lost", async () => {
  let providerCalls = 0;
  await assert.rejects(
    uploadVercelWithAttestation(environment(), {
      prepareVercelOperation: () => ({ operation: "DEPLOY" }),
      callNotaApi: async () => {
        throw new NotaApiError("NOTA_API_UNAVAILABLE");
      },
      executePreparedVercelOperation: async () => {
        providerCalls += 1;
      },
    }),
    /NOTA_API_UNAVAILABLE/,
  );
  assert.equal(providerCalls, 0);
});

test("rejects deterministic provider inputs before durable begin", async () => {
  let beginCalls = 0;
  await assert.rejects(
    uploadVercelWithAttestation(environment(), {
      prepareVercelOperation: () => {
        throw new Error("INVALID_TIMEOUT");
      },
      callNotaApi: async () => {
        beginCalls += 1;
      },
    }),
    /INVALID_TIMEOUT/,
  );
  assert.equal(beginCalls, 0);
});
