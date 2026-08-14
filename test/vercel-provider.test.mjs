import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  deployOrRecover,
  VercelProviderError,
  verifyDeployment,
} from "../scripts/vercel-provider.mjs";
import { preflightVercel } from "../scripts/preflight-vercel.mjs";

const expected = {
  projectId: "prj_12345678",
  teamId: "team_12345678",
  recoveryKey: "attestation:1234567890",
  candidateOrigin: "https://nota-abc123.vercel.app",
};

function deployment(overrides = {}) {
  return {
    uid: "dpl_12345678",
    projectId: expected.projectId,
    ownerId: expected.teamId,
    url: "nota-abc123.vercel.app",
    readyState: "READY",
    target: null,
    meta: { notaAttestation: expected.recoveryKey },
    ...overrides,
  };
}

test("accepts only the exact ready preview deployment metadata", () => {
  assert.deepEqual(verifyDeployment(deployment(), expected), {
    deploymentId: "dpl_12345678",
    origin: expected.candidateOrigin,
    projectId: expected.projectId,
    teamId: expected.teamId,
    state: "READY",
  });
  for (const changed of [
    { projectId: "prj_87654321" },
    { ownerId: "team_87654321" },
    { readyState: "BUILDING" },
    { target: "production" },
    { url: "stable.customer.example" },
    { meta: { notaAttestation: "attestation:other123" } },
  ]) {
    assert.throws(
      () => verifyDeployment(deployment(changed), expected),
      VercelProviderError,
    );
  }
});

test("response loss always recovers and never issues a second deploy", async () => {
  const calls = [];
  const directory = new URL("..", import.meta.url).pathname;
  const env = {
    NOTA_PROVIDER_OPERATION: "DEPLOY",
    NOTA_HELPER_ROOT: directory,
    NOTA_UPLOAD_ROOT: mkdtempSync(join(tmpdir(), "nota-provider-upload-")),
    NOTA_RECOVERY_KEY: expected.recoveryKey,
    VERCEL_PROJECT_ID: expected.projectId,
    VERCEL_ORG_ID: expected.teamId,
    VERCEL_TOKEN: "v".repeat(32),
    RUNNER_TEMP: "/tmp",
  };
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/v6/deployments?")) {
      return new Response(
        JSON.stringify({ deployments: [deployment()], pagination: {} }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(deployment()), { status: 200 });
  };
  let cliCalls = 0;
  let cliInvocation;
  await deployOrRecover(env, {
    fetchImpl,
    runCli: async (executable, args, options) => {
      cliCalls += 1;
      cliInvocation = { executable, args, options };
      return {
        started: true,
        code: null,
        stdout: "",
        timedOut: true,
        overflow: false,
      };
    },
  });
  assert.equal(cliCalls, 1);
  assert.ok(cliInvocation.args.includes("--skip-domain"));
  assert.deepEqual(
    cliInvocation.args.slice(
      cliInvocation.args.indexOf("--project"),
      cliInvocation.args.indexOf("--project") + 2,
    ),
    ["--project", expected.projectId],
  );
  assert.equal(
    cliInvocation.options.env.PATH.split(":")[0],
    dirname(process.execPath),
  );
  assert.deepEqual(Object.keys(cliInvocation.options.env).sort(), [
    "HOME",
    "NODE_ENV",
    "NO_COLOR",
    "PATH",
    "VERCEL_ORG_ID",
    "VERCEL_PROJECT_ID",
    "VERCEL_TOKEN",
  ]);
  assert.ok(calls.some((url) => url.includes("meta-notaAttestation")));

  await deployOrRecover(
    { ...env, NOTA_PROVIDER_OPERATION: "RECOVER" },
    {
      fetchImpl,
      runCli: async () => {
        throw new Error("recover must not invoke the CLI");
      },
    },
  );
  assert.equal(cliCalls, 1);
});

