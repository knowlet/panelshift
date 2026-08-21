import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "extension-dist");
const ortOutput = path.join(outputRoot, "ort");
const ortSource = path.join(projectRoot, "node_modules", "onnxruntime-web", "dist");
const artifacts = path.join(projectRoot, "artifacts");
const archivePath = path.join(artifacts, "panelshift-chrome-extension.zip");
const requiredOrtAssets = [
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
];
const requiredModelAssets = [
  {
    file: "PP-OCRv5_mobile_det_onnx_infer.tar",
    size: 4_843_520,
    sha256: "781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30",
  },
  {
    file: "PP-OCRv5_mobile_rec_onnx_infer.tar",
    size: 16_701_440,
    sha256: "f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c",
  },
];

async function walk(directory) {
  const entries = await readdir(directory);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry);
    const metadata = await stat(absolute);
    if (metadata.isDirectory()) files.push(...await walk(absolute));
    else files.push(absolute);
  }
  return files;
}

await build({ configFile: path.join(projectRoot, "vite.config.extension.mjs") });

await mkdir(ortOutput, { recursive: true });
await Promise.all(requiredOrtAssets.map((asset) => (
  copyFile(path.join(ortSource, asset), path.join(ortOutput, asset))
)));

// wasmPaths points ONNX Runtime at /ort/. Worker mode is intentionally off in
// the sandbox, so remove assets emitted only because the dependencies contain
// fallback URL constructors that the bundler follows conservatively.
for (const file of await walk(outputRoot)) {
  if (file.endsWith(".wasm") && path.dirname(file) !== ortOutput) {
    await rm(file);
  }
  if (/worker-entry-[^/]+\.js$/.test(file)) {
    await rm(file);
  }
}

const manifest = JSON.parse(await readFile(path.join(outputRoot, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Extension manifest must use Manifest V3.");
for (const asset of [
  "manifest.json",
  "service-worker.js",
  "content-script.js",
  "sidepanel.html",
  "ocr-sandbox.html",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
  "models/NOTICE.md",
  "models/LICENSE-APACHE-2.0.txt",
  ...requiredOrtAssets.map((file) => `ort/${file}`),
]) {
  await stat(path.join(outputRoot, asset));
}

for (const model of requiredModelAssets) {
  const modelPath = path.join(outputRoot, "models", model.file);
  const metadata = await stat(modelPath);
  if (metadata.size !== model.size) {
    throw new Error(`${model.file} has an unexpected size: ${metadata.size}.`);
  }
  const digest = createHash("sha256").update(await readFile(modelPath)).digest("hex");
  if (digest !== model.sha256) {
    throw new Error(`${model.file} failed SHA-256 verification.`);
  }
}

await mkdir(artifacts, { recursive: true });
await rm(archivePath, { force: true });
const archiveFiles = (await walk(outputRoot))
  .map((file) => path.relative(outputRoot, file))
  .sort((left, right) => left.localeCompare(right, "en"));
const archiveTimestamp = new Date("2026-01-01T00:00:00.000Z");
await Promise.all(
  archiveFiles.map((file) => utimes(
    path.join(outputRoot, file),
    archiveTimestamp,
    archiveTimestamp,
  )),
);
const archive = spawnSync("zip", ["-X", "-q", archivePath, ...archiveFiles], {
  cwd: outputRoot,
  encoding: "utf8",
});
if (archive.status !== 0) {
  throw new Error(`Unable to create extension archive: ${archive.stderr || archive.stdout}`);
}

console.log(`\nPanelshift extension: ${path.relative(projectRoot, outputRoot)}/`);
console.log(`Installable archive: ${path.relative(projectRoot, archivePath)}`);
