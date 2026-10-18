import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { act, create } from "react-test-renderer";
import ts from "typescript";

// Exercise the actual component, hooks, and cleanup using React's Node renderer.
// Only browser APIs and the OCR provider are mocked. Chromium covers the real
// router/DOM separately in tests/browser/cancellation.spec.mjs.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const componentPath = process.env.WORKBENCH_SOURCE ?? new URL("../app/TranslatorDesk.tsx", import.meta.url);
const componentSource = await readFile(componentPath, "utf8");
const mangaSource = await readFile(new URL("../app/lib/manga.ts", import.meta.url), "utf8");
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function mountWorkbench(t, deferred = []) {
  const events = [];
  const pending = new Map();
  const waits = new Set(deferred);
  const record = (stage, details = {}) => events.push({ stage, ...details });
  const wait = (stage, details = {}) => {
    record(stage, details);
    if (!waits.has(stage)) return Promise.resolve();
    const queue = pending.get(stage) ?? [];
    pending.set(stage, queue);
    return new Promise((resolve, reject) => queue.push({ resolve, reject }));
  };
  const items = [100, 800].map((y, index) => ({
    poly: [[100, y], [350, y], [350, y + 60], [100, y + 60]],
    text: `Synthetic text ${index + 1}`, score: 0.99,
  }));
  let runnerId = 0;
  const PaddleOCR = { async create(options) {
    const id = ++runnerId;
    await wait("create", { id, worker: options.worker });
    return {
      async predict() { await wait("predict", { id }); return [{ items }]; },
      async dispose() { record("dispose", { id }); },
    };
  } };
  const Translator = {
    async availability() { await wait("availability"); return "available"; },
    async create(options) {
      // Deliberately ignore cancellation to exercise late-provider cleanup.
      await wait("chromeCreate", { hasSignal: Boolean(options.signal) });
      options.monitor?.({ addEventListener(_type, callback) { downloadProgress = callback; } });
      return {
        async translate(text, options) {
          await wait("translate", { text, hasSignal: Boolean(options?.signal) });
          return `譯文 ${text}`;
        },
        destroy() { record("destroy"); },
      };
    },
  };
  let downloadProgress;
  const context = vm.createContext({
    console: { warn() {}, error() {} }, URL, Blob, AbortController,
    window: { Translator, setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {},
      location: { origin: "http://workbench.test" }, createImageBitmap: true },
    sessionStorage: { getItem: () => JSON.stringify({
      baseUrl: "https://translation.invalid/v1", apiKey: "synthetic-test-key", model: "synthetic-model",
    }) },
    async createImageBitmap() {
      await wait("image");
      return { width: 960, height: 1280, close() { record("bitmapClose"); } };
    },
    requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} },
    async fetch(endpoint, options) {
      assert.equal(endpoint, "https://translation.invalid/v1/chat/completions");
      const signal = options.signal;
      record("api", { hasSignal: Boolean(signal) });
      let abort;
      const aborted = new Promise((_resolve, reject) => {
        abort = () => { record("apiAbort"); reject(signal.reason); };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
      try {
        await Promise.race([wait("apiResponse"), aborted]);
      } finally {
        signal?.removeEventListener("abort", abort);
      }
      return { ok: true, async json() { return { choices: [{ message: {
        content: JSON.stringify(["合成譯文 1", "合成譯文 2"]),
      } }] }; } };
    },
  });
  // Keep generated URLs synthetic as well, and inspect their ownership.
  context.URL = class extends URL {
    static createObjectURL() { record("objectURL"); return `blob:synthetic-${events.length}`; }
    static revokeObjectURL(url) { record("revoke", { url }); }
  };
  const synthetic = (exports) => new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context });
  const ocrModule = synthetic({ PaddleOCR });
  await ocrModule.link(() => {});
  await ocrModule.evaluate();
  const modules = {
    react: synthetic(React),
    "react/jsx-runtime": synthetic(jsxRuntime),
    "next/link": synthetic({ default: (props) => React.createElement("a", props) }),
    "./lib/manga": new vm.SourceTextModule(compile(mangaSource), { context }),
  };
  const component = new vm.SourceTextModule(compile(componentSource), {
    context,
    async importModuleDynamically(specifier) {
      assert.equal(specifier, "@paddleocr/paddleocr-js");
      await wait("import");
      return ocrModule;
    },
  });
  await component.link((specifier) => {
    assert.ok(modules[specifier], `Unexpected import: ${specifier}`);
    return modules[specifier];
  });
  await component.evaluate();
  let renderer;
  let mounted = true;
  await act(async () => {
    renderer = create(React.createElement(component.namespace.TranslatorDesk), {
      createNodeMock: () => ({ clientWidth: 1000, clientHeight: 800, scrollWidth: 20, scrollHeight: 20, style: {} }),
    });
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  const flush = async (fn = () => {}) => act(async () => { fn(); await tick(); });
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await flush(() => renderer.unmount());
  };
  t.after(unmount);
  const find = (predicate) => renderer.root.findAll(predicate)[0];
  const click = (name) => flush(() => {
    const button = find((node) => node.type === "button" && node.children.some((child) => child === name));
    assert.ok(button, `Missing button: ${name}`);
    void button.props.onClick({ stopPropagation() {} });
  });
  const load = (name = "synthetic.png") => flush(() => {
    const file = Object.assign(new Blob(["synthetic image"], { type: "image/png" }), { name });
    find((node) => node.type === "input" && node.props.type === "file").props.onChange({ target: { files: [file], value: "" } });
  });
  return {
    events, waits, load, click, unmount,
    count: (stage) => events.filter((event) => event.stage === stage).length,
    ids: (stage) => events.filter((event) => event.stage === stage).map((event) => event.id),
    status: () => find((node) => node.props.className === "processing-copy").findByType("b").children.join(""),
    translations: () => renderer.root.findAllByType("textarea").map((node) => node.props.value),
    image: () => find((node) => node.type === "img")?.props.alt,
    async engine(value) {
      await flush(() => find((node) => node.type === "input" && node.props.name === "engine" && node.props.value === value).props.onChange());
    },
    async start(engine = "auto") {
      await this.engine(engine);
      await load();
      await click("開始辨識");
    },
    async settle(stage, index = 0, fail = false) {
      const entry = pending.get(stage)?.[index];
      assert.ok(entry, `Missing pending ${stage} ${index}`);
      await flush(() => fail ? entry.reject(new Error(`Synthetic ${stage} failure`)) : entry.resolve());
    },
    async progress() { await flush(() => downloadProgress?.({ loaded: 1 })); },
  };
}

