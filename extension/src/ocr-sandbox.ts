type OcrModelKey = "det" | "rec";

interface OcrResultItem {
  poly: Array<readonly [number, number]>;
  text: string;
  score: number;
}

interface OcrRunner {
  predict(
    input: Blob,
    params?: { textDetBoxThresh?: number; textRecScoreThresh?: number },
  ): Promise<Array<{ items: OcrResultItem[] }>>;
  dispose?: () => Promise<void>;
}

interface RunMessage {
  channel: "panelshift-ocr";
  type: "RUN";
  requestId: string;
  buffer: ArrayBuffer;
  mime: string;
  modelLanguage: "en" | "japan";
}

interface ModelFetchRequest {
  resolve(response: Response): void;
  reject(error: Error): void;
  timeoutId: number;
}

const CHANNEL = "panelshift-ocr";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MODEL_REQUEST_TIMEOUT_MS = 90_000;
const MODEL_ASSET_URLS: Record<OcrModelKey, string> = {
  det: "panelshift-model://det",
  rec: "panelshift-model://rec",
};
const runners = new Map<string, OcrRunner>();
const modelFetchRequests = new Map<string, ModelFetchRequest>();
let queue = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isRunMessage(value: unknown): value is RunMessage {
  return isRecord(value)
    && value.channel === CHANNEL
    && value.type === "RUN"
    && typeof value.requestId === "string"
    && value.buffer instanceof ArrayBuffer
    && typeof value.mime === "string"
    && (value.modelLanguage === "en" || value.modelLanguage === "japan");
}

function post(message: Record<string, unknown>) {
  window.parent.postMessage({ channel: CHANNEL, ...message }, "*");
}

function progress(requestId: string, phase: string, value: number) {
  post({ type: "PROGRESS", requestId, phase, value });
}

const fetchPackagedModel: typeof fetch = async (input, init) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  const modelKey = (Object.entries(MODEL_ASSET_URLS) as Array<[OcrModelKey, string]>)
    .find(([, assetUrl]) => assetUrl === url)?.[0];
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (!modelKey || method.toUpperCase() !== "GET") {
    throw new Error("OCR_MODEL_REQUEST_INVALID");
  }

  const modelRequestId = crypto.randomUUID();
  return new Promise<Response>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      modelFetchRequests.delete(modelRequestId);
      reject(new Error(`OCR_MODEL_${modelKey.toUpperCase()}_TIMEOUT`));
    }, MODEL_REQUEST_TIMEOUT_MS);
    modelFetchRequests.set(modelRequestId, { resolve, reject, timeoutId });
    post({ type: "MODEL_REQUEST", modelRequestId, modelKey });
  });
};

async function getRunner(
  modelLanguage: "en" | "japan",
  requestId: string,
) {
  const key = `PP-OCRv5-${modelLanguage}-sandbox`;
  let runner = runners.get(key);
  if (!runner) {
    progress(requestId, "loading-packaged-models", 22);
    const { PaddleOCR } = await import("@paddleocr/paddleocr-js");
    runner = (await PaddleOCR.create({
      lang: modelLanguage,
      ocrVersion: "PP-OCRv5",
      worker: false,
      fetch: fetchPackagedModel,
      textDetectionModelName: "PP-OCRv5_mobile_det",
      textDetectionModelAsset: { url: MODEL_ASSET_URLS.det },
      textRecognitionModelName: "PP-OCRv5_mobile_rec",
      textRecognitionModelAsset: { url: MODEL_ASSET_URLS.rec },
      textRecognitionBatchSize: 2,
      ortOptions: {
        backend: "wasm",
        wasmPaths: new URL("./ort/", window.location.href).href,
        numThreads: 1,
        simd: true,
        disableWasmProxy: true,
      },
    })) as OcrRunner;
    runners.set(key, runner);
  }
  return { runner, key };
}

async function predict(
  blob: Blob,
  modelLanguage: "en" | "japan",
  requestId: string,
) {
  const { runner, key } = await getRunner(modelLanguage, requestId);
  try {
    progress(requestId, "recognizing", 46);
    return await runner.predict(blob, {
      textDetBoxThresh: 0.5,
      textRecScoreThresh: 0.35,
    });
  } catch (error) {
    runners.delete(key);
    await runner.dispose?.().catch(() => undefined);
    throw error;
  }
}

async function runOcr(message: RunMessage) {
  if (message.buffer.byteLength === 0 || message.buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("IMAGE_SIZE_INVALID");
  }
  const blob = new Blob([message.buffer], { type: message.mime || "image/png" });
  const results = await predict(blob, message.modelLanguage, message.requestId);
  const items = (results[0]?.items ?? []).map((item) => ({
    poly: item.poly.map(([x, y]) => [x, y]),
    text: item.text,
    score: item.score,
  }));
  post({ type: "RESULT", requestId: message.requestId, items });
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent || !isRecord(event.data) || event.data.channel !== CHANNEL) return;
  if (event.data.type === "PING") {
    post({ type: "READY" });
    return;
  }
  if (event.data.type === "MODEL_RESPONSE" && typeof event.data.modelRequestId === "string") {
    const request = modelFetchRequests.get(event.data.modelRequestId);
    if (!request) return;
    modelFetchRequests.delete(event.data.modelRequestId);
    window.clearTimeout(request.timeoutId);
    if (event.data.ok === true && event.data.buffer instanceof ArrayBuffer) {
      request.resolve(new Response(event.data.buffer, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      }));
    } else {
      request.reject(new Error(
        typeof event.data.message === "string" ? event.data.message : "OCR_MODEL_LOAD_FAILED",
      ));
    }
    return;
  }
  if (!isRunMessage(event.data)) return;
  queue = queue
    .then(() => runOcr(event.data))
    .catch((error: unknown) => {
      post({
        type: "ERROR",
        requestId: event.data.requestId,
        message: error instanceof Error ? error.message : "OCR_SANDBOX_FAILED",
      });
    });
});

post({ type: "READY" });