test("recovery fails closed when provider pagination is not exhaustive", async () => {
  const env = {
    NOTA_PROVIDER_OPERATION: "RECOVER",
    NOTA_HELPER_ROOT: new URL("..", import.meta.url).pathname,
    NOTA_UPLOAD_ROOT: mkdtempSync(join(tmpdir(), "nota-provider-recover-")),
    NOTA_RECOVERY_KEY: expected.recoveryKey,
    VERCEL_PROJECT_ID: expected.projectId,
    VERCEL_ORG_ID: expected.teamId,
    VERCEL_TOKEN: "v".repeat(32),
    RUNNER_TEMP: "/tmp",
  };
  let sequence = 0;
  await assert.rejects(
    deployOrRecover(env, {
      fetchImpl: async () => {
        sequence += 1;
        return new Response(
          JSON.stringify({
            deployments: Array.from({ length: 100 }, (_, index) => ({
              ...deployment(),
              uid: `dpl_${String(sequence * 100 + index).padStart(8, "0")}`,
              meta: {},
            })),
            pagination: { next: sequence },
          }),
          { status: 200 },
        );
      },
    }),
    /PROVIDER_PAGINATION_INCOMPLETE/,
  );
});

test("provider and preflight reject oversized chunked responses before parsing", async () => {
  const providerEnv = {
    NOTA_PROVIDER_OPERATION: "RECOVER",
    NOTA_HELPER_ROOT: new URL("..", import.meta.url).pathname,
    NOTA_UPLOAD_ROOT: mkdtempSync(join(tmpdir(), "nota-provider-bounded-")),
    NOTA_RECOVERY_KEY: expected.recoveryKey,
    VERCEL_PROJECT_ID: expected.projectId,
    VERCEL_ORG_ID: expected.teamId,
    VERCEL_TOKEN: "v".repeat(32),
    RUNNER_TEMP: "/tmp",
  };
  await assert.rejects(
    deployOrRecover(providerEnv, {
      fetchImpl: async () => new Response("x".repeat(70 * 1024)),
    }),
    /PROVIDER_RESPONSE_TOO_LARGE/,
  );
  await assert.rejects(
    preflightVercel(
      {
        VERCEL_PROJECT_ID: expected.projectId,
        VERCEL_ORG_ID: expected.teamId,
        VERCEL_TOKEN: "v".repeat(32),
      },
      async () => new Response("x".repeat(130 * 1024)),
    ),
    /VERCEL_PREFLIGHT_TOO_LARGE/,
  );
});