for (const cancel of ["unmount", "stop"]) {
  const stop = (app) => cancel === "unmount" ? app.unmount() : app.click("停止處理");
  test(`${cancel} during import does not create OCR`, async (t) => {
    const app = await mountWorkbench(t, ["import"]);
    await app.start();
    assert.equal(app.count("import"), 1);
    await stop(app);
    await app.settle("import");
    assert.equal(app.count("create"), 0);
    assert.equal(app.count("api"), 0);
  });
  test(`${cancel} disposes a late OCR runner without predicting`, async (t) => {
    const app = await mountWorkbench(t, ["create"]);
    await app.start();
    assert.equal(app.count("create"), 1);
    await stop(app);
    await app.settle("create");
    assert.equal(app.count("predict"), 0);
    assert.deepEqual(app.ids("dispose"), [1]);
    assert.equal(app.count("api"), 0);
  });
  for (const fail of [false, true]) {
    test(`${cancel} ignores late OCR ${fail ? "rejection" : "success"} without fallback`, async (t) => {
      const app = await mountWorkbench(t, ["predict"]);
      await app.start();
      assert.equal(app.count("predict"), 1);
      await stop(app);
      await app.settle("predict", 0, fail);
      assert.equal(app.count("create"), 1);
      assert.equal(app.count("api"), 0);
      assert.deepEqual(app.ids("dispose"), [1]);
    });
  }
  test(`${cancel} aborts API requests and does not revive Chrome fallback`, async (t) => {
    const app = await mountWorkbench(t, ["apiResponse"]);
    await app.start();
    assert.equal(app.count("api"), 1);
    await stop(app);
    assert.equal(app.count("apiAbort"), 1);
    await app.settle("apiResponse", 0, true);
    assert.equal(app.count("availability"), 0);
    if (cancel === "stop") assert.equal(app.status(), "已停止處理");
  });
  for (const stage of ["availability", "chromeCreate", "translate"]) {
    test(`${cancel} during Chrome ${stage} releases late instances and stops the next region`, async (t) => {
      const app = await mountWorkbench(t, [stage]);
      await app.start("chrome");
      assert.equal(app.count(stage), 1);
      await stop(app);
      await app.settle(stage);
      await app.progress();
      assert.equal(app.count("translate"), stage === "translate" ? 1 : 0);
      assert.equal(app.count("destroy"), stage === "availability" ? 0 : 1);
      if (cancel === "stop") assert.equal(app.status(), "已停止處理");
    });
  }
}

