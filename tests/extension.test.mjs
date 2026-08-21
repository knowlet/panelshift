import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  PickerStartFailure,
  pickerFailureMessage,
} from "../extension/src/picker-errors.mjs";
import {
  CompatibleApiError,
  buildCompatibleApiUrl,
  compatibleApiOriginPattern,
  compatibleApiResponseError,
  describeCompatibleApiError,
  extractModelIds,
} from "../extension/src/compatible-api.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "extension-dist");

async function read(relativePath) {
  return readFile(path.join(outputRoot, relativePath), "utf8");
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else files.push(absolute);
  }
  return files;
}

test("build emits a least-privilege Manifest V3 extension", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.1.3");
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.equal(manifest.background.service_worker, "service-worker.js");
  assert.equal(manifest.icons[128], "icons/icon-128.png");
  assert.deepEqual(manifest.sandbox.pages, ["ocr-sandbox.html"]);
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.ok(!(manifest.host_permissions ?? []).includes("<all_urls>"));
  assert.deepEqual(manifest.host_permissions ?? [], []);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*", "http://*/*"]);
  assert.match(
    manifest.content_security_policy.extension_pages,
    /wasm-unsafe-eval/,
  );
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /(?:^|\s)'unsafe-eval'/);
  assert.match(manifest.content_security_policy.sandbox, /'unsafe-eval'/);
  assert.match(manifest.content_security_policy.sandbox, /connect-src[^;]*\bdata:/);
  assert.doesNotMatch(
    manifest.content_security_policy.sandbox,
    /paddle-model-ecology\.bj\.bcebos\.com/,
  );
  assert.doesNotMatch(manifest.content_security_policy.sandbox, /allow-same-origin/);
});

test("OpenAI-compatible endpoint helpers support secure and local API bases", () => {
  assert.equal(
    buildCompatibleApiUrl("https://api.openai.com/v1/", "/models"),
    "https://api.openai.com/v1/models",
  );
  assert.equal(
    buildCompatibleApiUrl("http://localhost:11434/v1", "models"),
    "http://localhost:11434/v1/models",
  );
  assert.equal(
    compatibleApiOriginPattern("http://localhost:11434/v1"),
    "http://localhost/*",
  );
  assert.throws(
    () => buildCompatibleApiUrl("http://api.example.com/v1", "models"),
    (error) => error instanceof CompatibleApiError && error.code === "base_url_unsafe",
  );
  assert.throws(
    () => buildCompatibleApiUrl("not a url", "models"),
    (error) => error instanceof CompatibleApiError && error.code === "base_url_invalid",
  );
});

test("Models API parser keeps editable model IDs sorted and unique", () => {
  assert.deepEqual(extractModelIds({
    object: "list",
    data: [
      { id: "zeta" },
      { id: "alpha" },
      { id: "alpha" },
      { id: "" },
      { missing: true },
    ],
  }), ["alpha", "zeta"]);
  assert.deepEqual(extractModelIds({ data: [] }), []);
  assert.throws(
    () => extractModelIds({ models: [] }),
    (error) => error instanceof CompatibleApiError && error.code === "models_schema_invalid",
  );
});

test("connection errors provide distinct, safe guidance", async () => {
  const cases = [
    [new CompatibleApiError("base_url_invalid"), "Base URL 格式無效"],
    [new CompatibleApiError("permission_denied"), "未取得 API 網域權限"],
    [new CompatibleApiError("http_error", { status: 401 }), "API Key 缺少或無效（401）"],
    [new CompatibleApiError("http_error", { status: 403 }), "沒有存取權限（403）"],
    [new CompatibleApiError("http_error", { status: 404 }), "找不到 Models API（404）"],
    [new CompatibleApiError("http_error", { status: 429 }), "已達速率或額度限制（429）"],
    [new CompatibleApiError("http_error", { status: 503 }), "服務暫時異常（503）"],
    [new CompatibleApiError("timeout"), "連線逾時"],
    [new CompatibleApiError("invalid_json"), "回應不是有效的 JSON"],
    [new CompatibleApiError("models_schema_invalid"), "模型列表格式不相容"],
    [new TypeError("Failed to fetch"), "無法連線到 API"],
  ];
  for (const [error, title] of cases) {
    assert.equal(describeCompatibleApiError(error, "models").title, title);
  }

  const responseError = await compatibleApiResponseError(new Response(JSON.stringify({
    error: { message: "Request failed for Bearer secret-value and sk-verysecret123" },
  }), { status: 400 }));
  const issue = describeCompatibleApiError(responseError, "models");
  assert.match(issue.detail, /服務訊息/);
  assert.doesNotMatch(issue.detail, /secret-value|sk-verysecret123/);
});

