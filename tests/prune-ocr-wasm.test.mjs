import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { pruneOcrWasm } from "../build/prune-ocr-wasm.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "panelshift-prune-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return pathToFileURL(`${directory}/`);
}

for (const relative of ["assets/", "_next/static/media/"]) {
  test(`prunes only ONNX WASM from ${relative}`, async (t) => {
    const root = await fixture(t);
    const assets = new URL(relative, root);
    await mkdir(assets, { recursive: true });
    const target = new URL("ort-wasm-simd-threaded.jsep.hash.wasm", assets);
    await writeFile(target, "wasm");
    for (const name of ["other.wasm", "ort-wasm-worker.js", "image.png"]) {
      await writeFile(new URL(name, assets), "keep");
    }
    assert.equal(await pruneOcrWasm(root), 1);
    await assert.rejects(access(target), { code: "ENOENT" });
    for (const name of ["other.wasm", "ort-wasm-worker.js", "image.png"]) {
      assert.equal(await readFile(new URL(name, assets), "utf8"), "keep");
    }
    assert.equal(await pruneOcrWasm(root), 0);
  });
}

test("prunes both layouts if both are present", async (t) => {
  const root = await fixture(t);
  for (const relative of ["assets/", "_next/static/media/"]) {
    await mkdir(new URL(relative, root), { recursive: true });
    await writeFile(new URL(`${relative}ort-wasm-test.wasm`, root), "wasm");
  }
  assert.equal(await pruneOcrWasm(root), 2);
});

test("fails if no supported build output exists", async (t) => {
  await assert.rejects(pruneOcrWasm(await fixture(t)), /No supported client asset directory/);
});

test("does not suppress non-ENOENT directory errors", async (t) => {
  const root = await fixture(t);
  await writeFile(new URL("assets", root), "not a directory");
  await assert.rejects(pruneOcrWasm(root), { code: "ENOTDIR" });
});

test("does not suppress removal failures", async (t) => {
  const root = await fixture(t);
  await mkdir(new URL("assets/ort-wasm-directory.wasm/", root), { recursive: true });
  await assert.rejects(pruneOcrWasm(root), { code: "EISDIR" });
});
