// Test-only HTTP adapter for the built production worker and its client assets.
// No Cloudflare credentials, deployed service, database, or OCR calls are needed.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const assetsRoot = fileURLToPath(new URL("../../dist/client/", import.meta.url));
const mimeTypes = {
  ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".wasm": "application/wasm", ".json": "application/json",
};
// Same compatibility shim as the rendered HTML suite. Download streaming is
// covered there; these browser tests only exercise website navigation.
globalThis.FixedLengthStream = class {
  constructor() {
    const stream = new TransformStream();
    this.readable = stream.readable;
    this.writable = stream.writable;
  }
};
const { default: worker } = await import("../../dist/server/index.js");

async function fetchAsset(request) {
  const filename = path.resolve(assetsRoot, `.${decodeURIComponent(new URL(request.url).pathname)}`);
  if (!filename.startsWith(assetsRoot)) return new Response("Not found", { status: 404 });
  try {
    return new Response(await readFile(filename), {
      headers: { "content-type": mimeTypes[path.extname(filename)] || "application/octet-stream" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

const server = http.createServer(async (incoming, outgoing) => {
  try {
    const request = new Request(new URL(incoming.url, "http://127.0.0.1:4173"), {
      method: incoming.method, headers: incoming.headers,
    });
    let response = await fetchAsset(request);
    if (response.status === 404) {
      response = await worker.fetch(request, { ASSETS: { fetch: fetchAsset } }, {
        waitUntil(promise) { promise.catch(console.error); },
        passThroughOnException() {},
      });
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500);
    outgoing.end("Browser test server failed");
  }
});
server.listen(4173, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
