/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import panelshiftReleaseJson from "../panelshift-release.json";

interface ReleasePart {
  path: string;
  size: number;
  sha256: string;
}

interface ReleaseManifest {
  schemaVersion: number;
  version: string;
  downloadPath: string;
  fileName: string;
  contentType: string;
  totalSize: number;
  sha256: string;
  partSize: number;
  parts: ReleasePart[];
}

const panelshiftRelease = panelshiftReleaseJson as ReleaseManifest;

declare const FixedLengthStream: {
  new (expectedLength: number): {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
};

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

function releaseEtag(release: ReleaseManifest): string {
  return `"sha256-${release.sha256}"`;
}

function releaseHeaders(release: ReleaseManifest): Headers {
  return new Headers({
    "Accept-Ranges": "none",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Disposition": `attachment; filename="${release.fileName}"`,
    "Content-Length": String(release.totalSize),
    "Content-Type": release.contentType,
    ETag: releaseEtag(release),
    "X-Content-Type-Options": "nosniff",
  });
}

function requestMatchesEtag(request: Request, etag: string): boolean {
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (!ifNoneMatch) return false;

  return ifNoneMatch
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate === etag);
}

function streamReleaseParts(
  request: Request,
  env: Env,
  release: ReleaseManifest,
): ReadableStream<Uint8Array> {
  let partIndex = 0;
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let currentPart: ReleasePart | null = null;
  let currentPartBytes = 0;

  async function cancelCurrentReader(reason?: unknown): Promise<void> {
    if (!currentReader) return;

    try {
      await currentReader.cancel(reason);
    } finally {
      currentReader = null;
      currentPart = null;
      currentPartBytes = 0;
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (!currentReader) {
            if (partIndex >= release.parts.length) {
              controller.close();
              return;
            }

            currentPart = release.parts[partIndex];
            currentPartBytes = 0;
            const assetUrl = new URL(currentPart.path, request.url);
            const assetResponse = await env.ASSETS.fetch(
              new Request(assetUrl, {
                method: "GET",
                headers: { "Accept-Encoding": "identity" },
              }),
            );

            if (!assetResponse.ok || !assetResponse.body) {
              throw new Error(
                `Unable to read download part ${currentPart.path}: ${assetResponse.status}`,
              );
            }

            const assetLengthHeader = assetResponse.headers.get("Content-Length");
            if (assetLengthHeader !== null) {
              const assetLength = Number(assetLengthHeader);
              if (!Number.isFinite(assetLength) || assetLength !== currentPart.size) {
                throw new Error(
                  `Download part ${currentPart.path} has ${assetLengthHeader} bytes; expected ${currentPart.size}`,
                );
              }
            }

            currentReader = assetResponse.body.getReader();
          }

          const reader = currentReader;
          if (!reader) throw new Error("Download part reader was not initialized");

          const result = await reader.read();
          if (result.done) {
            if (!currentPart || currentPartBytes !== currentPart.size) {
              throw new Error(
                `Download part ${currentPart?.path ?? partIndex} ended after ${currentPartBytes} bytes`,
              );
            }

            reader.releaseLock();
            currentReader = null;
            currentPart = null;
            currentPartBytes = 0;
            partIndex += 1;
            continue;
          }

          currentPartBytes += result.value.byteLength;
          if (!currentPart || currentPartBytes > currentPart.size) {
            throw new Error(`Download part ${currentPart?.path ?? partIndex} exceeds its declared size`);
          }

          controller.enqueue(result.value);
          return;
        }
      } catch (error) {
        await cancelCurrentReader(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await cancelCurrentReader(reason);
    },
  });
}

function handleReleaseDownload(request: Request, env: Env): Response {
  const headers = releaseHeaders(panelshiftRelease);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  if (requestMatchesEtag(request, releaseEtag(panelshiftRelease))) {
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  const fixedLengthStream = new FixedLengthStream(panelshiftRelease.totalSize);
  void streamReleaseParts(request, env, panelshiftRelease)
    .pipeTo(fixedLengthStream.writable)
    .catch(() => {
      // pipeTo aborts the fixed-length response stream when an asset read fails.
    });

  return new Response(fixedLengthStream.readable, {
    status: 200,
    headers,
  });
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === panelshiftRelease.downloadPath) {
      return handleReleaseDownload(request, env);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
