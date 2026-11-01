// Test-only HTTP adapter for the built production worker and its client assets.
// No Cloudflare credentials, deployed service, database, or OCR calls are needed.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestWorker } from "../worker-runtime.mjs";

const assetsRoot = fileURLToPath(new URL("../../dist/client/", import.meta.url));
const mimeTypes = {
  ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".wasm": "application/wasm", ".json": "application/json",
};
const runtime = await createTestWorker(fetchAsset);

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
      response = await runtime.dispatchFetch(request.url, {
        method: request.method, headers: request.headers,
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
  process.on(signal, () => server.close(async () => { await runtime.dispose(); process.exit(0); }));
}
