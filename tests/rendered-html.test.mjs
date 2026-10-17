import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);
const downloadPath = "/downloads/panelshift-chrome-extension-v0.1.3.zip";
const storeUrl = "https://chromewebstore.google.com/detail/panelshift/dokfdbdcdiocconacblgcjdhipmjagnm";
const staticAssetLimit = 25 * 1024 * 1024;
let workerImportSequence = 0;

// Cloudflare provides this identity stream in production. Node does not, but
// vinext's built worker expects it while rendering responses in this test.
if (typeof globalThis.FixedLengthStream === "undefined") {
  globalThis.FixedLengthStream = class FixedLengthStream {
    constructor() {
      const stream = new TransformStream();
      this.readable = stream.readable;
      this.writable = stream.writable;
    }
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function anchorWithHref(html, href) {
  return [...html.matchAll(/<a\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .find((tag) => tag.includes(`href="${href}"`));
}

function pngDimensions(bytes) {
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

async function invoke(
  pathname,
  {
    method = "GET",
    assetFetch = async () => new Response("Not found", { status: 404 }),
    headers = {},
  } = {},
) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerImportSequence += 1;
  workerUrl.searchParams.set(
    "test",
    `${process.pid}-${Date.now()}-${workerImportSequence}`,
  );
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(new URL(pathname, "http://localhost"), {
      method,
      headers: {
        accept: pathname.endsWith(".zip") ? "application/zip" : "text/html",
        host: "localhost",
        ...headers,
      },
    }),
    { ASSETS: { fetch: assetFetch } },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

async function render(pathname) {
  const response = await invoke(pathname);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  return response.text();
}

test("server-renders the Panelshift landing page with exact product entry points", async () => {
  const html = await render("/");
  assert.match(html, /<html[^>]*lang="zh-Hant"/i);
  assert.match(html, /<title>譯格 Panelshift｜網頁圖片與漫畫即時翻譯<\/title>/i);
  assert.match(html, /譯格/);
  assert.match(html, /PANELSHIFT/);
  assert.ok(anchorWithHref(html, "/try"), "landing page must link to /try");
  assert.ok(anchorWithHref(html, "/privacy"), "landing page must link to /privacy");
  assert.ok(anchorWithHref(html, "/support"), "landing page must link to /support");
  assert.ok(anchorWithHref(html, storeUrl), "landing page must link to the published Chrome Web Store item");
  const downloadAnchor = anchorWithHref(html, downloadPath);
  assert.ok(downloadAnchor, `landing page must link to ${downloadPath}`);
  assert.match(downloadAnchor, /\bdownload(?:=|\s|>)/i);
  assert.match(html, /og-extension\.png/);
  assert.doesNotMatch(html, /放入一張圖片/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("server-renders the existing translator workbench at /try", async () => {
  const html = await render("/try");
  assert.match(html, /譯格/);
  assert.match(html, /PANELSHIFT/);
  assert.match(html, /放入一張圖片/);
  assert.match(html, /PP-OCRv5/);
  assert.match(html, /OpenAI 相容 API/);
  assert.match(html, /Chrome Translator/);
});

test("server-renders public privacy and support pages required by the extension listing", async () => {
  const [privacy, support] = await Promise.all([
    render("/privacy"),
    render("/support"),
  ]);

  assert.match(privacy, /<title>隱私權政策/);
  assert.match(privacy, /chrome\.storage\.local/);
  assert.match(privacy, /Limited Use/);
  assert.match(privacy, /OpenAI 相容 API/);
  assert.match(privacy, /不販售、不追蹤/);
  assert.match(privacy, /解除安裝譯格/);

  assert.match(support, /<title>支援與疑難排解/);
  assert.match(support, /Chrome Translator/);
  assert.match(support, /400/);
  assert.match(support, /401/);
  assert.match(support, /403/);
  assert.match(support, /404/);
  assert.match(support, /408/);
  assert.match(support, /429/);
  assert.match(support, /5xx/);
  assert.match(support, /Network \/ CORS/);
});

test("home navigation keeps all eight accessible anchors across website routes", async () => {
  for (const [pathname, expectedCount, brandClass, label] of [
    ["/", 1, "landing-brand", "譯格 Panelshift 首頁"],
    ["/try", 1, "brand-lockup", "返回譯格 Panelshift 首頁"],
    ["/privacy", 3, "landing-brand", "譯格 Panelshift 首頁"],
    ["/support", 3, "landing-brand", "譯格 Panelshift 首頁"],
  ]) {
    const html = await render(pathname);
    const homeAnchors = [...html.matchAll(/<a\b[^>]*>/gi)]
      .map(([tag]) => tag)
      .filter((tag) => /\bhref="\/"/.test(tag));
    assert.equal(homeAnchors.length, expectedCount, pathname);
    const brand = homeAnchors.find((tag) => tag.includes(`class="${brandClass}"`));
    assert.ok(brand, `${pathname} keeps its styled brand link`);
    assert.ok(brand.includes(`aria-label="${label}"`), pathname);
    for (const tag of homeAnchors) {
      assert.doesNotMatch(tag, /\b(?:target|download)=/, pathname);
    }
  }
});

test("Chrome Web Store artwork has exact required pixel dimensions", async () => {
  const [screenshot, promo] = await Promise.all([
    readFile(new URL("../store-assets/panelshift-screenshot-1-1280x800.png", import.meta.url)),
    readFile(new URL("../store-assets/panelshift-promo-440x280.png", import.meta.url)),
  ]);
  assert.deepEqual(pngDimensions(screenshot), { width: 1280, height: 800 });
  assert.deepEqual(pngDimensions(promo), { width: 440, height: 280 });
});

test("download parts reconstruct the canonical extension archive", async () => {
  const [releaseSource, publicReleaseSource, canonicalArchive, extensionManifestSource] = await Promise.all([
    readFile(new URL("../panelshift-release.json", import.meta.url), "utf8"),
    readFile(new URL("../public/downloads/panelshift-release.json", import.meta.url), "utf8"),
    readFile(new URL("../artifacts/panelshift-chrome-extension.zip", import.meta.url)),
    readFile(new URL("../extension/public/manifest.json", import.meta.url), "utf8"),
  ]);
  const release = JSON.parse(releaseSource);
  const publicRelease = JSON.parse(publicReleaseSource);
  const extensionManifest = JSON.parse(extensionManifestSource);

  assert.deepEqual(publicRelease, release);
  assert.equal(release.schemaVersion, 1);
  assert.equal(release.version, "0.1.3");
  assert.equal(release.version, extensionManifest.version);
  assert.equal(release.downloadPath, downloadPath);
  assert.equal(release.fileName, "panelshift-chrome-extension-v0.1.3.zip");
  assert.equal(release.contentType, "application/zip");
  assert.equal(release.partSize, 20 * 1024 * 1024);
  assert.ok(Array.isArray(release.parts) && release.parts.length > 1);

  const partBuffers = [];
  for (const [index, part] of release.parts.entries()) {
    const suffix = String(index + 1).padStart(3, "0");
    assert.equal(
      part.path,
      `/downloads/parts/${release.fileName}.part-${suffix}`,
    );
    const partUrl = new URL(`../public${part.path}`, import.meta.url);
    const [metadata, bytes] = await Promise.all([stat(partUrl), readFile(partUrl)]);
    assert.ok(
      metadata.size < staticAssetLimit,
      `${part.path} must stay below the 25 MiB static-asset limit`,
    );
    assert.equal(metadata.size, part.size);
    assert.equal(bytes.byteLength, part.size);
    assert.equal(sha256(bytes), part.sha256);
    partBuffers.push(bytes);
  }

  const reconstructed = Buffer.concat(partBuffers);
  const canonicalSha256 = sha256(canonicalArchive);
  assert.equal(reconstructed.byteLength, canonicalArchive.byteLength);
  assert.equal(release.totalSize, canonicalArchive.byteLength);
  assert.equal(release.sha256, canonicalSha256);
  assert.equal(sha256(reconstructed), canonicalSha256);
  assert.equal(Buffer.compare(reconstructed, canonicalArchive), 0);
});

test("download route advertises the canonical archive without reading parts on HEAD", async () => {
  const release = JSON.parse(
    await readFile(new URL("../panelshift-release.json", import.meta.url), "utf8"),
  );
  const requestedAssets = [];
  const response = await invoke(downloadPath, {
    method: "HEAD",
    assetFetch: async (request) => {
      requestedAssets.push(new URL(request.url).pathname);
      return new Response("Unexpected asset read", { status: 500 });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), release.contentType);
  assert.equal(response.headers.get("content-length"), String(release.totalSize));
  assert.equal(response.headers.get("etag"), `"sha256-${release.sha256}"`);
  assert.match(
    response.headers.get("content-disposition") ?? "",
    new RegExp(`^attachment;\\s*filename="${release.fileName}"$`, "i"),
  );
  assert.deepEqual(requestedAssets, []);
  assert.equal((await response.arrayBuffer()).byteLength, 0);
});

test("keeps product metadata, browser processing, and download streaming contracts in source", async () => {
  const [page, tryPage, layout, desk, css, packageJson, workerSource] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/try/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/TranslatorDesk.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /\/try/);
  assert.match(page, /panelshift-chrome-extension-v0\.1\.3\.zip/);
  assert.match(tryPage, /<TranslatorDesk \/>/);
  assert.match(layout, /headers\(\)/);
  assert.match(layout, /\/og-extension\.png/);
  assert.match(desk, /PaddleOCR\.create/);
  assert.match(desk, /ocrVersion:\s*"PP-OCRv5"/);
  assert.match(desk, /worker:\s*mode === "worker"/);
  assert.match(desk, /predict\("compatible"\)/);
  assert.match(desk, /\/ocr-models\/PP-OCRv5_mobile_det_onnx_infer\.tar/);
  assert.match(desk, /\/ocr-models\/PP-OCRv5_mobile_rec_onnx_infer\.tar/);
  assert.match(desk, /textDetectionModelAsset:\s*\{\s*url:\s*detectionModelUrl\s*\}/);
  assert.match(desk, /textRecognitionModelAsset:\s*\{\s*url:\s*recognitionModelUrl\s*\}/);
  assert.match(desk, /disableWasmProxy:\s*true/);
  assert.match(desk, /preserving OCR/);
  assert.match(desk, /onnxruntime-web@1\.27\.0/);
  assert.match(desk, /Translator\.availability/);
  assert.match(desk, /chat\/completions/);
  assert.match(desk, /transform:\s*`scale/);
  assert.match(desk, /writing-mode|is-vertical/);
  assert.match(packageJson, /@paddleocr\/paddleocr-js/);
  assert.match(packageJson, /"onnxruntime-web": "1\.27\.0"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  assert.match(workerSource, /panelshift-release\.json/);
  assert.match(workerSource, /url\.pathname === panelshiftRelease\.downloadPath/);
  assert.match(workerSource, /env\.ASSETS\.fetch/);
  assert.match(workerSource, /streamReleaseParts/);
  assert.match(workerSource, /new ReadableStream/);
  assert.match(workerSource, /new FixedLengthStream\(panelshiftRelease\.totalSize\)/);
  assert.match(workerSource, /\.pipeTo\(fixedLengthStream\.writable\)/);
  assert.match(workerSource, /Content-Disposition/i);
  assert.match(workerSource, /application\/zip|contentType/);

  assert.match(css, /height:\s*100dvh/);
  assert.match(css, /\.job-ticket[\s\S]*?overflow-y:\s*auto/);
  assert.match(css, /--accent:\s*#677a68/i);
  assert.doesNotMatch(css, /(?:repeating-|radial-|linear-)gradient/i);
  assert.doesNotMatch(css, /#e94832|#0e9ea8|#25231f|#191815/i);
  assert.doesNotMatch(desk, /crop-mark|empty-panel|empty-bubble/);

  await assert.rejects(
    access(new URL("app/_sites-preview/SkeletonPreview.tsx", templateRoot)),
  );
  await access(new URL("public/og-extension.png", templateRoot));
});