for (const fail of [false, true]) {
  test(`Stop and restart keeps the new runner when the old prediction ${fail ? "rejects" : "resolves"}`, async (t) => {
    const app = await mountWorkbench(t, ["predict"]);
    await app.start();
    await app.click("停止處理");
    await app.click("開始辨識");
    assert.deepEqual(app.ids("predict"), [1, 2]);
    await app.settle("predict", 0, fail);
    assert.deepEqual(app.ids("dispose"), [1]);
    assert.equal(app.status(), "正在偵測與辨識文字區域");
    await app.settle("predict", 1);
    assert.equal(app.status(), "校樣已就緒");
    assert.equal(app.count("api"), 1);
    await app.click("重新辨識");
    assert.deepEqual(app.ids("predict"), [1, 2, 2]);
    await app.settle("predict", 2);
    await app.unmount();
    assert.deepEqual(app.ids("dispose"), [1, 2]);
  });
}

test("a cancelled creation cannot overwrite the newer cached runner", async (t) => {
  const app = await mountWorkbench(t, ["create"]);
  await app.start();
  await app.click("停止處理");
  await app.click("開始辨識");
  await app.settle("create", 1);
  await app.settle("create", 0);
  assert.deepEqual(app.ids("predict"), [2]);
  assert.deepEqual(app.ids("dispose"), [1]);
  await app.click("重新辨識");
  assert.deepEqual(app.ids("predict"), [2, 2]);
  await app.unmount();
  assert.deepEqual(app.ids("dispose"), [1, 2]);
});

test("image loading after unmount creates no object URL", async (t) => {
  const app = await mountWorkbench(t, ["image"]);
  await app.load();
  await app.unmount();
  await app.settle("image");
  assert.equal(app.count("objectURL"), 0);
  assert.equal(app.count("bitmapClose"), 1);
});

test("a newer image wins over an older pending image and cancels translation", async (t) => {
  const app = await mountWorkbench(t, ["apiResponse"]);
  await app.start();
  app.waits.add("image");
  await app.load("older.png");
  assert.equal(app.count("apiAbort"), 1);
  await app.load("newer.png");
  await app.settle("image", 1);
  await app.settle("image", 0);
  await app.settle("apiResponse");
  assert.equal(app.image(), "newer.png");
  assert.equal(app.count("objectURL"), 2);
  assert.equal(app.status(), "圖片已置入，可開始辨識");
  assert.deepEqual(app.translations(), []);
});

test("single-region retranslation is also aborted on unmount", async (t) => {
  const app = await mountWorkbench(t);
  await app.start("openai");
  assert.equal(app.status(), "校樣已就緒");
  app.waits.add("apiResponse");
  await app.click("重譯");
  assert.equal(app.count("api"), 2);
  await app.unmount();
  await app.settle("apiResponse");
  assert.equal(app.count("apiAbort"), 1);
});

test("active provider failures still fall back, and successful Chrome instances are destroyed", async (t) => {
  const app = await mountWorkbench(t, ["predict", "apiResponse"]);
  await app.start();
  await app.settle("predict", 0, true);
  assert.deepEqual(app.events.filter((event) => event.stage === "create").map((event) => event.worker), [true, false]);
  await app.settle("predict", 1);
  await app.settle("apiResponse", 0, true);
  assert.equal(app.count("translate"), 2);
  assert.equal(app.count("destroy"), 1);
  assert.equal(app.status(), "校樣已就緒");
  assert.deepEqual(app.translations(), ["譯文 Synthetic text 1", "譯文 Synthetic text 2"]);
});
