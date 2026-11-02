// Run the production bundle in its actual Workers runtime, without credentials
// or network access. Keep ASSETS injectable for download contract assertions.
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare, Response as WorkerResponse } from "miniflare";

export async function createTestWorker(assetFetch) {
  const root = new URL("../dist/server/", import.meta.url);
  const config = JSON.parse(await readFile(new URL("wrangler.json", root), "utf8"));
  const paths = await readdir(root, { recursive: true });
  const modulePaths = [config.main, ...paths.filter((p) => p !== config.main && /\.m?js$/.test(p))];
  const modules = await Promise.all(modulePaths.map(async (p) => ({
    type: "ESModule", path: fileURLToPath(new URL(p, root)),
    contents: await readFile(new URL(p, root), "utf8"),
  })));
  return new Miniflare({
    modules,
    modulesRoot: fileURLToPath(root),
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    serviceBindings: {
      ASSETS: async (request) => {
        const response = await assetFetch(request);
        return new WorkerResponse(response.body, { status: response.status, headers: response.headers });
      },
    },
    outboundService: () => new WorkerResponse("External network disabled in tests", { status: 403 }),
  });
}
