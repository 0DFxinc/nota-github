import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/stage-upload.mjs", import.meta.url));
const marker = Buffer.from(
  `${JSON.stringify({
    repository_id: "123",
    deployment_id: "456",
    deployed_sha: "0123456789abcdef0123456789abcdef01234567",
    artifact_id: "attestation:test",
  })}\n`,
);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nota-stage-test-"));
  const source = join(root, "source");
  const upload = join(root, "upload");
  mkdirSync(source);
  writeFileSync(join(source, "package.json"), '{"scripts":{"build":"next build"}}\n');
  mkdirSync(join(source, "public"));
  return { root, source, upload };
}

function run(source, upload, overrides = {}) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      NOTA_SOURCE_ROOT: source,
      NOTA_PROJECT_DIRECTORY: ".",
      NOTA_UPLOAD_ROOT: upload,
      NOTA_MARKER_FILE: "public/.well-known/nota-deployment.json",
      NOTA_MARKER_BASE64: marker.toString("base64"),
      NOTA_MARKER_SHA256: createHash("sha256").update(marker).digest("hex"),
      ...overrides,
    },
  });
}

test("stages regular source without executing or preserving hostile controls", () => {
  const { source, upload } = fixture();
  writeFileSync(join(source, ".npmrc"), "//registry.example/:_authToken=do-not-copy\n");
  writeFileSync(join(source, ".vercelignore"), "public/.well-known/**\n");
  mkdirSync(join(source, "node_modules"));
  writeFileSync(join(source, "node_modules", "vercel"), "hostile");
  mkdirSync(join(source, "public", ".well-known"));
  writeFileSync(join(source, "public", ".well-known", "nota-deployment.json"), "fake");

  const result = run(source, upload);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    files: 1,
    bytes: Buffer.byteLength('{"scripts":{"build":"next build"}}\n'),
    markerPath: "public/.well-known/nota-deployment.json",
  });
  assert.deepEqual(
    readFileSync(join(upload, "public", ".well-known", "nota-deployment.json")),
    marker,
  );
  assert.equal(readFileSync(join(upload, ".vercelignore"), "utf8"), ".git\nnode_modules\n");
  assert.throws(() => readFileSync(join(upload, ".npmrc")));
  assert.throws(() => readFileSync(join(upload, "node_modules", "vercel")));
});

test("rejects symlinks and hard links", () => {
  const symlinkFixture = fixture();
  symlinkSync("/etc/passwd", join(symlinkFixture.source, "escape"));
  assert.notEqual(run(symlinkFixture.source, symlinkFixture.upload).status, 0);

  const hardlinkFixture = fixture();
  const original = join(hardlinkFixture.source, "one");
  writeFileSync(original, "same inode");
  linkSync(original, join(hardlinkFixture.source, "two"));
  assert.notEqual(run(hardlinkFixture.source, hardlinkFixture.upload).status, 0);
});

test("rejects marker mismatch, alternate bytes, and an arbitrary marker path", () => {
  const hashFixture = fixture();
  assert.notEqual(
    run(hashFixture.source, hashFixture.upload, { NOTA_MARKER_SHA256: "0".repeat(64) }).status,
    0,
  );

  const alternate = Buffer.from(`${JSON.stringify(JSON.parse(marker), null, 2)}\n`);
  const alternateFixture = fixture();
  assert.notEqual(
    run(alternateFixture.source, alternateFixture.upload, {
      NOTA_MARKER_BASE64: alternate.toString("base64"),
      NOTA_MARKER_SHA256: createHash("sha256").update(alternate).digest("hex"),
    }).status,
    0,
  );

  const pathFixture = fixture();
  assert.notEqual(
    run(pathFixture.source, pathFixture.upload, { NOTA_MARKER_FILE: "public/marker.json" }).status,
    0,
  );
});