test("side panel defaults to Chrome and reveals API controls only for OpenAI mode", async () => {
  const source = await readFile(path.join(projectRoot, "extension", "src", "SidePanel.tsx"), "utf8");
  assert.match(source, /useState<EngineMode>\("chrome"\)/);
  assert.doesNotMatch(source, /<option value="auto">自動備援<\/option>/);
  assert.doesNotMatch(source, /engine === "auto"/);
  assert.doesNotMatch(source, /外部翻譯暫時不可用，已改用 Chrome Translator/);
  assert.match(source, /\{engine === "openai" && \(/);
  assert.match(source, /buildCompatibleApiUrl\(apiSettings\.baseUrl, "models"\)/);
  assert.match(source, /<datalist id="panelshift-model-options">/);
  assert.match(source, /測試連線並載入模型/);
  assert.match(source, /api-connection-\$\{apiConnection\.tone\}/);
});

test("side panel loads only packaged executable assets", async () => {
  const html = await read("sidepanel.html");
  const sandboxHtml = await read("ocr-sandbox.html");
  assert.doesNotMatch(html, /(?:src|href)=["']https?:/i);
  assert.doesNotMatch(sandboxHtml, /(?:src|href)=["']https?:/i);
  assert.match(html, /assets\/sidepanel-[^"']+\.js/);
  assert.match(html, /assets\/sidepanel-[^"']+\.css/);
  assert.match(sandboxHtml, /assets\/ocr-sandbox-[^"']+\.js/);

  const sidePanelEntry = html.match(/src="\.\/(assets\/sidepanel-[^"]+\.js)"/)?.[1];
  assert.ok(sidePanelEntry);
  const privilegedScripts = [
    ...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+\.js)"/g),
  ].map((match) => match[1]);
  for (const script of privilegedScripts) {
    assert.doesNotMatch(await read(script), /new Function\s*\(/, `${script} must satisfy MV3 CSP`);
  }
  assert.doesNotMatch(await read("service-worker.js"), /new Function\s*\(/);
  assert.doesNotMatch(await read("content-script.js"), /new Function\s*\(/);

  const files = await walk(outputRoot);
  const wasmFiles = files.filter((file) => file.endsWith(".wasm"));
  assert.deepEqual(
    wasmFiles.map((file) => path.relative(outputRoot, file)),
    [path.join("ort", "ort-wasm-simd-threaded.jsep.wasm")],
  );
  await stat(path.join(outputRoot, "ort", "ort-wasm-simd-threaded.jsep.mjs"));
  assert.equal(files.some((file) => /worker-entry-[^/]+\.js$/.test(file)), false);

  const modelExpectations = new Map([
    ["PP-OCRv5_mobile_det_onnx_infer.tar", {
      size: 4_843_520,
      sha256: "781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30",
    }],
    ["PP-OCRv5_mobile_rec_onnx_infer.tar", {
      size: 16_701_440,
      sha256: "f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c",
    }],
  ]);
  for (const [file, expected] of modelExpectations) {
    const bytes = await readFile(path.join(outputRoot, "models", file));
    assert.equal(bytes.byteLength, expected.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256);
  }
});

test("eval-dependent OCR is isolated from privileged extension pages", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  const sandboxHtml = await read("ocr-sandbox.html");
  const sandboxEntry = sandboxHtml.match(/src="\.\/(assets\/ocr-sandbox-[^"]+\.js)"/)?.[1];
  assert.ok(sandboxEntry);
  const source = await read(sandboxEntry);
  assert.match(source, /panelshift-ocr/);
  assert.match(source, /postMessage/);
  assert.match(manifest.content_security_policy.sandbox, /connect-src[^;]*\bdata:/);
  assert.match(source, /panelshift-model:\/\/det/);
  assert.match(source, /panelshift-model:\/\/rec/);
  assert.match(source, /MODEL_REQUEST/);
  assert.match(source, /disableWasmProxy/);
  const sourceEntry = await readFile(
    path.join(projectRoot, "extension", "src", "ocr-sandbox.ts"),
    "utf8",
  );
  assert.match(sourceEntry, /worker: false/);
  assert.match(sourceEntry, /fetch: fetchPackagedModel/);
  assert.doesNotMatch(sourceEntry, /retrying in compatibility mode/);
  const sidePanelSource = await readFile(
    path.join(projectRoot, "extension", "src", "SidePanel.tsx"),
    "utf8",
  );
  assert.match(sidePanelSource, /models\/PP-OCRv5_mobile_det_onnx_infer\.tar/);
  assert.match(sidePanelSource, /models\/PP-OCRv5_mobile_rec_onnx_infer\.tar/);
  assert.match(sidePanelSource, /MODEL_RESPONSE/);
  assert.ok(manifest.sandbox.pages.includes("ocr-sandbox.html"));
});

test("page bridge supports picker, stale-result checks, and responsive overlay", async () => {
  const source = await read("content-script.js");
  assert.match(source, /PANELSHIFT_START_PICKING/);
  assert.match(source, /PANELSHIFT_IMAGE_SELECTED/);
  assert.match(source, /PANELSHIFT_APPLY_OVERLAYS/);
  assert.match(source, /PANELSHIFT_STOP_PICKING/);
  assert.match(source, /PANELSHIFT_PING/);
  assert.match(source, /sendResponse\(startPicking\(\)\)/);
  assert.match(source, /stale_selection/);
  assert.match(source, /stale_overlay/);
  assert.match(source, /objectFit/);
  assert.match(source, /elementsFromPoint/);
  assert.match(source, /PANELSHIFT_MEDIA_CHANGED/);
  assert.match(source, /ResizeObserver/);
  assert.match(source, /writing-mode: vertical-rl/);
  assert.match(source, /attachShadow/);
  assert.match(source, /parsed\.origin === location\.origin/);
  assert.match(source, /credentials: "include"/);
  assert.match(source, /localReadFailed/);
});

test("background worker owns the action gesture and bounded image fetch", async () => {
  const source = await read("service-worker.js");
  assert.match(source, /openPanelOnActionClick: false/);
  assert.doesNotMatch(source, /openPanelOnActionClick: true/);
  assert.match(source, /chrome\.action\.onClicked\.addListener/);
  assert.match(source, /chrome\.sidePanel\.open/);
  assert.match(source, /chrome\.scripting\.executeScript/);
  assert.match(source, /PANELSHIFT_PING/);
  assert.match(source, /MAX_IMAGE_BYTES = 20 \* 1024 \* 1024/);
  assert.match(source, /permission_required/);
  assert.match(source, /credentials: "include"/);
  assert.match(source, /\*\.hath\.network/);
  assert.match(source, /\.then\(sendResponse\)/);
  assert.match(source, /return true/);
});

test("background requests image host access before performing a cross-origin fetch", async () => {
  const source = await read("service-worker.js");
  const order = [];
  let granted = false;
  let messageListener;
  const event = (capture) => ({ addListener(listener) { capture(listener); } });
  const chrome = {
    action: { onClicked: event(() => undefined) },
    permissions: {
      contains: async ({ origins }) => {
        order.push(["permission", origins]);
        return granted;
      },
    },
    runtime: {
      onInstalled: event(() => undefined),
      onStartup: event(() => undefined),
      onMessage: event((listener) => { messageListener = listener; }),
    },
    scripting: { executeScript: async () => undefined },
    sidePanel: {
      setPanelBehavior: async () => undefined,
      open: async () => undefined,
    },
    tabs: { sendMessage: async () => ({ ok: true }) },
  };
  const fetch = async (url, options) => {
    order.push(["fetch", url, options]);
    return {
      ok: true,
      status: 200,
      headers: new Headers({
        "content-length": "4",
        "content-type": "image/jpeg",
      }),
      arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer,
    };
  };

  vm.runInNewContext(source, {
    btoa,
    chrome,
    console: { warn() {} },
    fetch,
    Headers,
    Set,
    TextEncoder,
    URL,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof messageListener, "function");

  const imageUrl = "https://node.example.hath.network:8443/h/token/0012.webp";
  const denied = await new Promise((resolve) => {
    assert.equal(messageListener({ type: "PANELSHIFT_FETCH_IMAGE", url: imageUrl }, {}, resolve), true);
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "permission_required");
  assert.equal(denied.pattern, "https://*.hath.network/*");
  assert.equal(order.length, 1);
  assert.equal(order[0][0], "permission");
  assert.equal(order[0][1][0], "https://*.hath.network/*");

  order.length = 0;
  granted = true;
  const allowed = await new Promise((resolve) => {
    assert.equal(messageListener({ type: "PANELSHIFT_FETCH_IMAGE", url: imageUrl }, {}, resolve), true);
  });
  assert.equal(order[0][0], "permission");
  assert.equal(order[1][0], "fetch");
  assert.equal(order[1][1], imageUrl);
  assert.equal(order[1][2].cache, "force-cache");
  assert.equal(order[1][2].credentials, "include");
  assert.equal(order[1][2].redirect, "follow");
  assert.equal(allowed.ok, true);
  assert.equal(allowed.mime, "image/jpeg");
  assert.equal(allowed.byteLength, 4);
  assert.equal(allowed.dataUrl, "data:image/jpeg;base64,/9j/2Q==");
});

test("action click opens the panel and injects the bridge on the granted tab", async () => {
  const source = await read("service-worker.js");
  const calls = [];
  let actionListener;
  const event = (capture) => ({ addListener(listener) { capture(listener); } });
  const chrome = {
    action: {
      onClicked: event((listener) => { actionListener = listener; }),
    },
    permissions: {
      contains: async () => false,
    },
    runtime: {
      onInstalled: event(() => undefined),
      onStartup: event(() => undefined),
      onMessage: event(() => undefined),
    },
    scripting: {
      executeScript: async (options) => { calls.push(["inject", options]); },
    },
    sidePanel: {
      setPanelBehavior: async (options) => { calls.push(["behavior", options]); },
      open: async (options) => { calls.push(["open", options]); },
    },
    tabs: {
      sendMessage: async (tabId, message) => {
        calls.push(["ping", tabId, message]);
        throw new Error("No receiver");
      },
    },
  };

  vm.runInNewContext(source, {
    chrome,
    console: { warn() {} },
    Set,
    TextEncoder,
    URL,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof actionListener, "function");
  actionListener({ id: 7, windowId: 11, url: "https://example.com/manga" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const behavior = calls.find(([type]) => type === "behavior");
  const open = calls.find(([type]) => type === "open");
  const ping = calls.find(([type]) => type === "ping");
  const injection = calls.find(([type]) => type === "inject");
  assert.equal(behavior?.[1]?.openPanelOnActionClick, false);
  assert.equal(open?.[1]?.windowId, 11);
  assert.equal(ping?.[1], 7);
  assert.equal(ping?.[2]?.type, "PANELSHIFT_PING");
  assert.equal(injection?.[1]?.target?.tabId, 7);
  assert.equal(injection?.[1]?.files?.[0], "content-script.js");
});

test("side panel messages a live bridge before attempting fallback injection", async () => {
  const source = await readFile(path.join(projectRoot, "extension", "src", "SidePanel.tsx"), "utf8");
  const start = source.indexOf("const startPicking = async");
  const message = source.indexOf('type: "PANELSHIFT_START_PICKING"', start);
  const injection = source.indexOf("await chrome.scripting.executeScript", start);
  assert.ok(start >= 0 && message > start && injection > message);
  assert.match(source, /PickerStartFailure\("bridge"/);
  assert.doesNotMatch(source, /restrictedPageMessage/);
});

test("picker failures keep authorization, bridge, and restricted-page guidance distinct", () => {
  assert.equal(
    pickerFailureMessage(
      new PickerStartFailure("inject", new Error("Cannot access contents of the page")),
      undefined,
    ),
    "請在要翻譯的分頁點一次譯格工具列圖示，授權後面板會自動開啟。",
  );
  assert.equal(
    pickerFailureMessage(new PickerStartFailure("bridge", new Error("No receiver")), "https://example.com"),
    "頁面選圖程式沒有回應。若剛重新載入擴充套件，請重新整理網頁，再點一次譯格工具列圖示。",
  );
  assert.equal(
    pickerFailureMessage(new PickerStartFailure("inject", new Error("Unexpected failure")), "https://example.com"),
    "目前網站拒絕啟動選圖；請檢查譯格的「網站存取權」，重新整理頁面後再試一次。",
  );
  assert.equal(
    pickerFailureMessage(new PickerStartFailure("inject"), "https://chromewebstore.google.com/detail/example"),
    "Chrome 線上應用程式商店不允許頁面注入，請切到一般網頁。",
  );
});
