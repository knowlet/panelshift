import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as compatibleApi from "../extension/src/compatible-api.mjs";

// Execute the actual request functions, with only browser I/O and state setters
// replaced. AST extraction keeps these tests independent of React rendering.
const source = await readFile(process.env.PANELSHIFT_SOURCE ?? new URL("../extension/src/SidePanel.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("SidePanel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ["translateWithCompatibleApi", "parseTranslationPayload", "isRecord"].includes(node.name?.text)) {
    declarations.push(node.getText(ast));
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "testApiConnection") {
    declarations.push(`const ${node.getText(ast)};`);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(declarations.length, 4);
const compiled = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function harness(operation, scenario) {
  const timers = new Map();
  const signals = [];
  let nextTimer = 0;
  let now = 0;
  let models = [];
  let connection;
  let releaseBody;
  const settings = { baseUrl: "https://example.invalid/v1", apiKey: "", model: "test-model" };
  const context = vm.createContext({
    ...compatibleApi, URL, DOMException, AbortController,
    apiSettings: settings,
    setAvailableModels(value) { models = value; },
    setApiSettings() {},
    setApiConnection(value) { connection = value; },
    chrome: { permissions: { async request() { return true; } } },
    window: {
      setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    async fetch(_url, { signal }) {
      signals.push(signal);
      const waitForAbort = () => new Promise((_resolve, reject) => {
        if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
        else signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      if (scenario === "headers-stall") return waitForAbort();
      if (scenario === "network-error") throw new TypeError("offline");
      return {
        ok: !scenario.startsWith("http-"), status: 503,
        async json() {
          if (scenario === "delayed-success") await new Promise(resolve => { releaseBody = resolve; });
          if (scenario === "body-stall") return waitForAbort();
          if (scenario === "invalid-json") throw new SyntaxError("invalid JSON");
          return operation === "models" ? { data: [{ id: "test-model" }] }
            : { choices: [{ message: { content: '[{"translation":"譯文"}]' } }] };
        },
        async text() {
          if (scenario === "http-delayed") await new Promise(resolve => { releaseBody = resolve; });
          if (scenario === "http-stall") return waitForAbort();
          if (scenario === "http-invalid") return "<html>unavailable</html>";
          return JSON.stringify({ error: { message: "unavailable" } });
        },
      };
    },
  });
  vm.runInContext(`${compiled}\n globalThis.request = ${operation === "models" ? "testApiConnection" : "() => translateWithCompatibleApi([{ id: '1', sourceText: 'hello' }], apiSettings)"};`, context);
  return {
    timers, signals,
    async release() { releaseBody(); await flush(); },
    get models() { return models; }, get connection() { return connection; },
    async start() {
      const result = { settled: false };
      context.request().then(value => Object.assign(result, { settled: true, value }), error => Object.assign(result, { settled: true, error }));
      await flush();
      return result;
    },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
      await flush();
    },
  };
}

for (const [operation, deadline] of [["translation", 30_000], ["models", 15_000]]) {
  for (const scenario of ["headers-stall", "body-stall", "http-stall"]) {
    test(`${operation}: ${scenario} times out and repeated requests get fresh deadlines`, async () => {
      const h = harness(operation, scenario);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await h.start();
        assert.equal(result.settled, false);
        await h.advance(deadline - 1);
        assert.equal(result.settled, false);
        await h.advance(1);
        assert.equal(result.settled, true, "request must settle at its deadline even after headers arrive");
        if (operation === "translation") assert.equal(result.error?.code, "timeout");
        else {
          assert.equal(h.connection.tone, "error");
          assert.equal(h.connection.title, compatibleApi.describeCompatibleApiError(new compatibleApi.CompatibleApiError("timeout")).title);
          assert.equal(h.models.length, 0);
        }
        assert.equal(h.signals[attempt].aborted, true);
        assert.equal(h.timers.size, 0);
      }
      assert.notEqual(h.signals[0], h.signals[1]);
    });
  }
  for (const scenario of ["delayed-success", "http-delayed"]) {
    test(`${operation}: ${scenario} completes just before its deadline`, async () => {
      const h = harness(operation, scenario);
      const result = await h.start();
      assert.equal(result.settled, false);
      assert.equal(h.timers.size, 1, "deadline must remain active while reading the body");
      await h.advance(deadline - 1);
      await h.release();
      assert.equal(result.settled, true);
      assert.equal(h.timers.size, 0);
      await h.advance(1);
      assert.equal(h.signals[0].aborted, false);
      if (operation === "translation") {
        if (scenario === "delayed-success") assert.equal(result.value[0], "譯文");
        else { assert.equal(result.error.code, "http_error"); assert.equal(result.error.providerMessage, "unavailable"); }
      } else assert.equal(h.connection.tone, scenario === "delayed-success" ? "success" : "error");
    });
  }
  for (const scenario of ["success", "invalid-json", "http-error", "http-invalid", "network-error"]) {
    test(`${operation}: ${scenario} preserves results and clears its timer`, async () => {
      const h = harness(operation, scenario);
      const result = await h.start();
      assert.equal(result.settled, true);
      assert.equal(h.timers.size, 0);
      await h.advance(deadline * 2);
      assert.equal(h.signals[0].aborted, false);
      if (scenario === "success") {
        if (operation === "translation") assert.equal(result.value[0], "譯文");
        else { assert.equal(h.connection.tone, "success"); assert.equal(h.models[0], "test-model"); }
      } else {
        const error = scenario === "network-error" ? new TypeError("offline") : new compatibleApi.CompatibleApiError(scenario === "invalid-json" ? "invalid_json" : "http_error", { status: 503 });
        if (operation === "translation") {
          assert.equal(result.error.code, error.code);
          assert.equal(result.error.name, error.name);
          if (scenario.startsWith("http-")) assert.equal(result.error.status, 503);
        } else assert.equal(h.connection.title, compatibleApi.describeCompatibleApiError(error).title);
      }
    });
  }
}
