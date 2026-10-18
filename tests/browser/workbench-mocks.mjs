import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";

// Replace only the OCR dependency chunk. The workbench and router are the real
// production build, and all text/images/credentials below are synthetic.
export async function openWorkbench(page, deferred = []) {
  const manifest = JSON.parse(await readFile(new URL("../../dist/client/.vite/manifest.json", import.meta.url), "utf8"));
  const ocrAsset = manifest["node_modules/@paddleocr/paddleocr-js/dist/index.mjs"].file;
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:4173") return route.abort();
    if (url.pathname === `/${ocrAsset}`) {
      return route.fulfill({ contentType: "text/javascript", body:
        "await window.__workbench.wait('import'); export const PaddleOCR = window.__workbench.PaddleOCR;" });
    }
    return route.continue();
  });
  await page.addInitScript((deferred) => {
    const pending = {};
    const events = [];
    const waits = new Set(deferred);
    const record = (stage, details = {}) => events.push({ stage, ...details });
    const wait = (stage, details = {}) => {
      record(stage, details);
      if (!waits.has(stage)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        (pending[stage] ??= []).push({ resolve, reject });
      });
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
    Object.defineProperty(window, "Translator", { configurable: true, value: {
      async availability() { await wait("availability"); return "available"; },
      async create(options) {
        await wait("chromeCreate");
        options.monitor?.({ addEventListener(_event, callback) {
          window.__workbench.downloadProgress = callback;
        } });
        return {
          async translate(text) { await wait("translate", { text }); return `譯文 ${text}`; },
          destroy() { record("destroy"); },
        };
      },
    } });
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      if (String(input) !== "https://translation.invalid/v1/chat/completions") return nativeFetch(input, options);
      const signal = options?.signal;
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
      return new Response(JSON.stringify({ choices: [{ message: {
        content: JSON.stringify(["合成譯文 1", "合成譯文 2"]),
      } }] }), { headers: { "Content-Type": "application/json" } });
    };
    const nativeBitmap = window.createImageBitmap.bind(window);
    window.createImageBitmap = async (...args) => {
      const bitmap = await nativeBitmap(...args);
      await wait("image");
      return bitmap;
    };
    const nativeObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { record("objectURL"); return nativeObjectURL(blob); };
    window.__workbench = {
      events, wait, PaddleOCR, waits,
      settle(stage, index = 0, fail = false) {
        const entry = pending[stage]?.[index];
        if (!entry) throw new Error(`No pending ${stage} at ${index}`);
        if (fail) entry.reject(new Error(`Synthetic ${stage} failure`));
        else entry.resolve();
      },
    };
    sessionStorage.setItem("panelshift-api-settings", JSON.stringify({
      baseUrl: "https://translation.invalid/v1", apiKey: "synthetic-test-key", model: "synthetic-model",
    }));
  }, deferred);
  await page.goto("/try");
  await expect(page.getByText("已設定 synthetic-model", { exact: true })).toBeVisible();
  await page.evaluate(() => { window.__panelshiftNavigationSentinel = "workbench"; });
}

export async function startOcr(page, engine = "auto") {
  await page.locator(`input[name="engine"][value="${engine}"]`).check();
  await page.getByRole("button", { name: "載入示範頁", exact: true }).click();
  await expect(page.getByRole("button", { name: "開始辨識" })).toBeEnabled();
  await page.getByRole("button", { name: "開始辨識" }).click();
}

export async function count(page, stage) {
  return page.evaluate((stage) => window.__workbench.events.filter((event) => event.stage === stage).length, stage);
}

export async function waitForStage(page, stage, total = 1) {
  await expect.poll(() => count(page, stage)).toBe(total);
}

export async function settle(page, stage, index = 0, fail = false) {
  await page.evaluate(({ stage, index, fail }) => window.__workbench.settle(stage, index, fail), { stage, index, fail });
  // Drain async continuations and React updates without a wall-clock race.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

export async function leaveWorkbench(page) {
  await page.getByRole("link", { name: "返回譯格 Panelshift 首頁", exact: true }).click();
  await expect(page).toHaveURL("/");
  await expect(page.locator(".landing-brand")).toBeVisible();
  expect(await page.evaluate(() => window.__panelshiftNavigationSentinel)).toBe("workbench");
}
