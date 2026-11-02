import { readdir, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Vinext 0.x emits assets/; Vinext 1.x uses Next-compatible static media.
export async function pruneOcrWasm(clientDirectory) {
  let foundAssetDirectory = false;
  let removed = 0;
  for (const relative of ["assets/", "_next/static/media/"]) {
    const directory = new URL(relative, clientDirectory);
    let files;
    try {
      files = await readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    foundAssetDirectory = true;
    const bundledOrtWasm = files.filter((file) => /^ort-wasm-.*\.wasm$/.test(file));
    await Promise.all(bundledOrtWasm.map((file) => unlink(new URL(file, directory))));
    removed += bundledOrtWasm.length;
  }
  if (!foundAssetDirectory) {
    throw new Error("No supported client asset directory found; build the site before pruning OCR WASM.");
  }
  return removed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const removed = await pruneOcrWasm(new URL("../dist/client/", import.meta.url));
  if (removed) {
    console.log(
      `Removed ${removed} bundled ONNX Runtime WASM fallback; the browser OCR worker uses the pinned CDN runtime.`,
    );
  }
}