test("credential-free preflight rejects Git integration, OIDC and preview variables", async () => {
  const env = {
    VERCEL_PROJECT_ID: expected.projectId,
    VERCEL_ORG_ID: expected.teamId,
    VERCEL_TOKEN: "v".repeat(32),
  };
  const response = (value) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const safeFetch = async (url) => {
    const path = String(url);
    if (path.includes("/v10/projects/") && path.includes("/env?")) {
      return response({ envs: [], pagination: {} });
    }
    if (path.includes("/v1/env?"))
      return response({ data: [], pagination: {} });
    if (path.includes("/v2/integrations/configurations?")) return response([]);
    if (path.includes("/v1/storage/stores?")) return response({ stores: [] });
    return response({
      id: expected.projectId,
      accountId: expected.teamId,
      link: null,
      oidcTokenConfig: { enabled: false },
      autoExposeSystemEnvs: false,
    });
  };
  assert.deepEqual(await preflightVercel(env, safeFetch), {
    projectId: expected.projectId,
    teamId: expected.teamId,
    credentialFree: true,
    previewVariables: 0,
    projectIntegrations: 0,
    automationBypass: false,
  });

  for (const projectMutation of [
    { link: { type: "github" } },
    { oidcTokenConfig: { enabled: true } },
    { autoExposeSystemEnvs: true },
    { protectionBypass: { secretId: { scope: "automation-bypass" } } },
    { ssoProtection: { deploymentType: "preview" } },
    { passwordProtection: { deploymentType: "preview" } },
    { deploymentProtection: { enabled: true } },
  ]) {
    await assert.rejects(
      preflightVercel(env, async (url) => {
        const path = String(url);
        if (path.includes("/v10/projects/") && path.includes("/env?")) {
          return response({ envs: [], pagination: {} });
        }
        if (path.includes("/v1/env?"))
          return response({ data: [], pagination: {} });
        if (path.includes("/v2/integrations/configurations?"))
          return response([]);
        if (path.includes("/v1/storage/stores?"))
          return response({ stores: [] });
        return response({
          id: expected.projectId,
          accountId: expected.teamId,
          link: null,
          oidcTokenConfig: { enabled: false },
          autoExposeSystemEnvs: false,
          ...projectMutation,
        });
      }),
    );
  }
  await assert.rejects(
    preflightVercel(env, async (url) => {
      const path = String(url);
      if (path.includes("/v10/projects/") && path.includes("/env?")) {
        return response({
          envs: [{ key: "TOKEN", target: ["preview"] }],
          pagination: {},
        });
      }
      if (path.includes("/v1/env?"))
        return response({ data: [], pagination: {} });
      if (path.includes("/v2/integrations/configurations?"))
        return response([]);
      if (path.includes("/v1/storage/stores?")) return response({ stores: [] });
      return response({
        id: expected.projectId,
        accountId: expected.teamId,
        link: null,
        oidcTokenConfig: { enabled: false },
        autoExposeSystemEnvs: false,
      });
    }),
  );
  await assert.rejects(
    preflightVercel(env, async (url) => {
      const path = String(url);
      if (path.includes("/v10/projects/") && path.includes("/env?")) {
        return response({ envs: [], pagination: {} });
      }
      if (path.includes("/v1/env?"))
        return response({ data: [], pagination: {} });
      if (path.includes("/v2/integrations/configurations?")) {
        return response([{ projects: [expected.projectId] }]);
      }
      if (path.includes("/v1/storage/stores?")) return response({ stores: [] });
      return response({
        id: expected.projectId,
        accountId: expected.teamId,
        link: null,
        oidcTokenConfig: { enabled: false },
        autoExposeSystemEnvs: false,
      });
    }),
    /VERCEL_PROJECT_INTEGRATIONS_PRESENT/,
  );
  await assert.rejects(
    preflightVercel(env, async (url) => {
      const path = String(url);
      if (path.includes("/v10/projects/") && path.includes("/env?")) {
        return response({ envs: [], pagination: {} });
      }
      if (path.includes("/v1/env?"))
        return response({ data: [], pagination: {} });
      if (path.includes("/v2/integrations/configurations?")) {
        return response([{ id: "icfg_full_access", status: "ready" }]);
      }
      if (path.includes("/v1/storage/stores?")) return response({ stores: [] });
      return response({
        id: expected.projectId,
        accountId: expected.teamId,
        link: null,
        oidcTokenConfig: { enabled: false },
        autoExposeSystemEnvs: false,
      });
    }),
    /VERCEL_PROJECT_INTEGRATIONS_PRESENT/,
  );
  await assert.rejects(
    preflightVercel(env, async (url) => {
      const path = String(url);
      if (path.includes("/v10/projects/") && path.includes("/env?")) {
        return response({ envs: [], pagination: {} });
      }
      if (path.includes("/v1/env?"))
        return response({ data: [], pagination: {} });
      if (path.includes("/v2/integrations/configurations?")) {
        return response([{ projects: { project: expected.projectId } }]);
      }
      if (path.includes("/v1/storage/stores?")) return response({ stores: [] });
      return response({
        id: expected.projectId,
        accountId: expected.teamId,
        link: null,
        oidcTokenConfig: { enabled: false },
        autoExposeSystemEnvs: false,
      });
    }),
    /VERCEL_PROJECT_INTEGRATIONS_PRESENT/,
  );
  await assert.doesNotReject(
    preflightVercel(env, async (url) => {
      const path = String(url);
      if (path.includes("/v10/projects/") && path.includes("/env?")) {
        return response({ envs: [], pagination: {} });
      }
      if (path.includes("/v1/env?"))
        return response({ data: [], pagination: {} });
      if (path.includes("/v2/integrations/configurations?")) {
        return response([
          { projects: ["prj_otherproject1"], status: "ready" },
          { status: "uninstalled" },
        ]);
      }
      if (path.includes("/v1/storage/stores?")) return response({ stores: [] });
      return response({
        id: expected.projectId,
        accountId: expected.teamId,
        link: null,
        oidcTokenConfig: { enabled: false },
        autoExposeSystemEnvs: false,
      });
    }),
  );
});
