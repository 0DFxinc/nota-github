import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const MAX_FILES = 20_000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_PATH_BYTES = 512;
const EXCLUDED = new Set([
  ".git",
  ".vercel",
  "node_modules",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  ".vercelignore",
]);
const MARKER_KEYS = [
  "artifact_id",
  "deployed_sha",
  "deployment_id",
  "repository_id",
];

function fail(message) {
  throw new Error(`nota-stage: ${message}`);
}

function required(name) {
  const value = process.env[name];
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) fail(`${name} is invalid`);
  return value;
}

function safeRelativePath(value, name) {
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    Buffer.byteLength(value) > MAX_PATH_BYTES
  ) {
    fail(`${name} is outside the upload tree`);
  }
  return value;
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function canonicalMarker(bytes, expectedHash) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== expectedHash) fail("marker hash mismatch");
  const text = bytes.toString("utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("marker is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("marker is not an object");
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(MARKER_KEYS)) {
    fail("marker fields do not match the v1 contract");
  }
  if (
    !/^[1-9][0-9]*$/.test(value.repository_id) ||
    !/^[1-9][0-9]*$/.test(value.deployment_id) ||
    !/^[0-9a-f]{40}$/.test(value.deployed_sha) ||
    !/^[A-Za-z0-9._:-]{1,255}$/.test(value.artifact_id)
  ) {
    fail("marker values do not match the v1 contract");
  }
  const canonical = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (!canonical.equals(bytes)) fail("marker bytes are not canonical");
  return bytes;
}

const sourceRoot = realpathSync(required("NOTA_SOURCE_ROOT"));
const projectDirectory = process.env.NOTA_PROJECT_DIRECTORY || ".";
if (projectDirectory !== ".") safeRelativePath(projectDirectory, "project directory");
const projectRoot = realpathSync(resolve(sourceRoot, projectDirectory));
if (!inside(sourceRoot, projectRoot)) fail("project directory escaped source root");
const requestedUploadRoot = resolve(required("NOTA_UPLOAD_ROOT"));
const uploadRoot = join(
  realpathSync(dirname(requestedUploadRoot)),
  basename(requestedUploadRoot),
);
if (inside(sourceRoot, uploadRoot) || inside(uploadRoot, sourceRoot)) {
  fail("upload and source trees must be disjoint");
}
try {
  lstatSync(uploadRoot);
  fail("upload root already exists");
} catch (error) {
  if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
}

const markerPath = safeRelativePath(required("NOTA_MARKER_FILE"), "marker path");
if (markerPath !== "public/.well-known/nota-deployment.json") {
  fail("marker path must be public/.well-known/nota-deployment.json");
}
const markerBytes = canonicalMarker(
  (() => {
    const encoded = required("NOTA_MARKER_BASE64");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      fail("marker base64 is invalid");
    }
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) fail("marker base64 is invalid");
    return decoded;
  })(),
  required("NOTA_MARKER_SHA256"),
);

let files = 0;
let bytes = 0;

function copyTree(source, destination, depth) {
  if (depth > MAX_DEPTH) fail("source tree exceeded maximum depth");
  const before = lstatSync(source, { bigint: true });
  if (before.isSymbolicLink()) fail("source tree contains a symlink");
  if (before.isDirectory()) {
    mkdirSync(destination, { mode: Number(before.mode & 0o777n) || 0o755 });
    const names = readdirSync(source).sort();
    for (const name of names) {
      if (EXCLUDED.has(name)) continue;
      if (/[/\\\u0000-\u001f\u007f]/.test(name)) fail("source name is invalid");
      const childSource = join(source, name);
      const rel = relative(projectRoot, childSource).split(sep).join("/");
      if (rel === markerPath) continue;
      if (Buffer.byteLength(rel) > MAX_PATH_BYTES) fail("source path is too long");
      copyTree(childSource, join(destination, name), depth + 1);
    }
    const after = lstatSync(source, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino) {
      fail("source directory changed during staging");
    }
    return;
  }
  if (!before.isFile() || before.nlink !== 1n) {
    fail("source contains a special or multiply-linked file");
  }
  files += 1;
  bytes += Number(before.size);
  if (files > MAX_FILES || bytes > MAX_BYTES) fail("source tree exceeded limits");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationFd;
  try {
    const opened = fstatSync(sourceFd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      fail("source file changed during staging");
    }
    destinationFd = openSync(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      Number(before.mode & 0o777n) || 0o600,
    );
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let copied = 0;
    while (copied < Number(opened.size)) {
      const count = readSync(sourceFd, chunk, 0, chunk.length, null);
      if (count === 0) fail("source file changed during staging");
      let written = 0;
      while (written < count) {
        written += writeSync(destinationFd, chunk, written, count - written);
      }
      copied += count;
    }
    if (readSync(sourceFd, chunk, 0, 1, null) !== 0) {
      fail("source file grew during staging");
    }
    const after = fstatSync(sourceFd, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      fail("source file changed during staging");
    }
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    closeSync(sourceFd);
  }
}

copyTree(projectRoot, uploadRoot, 0);
if (realpathSync(uploadRoot) !== uploadRoot) fail("upload root is not canonical");
const markerDestination = resolve(uploadRoot, markerPath);
if (!inside(uploadRoot, markerDestination)) fail("marker path escaped upload root");
mkdirSync(dirname(markerDestination), { recursive: true, mode: 0o755 });
writeFileSync(markerDestination, markerBytes, {
  flag: "wx",
  mode: 0o644,
});
writeFileSync(join(uploadRoot, ".vercelignore"), ".git\nnode_modules\n", {
  flag: "wx",
  mode: 0o644,
});
const staged = statSync(markerDestination);
if (!staged.isFile() || staged.size !== markerBytes.length) {
  fail("marker was not materialized");
}
process.stdout.write(JSON.stringify({ files, bytes, markerPath }));
