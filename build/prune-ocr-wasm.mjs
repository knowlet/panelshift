import { readdir, unlink } from "node:fs/promises";

const assetsDirectory = new URL("../dist/client/assets/", import.meta.url);
const files = await readdir(assetsDirectory);
const bundledOrtWasm = files.filter((file) => /^ort-wasm-.*\.wasm$/.test(file));

await Promise.all(
  bundledOrtWasm.map((file) => unlink(new URL(file, assetsDirectory))),
);

if (bundledOrtWasm.length) {
  console.log(
    `Removed ${bundledOrtWasm.length} bundled ONNX Runtime WASM fallback; the browser OCR worker uses the pinned CDN runtime.`,
  );
}
