import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("..", import.meta.url).pathname;
const reusableWorkflows = [
  "deploy-vercel-and-attest.yml",
  "preflight.yml",
  "run-static-smoke.yml",
  "run.yml",
];
const helper = "eef67dc5e01dc9e38e8ac015f5628287a6ec7c97";
const sha = /^[0-9a-f]{40}$/;

function text(name) {
  return readFileSync(join(root, ".github", "workflows", name), "utf8");
}

test("all reusable workflows parse and pin every external action", () => {
  for (const name of reusableWorkflows) {
    const source = text(name);
    const workflow = parse(source);
    assert.equal(typeof workflow, "object", name);
    assert.ok(workflow.on?.workflow_call, `${name} is not reusable`);
    assert.deepEqual(workflow.permissions, { contents: "read", "id-token": "write" });
    assert.doesNotMatch(source, /secrets:\s*inherit/);
    assert.doesNotMatch(source, /(?:NOTA_API_KEY|GH_TOKEN|GITHUB_TOKEN|personal.access.token)/i);
    for (const match of source.matchAll(/^\s*uses:\s*([^\s]+)$/gm)) {
      const value = match[1];
      assert.match(value, /@[0-9a-f]{40}$/, `${name}: ${value}`);
    }
  }
});

test("pull requests run the locked public validation suite", () => {
  const source = text("ci.yml");
  const workflow = parse(source);
  assert.equal(typeof workflow, "object");
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.deepEqual(workflow.on?.push?.branches, ["main", "development"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.match(source, /fetch-depth:\s*0/);
  for (const match of source.matchAll(/^\s*uses:\s*([^\s]+)$/gm)) {
    assert.match(match[1], /@[0-9a-f]{40}$/);
  }
  assert.match(source, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(source, /npm test/);
  assert.match(source, /npm audit --omit=dev --audit-level=high/);
  assert.doesNotMatch(source, /secrets\.|id-token:\s*write/);
});

test("Vercel workflow preserves the approved trust and materialization order", () => {
  const source = text("deploy-vercel-and-attest.yml");
  assert.match(source, new RegExp(`ref: ${helper}`));
  assert.match(source, /environment:\n\s+name:.*\n\s+deployment: false/);
  assert.doesNotMatch(source, /pull_request\.head|head\.ref|checkout@v|setup-node@v/);
  assert.equal((source.match(/secrets\.VERCEL_TOKEN/g) ?? []).length, 2);
  const prepare = source.indexOf("Allocate or recover Nota App deployment");
  const checkout = source.indexOf("Check out the server-resolved PR source");
  const marker = source.indexOf("Materialize marker in sanitized upload tree");
  const deploy = source.indexOf("Begin and deploy or recover exact Vercel preview");
  const finalize = source.indexOf("Finalize App-owned deployment proof");
  assert.ok(prepare < checkout && checkout < marker && marker < deploy && deploy < finalize);
  assert.match(source, /cancel-in-progress: false/);
  assert.doesNotMatch(source, /Record provider request start/);
  assert.doesNotMatch(source, /--prod|promote|alias|--env|--build-env/);
});

test("static smoke has no environment, secrets, target input, or proof language", () => {
  const source = text("run-static-smoke.yml");
  assert.doesNotMatch(source, /^\s+environment:/m);
  assert.doesNotMatch(source, /secrets\./);
  assert.doesNotMatch(source, /environment-url|artifact-id|deployment-id/i);
  assert.match(source, /JOIN_STATIC_SMOKE/);
});

test("release manifest matches the public contract and helper lock", () => {
  const manifest = JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8"));
  assert.equal(manifest.helperCommit, helper);
  assert.equal(
    execFileSync("git", ["rev-parse", `${helper}^{tree}`], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    manifest.helperTree,
  );
  const contract = readFileSync(join(root, "contracts", "github-ci-attestation-v1.json"));
  assert.equal(createHash("sha256").update(contract).digest("hex"), manifest.contractSha256);
  const lockBytes = readFileSync(join(root, "package-lock.json"));
  assert.equal(
    createHash("sha256").update(lockBytes).digest("hex"),
    manifest.helperLockSha256,
  );
  assert.match(text("deploy-vercel-and-attest.yml"), new RegExp(manifest.helperLockSha256));
  assert.match(text("preflight.yml"), new RegExp(manifest.helperLockSha256));
  const lock = JSON.parse(lockBytes);
  assert.equal(lock.packages["node_modules/vercel"].version, manifest.vercel.version);
  assert.equal(lock.packages["node_modules/vercel"].integrity, manifest.vercel.integrity);
  for (const name of ["checkout", "setupNode"]) assert.match(manifest.actions[name], sha);
  assert.equal(basename(join(root, "release-manifest.json")), "release-manifest.json");
});

test("public contract uses the exact cross-repository wire names", () => {
  const contract = JSON.parse(
    readFileSync(join(root, "contracts", "github-ci-attestation-v1.json"), "utf8"),
  );
  const definitions = contract.$defs;
  assert.equal(definitions.marker.additionalProperties, false);
  assert.deepEqual(definitions.marker.required, [
    "repository_id",
    "deployment_id",
    "deployed_sha",
    "artifact_id",
  ]);
  assert.ok(definitions.deployment_target_snapshot.required.includes("canonicalUrl"));
  assert.ok(definitions.deployment_target_snapshot.required.includes("markerHash"));
  assert.ok(definitions.static_smoke_target_snapshot.required.includes("credentialFree"));
  assert.equal(definitions.static_smoke_target_policy.properties.allowedHostSuffixes.maxItems, 0);
  assert.equal(definitions.deployment_target_policy.properties.markerPath.const,
    "/.well-known/nota-deployment.json");
});

test("runnable examples pin the immutable workflow release and never inherit secrets", () => {
  const release = "ef9ea95296f04b5c91cd54c084d678a39eb9c0ef";
  for (const name of ["static-smoke.yml", "vercel-preview.yml"]) {
    const source = readFileSync(join(root, "examples", name), "utf8");
    assert.equal(typeof parse(source), "object");
    assert.match(source, new RegExp(`nota-github/.+@${release}`));
    assert.doesNotMatch(source, /secrets:/);
  }
  assert.match(text("deploy-vercel-and-attest.yml"), /pull_request_target|workflow_call/);
});
