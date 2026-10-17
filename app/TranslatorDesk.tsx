"use client";

import Link from "next/link";
import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildTranslationRegions,
  polygonToLocalCss,
  type RawOcrItem,
  type ReadingOrder,
  type SourceLanguage,
  type TranslationRegion,
} from "./lib/manga";

type EngineMode = "auto" | "openai" | "chrome" | "ocr";
type OverlayBackground = "white" | "translucent" | "none";
type WorkspaceTab = "canvas" | "proof" | "settings";

interface LoadedImage {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  name: string;
}

interface ApiSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

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

interface ChromeTranslator {
  translate(text: string): Promise<string>;
  destroy?: () => void;
}

interface ChromeTranslatorStatic {
  availability(options: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<"available" | "downloadable" | "downloading" | "unavailable">;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (monitor: {
      addEventListener(
        type: "downloadprogress",
        callback: (event: { loaded: number }) => void,
      ): void;
    }) => void;
  }): Promise<ChromeTranslator>;
}

const EMPTY_API_SETTINGS: ApiSettings = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-5.6",
};

const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const OCR_WASM_PATH =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
const OCR_DETECTION_MODEL_PATH =
  "/ocr-models/PP-OCRv5_mobile_det_onnx_infer.tar";
const OCR_RECOGNITION_MODEL_PATH =
  "/ocr-models/PP-OCRv5_mobile_rec_onnx_infer.tar";

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function getTranslatorApi() {
  return (window as Window & { Translator?: ChromeTranslatorStatic }).Translator;
}

function getImageElement(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("IMAGE_LOAD_FAILED"));
    image.src = url;
  });
}

async function imageSize(blob: Blob) {
  if ("createImageBitmap" in window) {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = await getImageElement(url);
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function parseTranslationPayload(content: string, regions: TranslationRegion[]) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? content;
  const start = fenced.indexOf("[");
  const end = fenced.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("TRANSLATION_FORMAT");
  const parsed = JSON.parse(fenced.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("TRANSLATION_FORMAT");

  return regions.map((region, index) => {
    const item = parsed[index];
    if (typeof item === "string") return item.trim();
    if (item && typeof item === "object" && "translation" in item) {
      const translation = (item as { translation?: unknown }).translation;
      if (typeof translation === "string") return translation.trim();
    }
    throw new Error("TRANSLATION_FORMAT");
  });
}

async function translateWithCompatibleApi(
  regions: TranslationRegion[],
  settings: ApiSettings,
) {
  if (!settings.apiKey || !settings.model || !settings.baseUrl) {
    throw new Error("API_NOT_CONFIGURED");
  }
  const endpoint = `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const payload = regions.map((region) => ({
    id: region.id,
    sourceLanguage: region.sourceLanguage,
    orientation: region.orientation,
    text: region.sourceText,
  }));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: "system",
          content:
            "You translate English and Japanese manga dialogue into natural Traditional Chinese (Taiwan). Preserve tone, names, sound effects, punctuation, and line-break intent. Return only a JSON array in the same order, where every item is an object with a translation string. Never add explanations.",
        },
        {
          role: "user",
          content: JSON.stringify(payload),
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`API_${response.status}`);
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("TRANSLATION_EMPTY");
  return parseTranslationPayload(content, regions);
}

async function translateWithChrome(
  regions: TranslationRegion[],
  onProgress: (progress: number) => void,
) {
  const Translator = getTranslatorApi();
  if (!Translator) throw new Error("CHROME_TRANSLATOR_UNAVAILABLE");
  const cache = new Map<string, ChromeTranslator>();
  const translations: string[] = [];

  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index];
    const sourceLanguage = region.sourceLanguage;
    let translator = cache.get(sourceLanguage);
    if (!translator) {
      const availability = await Translator.availability({
        sourceLanguage,
        targetLanguage: "zh-Hant",
      });
      if (availability === "unavailable") {
        throw new Error("CHROME_LANGUAGE_UNAVAILABLE");
      }
      translator = await Translator.create({
        sourceLanguage,
        targetLanguage: "zh-Hant",
        monitor(monitor) {
          monitor.addEventListener("downloadprogress", (event) => {
            onProgress(72 + Math.round(event.loaded * 12));
          });
        },
      });
      cache.set(sourceLanguage, translator);
    }
    translations.push(await translator.translate(region.sourceText));
    onProgress(76 + Math.round(((index + 1) / regions.length) * 22));
  }
  return translations;
}

function createDemoPage() {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 1280;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("CANVAS_UNAVAILABLE");

  context.fillStyle = "#f8f5ec";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#171512";
  context.lineWidth = 8;
  context.strokeRect(32, 32, 896, 1216);

  context.fillStyle = "#181714";
  context.fillRect(54, 58, 852, 418);
  context.fillStyle = "#ddd8cd";
  for (let x = 72; x < 890; x += 34) {
    context.fillRect(x, 76, 2, 382);
  }
  context.fillStyle = "#f8f5ec";
  context.beginPath();
  context.ellipse(690, 245, 150, 135, -0.08, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.font = '700 34px "Hiragino Kaku Gothic ProN", sans-serif';
  context.fillStyle = "#171512";
  context.textAlign = "center";
  context.fillText("DON'T LOOK BACK!", 690, 240);
  context.font = '500 24px "Avenir Next", sans-serif';
  context.fillText("Keep moving.", 690, 280);

  context.strokeRect(54, 500, 410, 704);
  context.strokeRect(488, 500, 418, 704);
  context.fillStyle = "#d4cec1";
  context.fillRect(74, 520, 370, 664);
  context.fillStyle = "#201f1c";
  context.fillRect(508, 520, 378, 664);
  context.strokeStyle = "rgba(23,21,18,.28)";
  context.lineWidth = 3;
  for (let y = 540; y < 1170; y += 28) {
    context.beginPath();
    context.moveTo(76, y);
    context.lineTo(442, y - 130);
    context.stroke();
  }

  context.fillStyle = "#f8f5ec";
  context.strokeStyle = "#171512";
  context.lineWidth = 6;
  context.beginPath();
  context.ellipse(278, 740, 126, 170, 0.1, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.font = '600 38px "Hiragino Mincho ProN", serif';
  context.fillStyle = "#171512";
  const japanese = ["何", "か", "聞", "こ", "え", "る", "…"];
  japanese.forEach((character, index) => context.fillText(character, 282, 620 + index * 38));

  context.fillStyle = "#f8f5ec";
  context.beginPath();
  context.ellipse(676, 904, 150, 122, -0.12, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.fillStyle = "#171512";
  context.font = '700 35px "Avenir Next", sans-serif';
  context.fillText("Can you hear it?", 676, 900);
  context.font = '500 25px "Avenir Next", sans-serif';
  context.fillText("It's getting closer.", 676, 940);

  context.font = '700 18px "SFMono-Regular", monospace';
  context.textAlign = "left";
  context.fillText("SAMPLE / 01", 54, 1234);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("DEMO_FAILED"))),
      "image/png",
    );
  });
}

function useAutoFitText(
  text: string,
  orientation: "horizontal" | "vertical",
) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !text) return;
    let low = 5;
    let high = Math.max(12, Math.min(node.clientWidth, node.clientHeight) * 0.7);
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const middle = (low + high) / 2;
      node.style.fontSize = `${middle}px`;
      const fits =
        node.scrollWidth <= node.clientWidth + 1 &&
        node.scrollHeight <= node.clientHeight + 1;
      if (fits) low = middle;
      else high = middle;
    }
    node.style.fontSize = `${Math.max(5, low - 0.5)}px`;
  }, [orientation, text]);
  return ref;
}

function OverlayRegion({
  region,
  selected,
  text,
  showBoxes,
  background,
  keepSource,
  translated,
  onSelect,
}: {
  region: TranslationRegion;
  selected: boolean;
  text: string;
  showBoxes: boolean;
  background: OverlayBackground;
  keepSource: boolean;
  translated: boolean;
  onSelect: () => void;
}) {
  const textRef = useAutoFitText(text, region.orientation);
  const style: CSSProperties = {
    left: `${region.rect.x * 100}%`,
    top: `${region.rect.y * 100}%`,
    width: `${region.rect.width * 100}%`,
    height: `${region.rect.height * 100}%`,
    clipPath: `polygon(${polygonToLocalCss(region)})`,
  };

  return (
    <button
      type="button"
      className={classNames(
        "overlay-region",
        selected && "is-selected",
        showBoxes && "show-box",
        region.score < 0.72 && "is-warning",
        `background-${background}`,
      )}
      style={style}
      onClick={onSelect}
      aria-label={`文字區塊 ${region.id.replace("region-", "")}，${
        region.orientation === "vertical" ? "日文直排" : "橫排"
      }，辨識信心 ${Math.round(region.score * 100)}%，${
        translated ? "已翻譯" : "尚未翻譯"
      }`}
    >
      {keepSource && translated ? (
        <small className="overlay-source" lang={region.sourceLanguage}>
          {region.sourceText}
        </small>
      ) : null}
      <span
        ref={textRef}
        className={classNames(
          "overlay-copy",
          region.orientation === "vertical" && "is-vertical",
        )}
        lang={translated ? "zh-Hant" : region.sourceLanguage}
      >
        {text}
      </span>
      <span className="overlay-number" aria-hidden="true">
        {region.id.replace("region-", "")}
      </span>
      {region.score < 0.72 ? (
        <span className="overlay-warning">待確認</span>
      ) : null}
    </button>
  );
}

function drawHorizontalText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const characters = Array.from(text.replace(/\n+/g, ""));
  let selectedSize = Math.max(10, Math.min(width, height) * 0.3);
  let lines: string[] = [];

  while (selectedSize >= 8) {
    context.font = `700 ${selectedSize}px "Hiragino Mincho ProN", "Songti TC", serif`;
    const nextLines: string[] = [];
    let current = "";
    characters.forEach((character) => {
      const candidate = current + character;
      if (current && context.measureText(candidate).width > width * 0.9) {
        nextLines.push(current);
        current = character;
      } else {
        current = candidate;
      }
    });
    if (current) nextLines.push(current);
    if (nextLines.length * selectedSize * 1.18 <= height * 0.9) {
      lines = nextLines;
      break;
    }
    selectedSize -= 1;
  }

  context.fillStyle = "#171512";
  context.textAlign = "center";
  context.textBaseline = "middle";
  const lineHeight = selectedSize * 1.18;
  const startY = y + height / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, index) => {
    context.fillText(line, x + width / 2, startY + index * lineHeight);
  });
}

function drawVerticalText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const characters = Array.from(text.replace(/[\s\n]+/g, ""));
  let size = Math.max(10, Math.min(width, height) * 0.22);
  while (size >= 8) {
    const rows = Math.max(1, Math.floor((height * 0.88) / (size * 1.05)));
    const columns = Math.ceil(characters.length / rows);
    if (columns * size * 1.08 <= width * 0.9) break;
    size -= 1;
  }
  const rows = Math.max(1, Math.floor((height * 0.88) / (size * 1.05)));
  const columns = Math.ceil(characters.length / rows);
  context.font = `700 ${size}px "Hiragino Mincho ProN", "Songti TC", serif`;
  context.fillStyle = "#171512";
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (let column = 0; column < columns; column += 1) {
    const columnCharacters = characters.slice(column * rows, (column + 1) * rows);
    const centerX = x + width / 2 + ((columns - 1) / 2 - column) * size * 1.08;
    const startY = y + (height - columnCharacters.length * size * 1.05) / 2 + size / 2;
    columnCharacters.forEach((character, row) => {
      context.fillText(character, centerX, startY + row * size * 1.05);
    });
  }
}

export function TranslatorDesk() {
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [regions, setRegions] = useState<TranslationRegion[]>([]);
  const [sourceLanguage, setSourceLanguage] = useState<SourceLanguage>("auto");
  const [readingOrder, setReadingOrder] = useState<ReadingOrder>("auto");
  const [engine, setEngine] = useState<EngineMode>("auto");
  const [overlayBackground, setOverlayBackground] =
    useState<OverlayBackground>("translucent");
  const [showBoxes, setShowBoxes] = useState(true);
  const [keepSource, setKeepSource] = useState(false);
  const [compareMode, setCompareMode] = useState<"translated" | "original">(
    "translated",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState<
    "idle" | "ready" | "processing" | "done" | "error"
  >("idle");
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("等待圖片");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [engineUsed, setEngineUsed] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiSettings, setApiSettings] =
    useState<ApiSettings>(EMPTY_API_SETTINGS);
  const [draftSettings, setDraftSettings] =
    useState<ApiSettings>(EMPTY_API_SETTINGS);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("canvas");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const proofRefs = useRef(new Map<string, HTMLDivElement>());
  const ocrRunners = useRef(new Map<string, OcrRunner>());
  const jobToken = useRef(0);
  const imageUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = sessionStorage.getItem("panelshift-api-settings");
        if (stored) {
          const parsed = JSON.parse(stored) as Partial<ApiSettings>;
          const next = { ...EMPTY_API_SETTINGS, ...parsed };
          setApiSettings(next);
          setDraftSettings(next);
        }
      } catch {
        // A malformed session value should never block the workbench.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const runners = ocrRunners.current;
    return () => {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      runners.forEach((runner) => {
        void runner.dispose?.();
      });
      runners.clear();
    };
  }, []);

  const fitCanvas = useCallback(() => {
    const viewport = canvasViewportRef.current;
    if (!viewport || !image) return;
    const widthScale = Math.max(0.08, (viewport.clientWidth - 52) / image.width);
    const heightScale = Math.max(0.08, (viewport.clientHeight - 52) / image.height);
    setZoom(Math.min(1, widthScale, heightScale));
  }, [image]);

  useEffect(() => {
    if (!image) return;
    const viewport = canvasViewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(fitCanvas);
    observer.observe(viewport);
    const frame = requestAnimationFrame(fitCanvas);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [fitCanvas, image]);

  const loadBlob = useCallback(async (blob: Blob, name: string) => {
    if (!ACCEPTED_TYPES.has(blob.type) || blob.size > MAX_FILE_SIZE) {
      setError("請改用 PNG、JPG 或 WEBP，且檔案不超過 20 MB。");
      setStatus("error");
      return;
    }
    try {
      const size = await imageSize(blob);
      if (!size.width || !size.height) throw new Error("INVALID_IMAGE");
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      const url = URL.createObjectURL(blob);
      imageUrlRef.current = url;
      setImage({ blob, url, ...size, name });
      setRegions([]);
      setSelectedId(null);
      setStatus("ready");
      setProgress(0);
      setStatusText("圖片已置入，可開始辨識");
      setError(null);
      setNotice(null);
      setEngineUsed(null);
      setWorkspaceTab("canvas");
    } catch {
      setError("無法開啟這張圖片。請確認檔案沒有損毀。");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      const imageItem = [...(event.clipboardData?.items ?? [])].find((item) =>
        item.type.startsWith("image/"),
      );
      const file = imageItem?.getAsFile();
      if (file) void loadBlob(file, file.name || "clipboard.png");
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [loadBlob]);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void loadBlob(file, file.name);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void loadBlob(file, file.name);
  };

  const loadDemo = async () => {
    setStatusText("正在準備示範頁");
    const blob = await createDemoPage();
    await loadBlob(blob, "panelshift-sample.png");
  };

  const updateTranslations = useCallback(
    (translations: string[]) => {
      setRegions((current) =>
        current.map((region, index) => ({
          ...region,
          translation: translations[index] ?? region.translation,
        })),
      );
    },
    [],
  );

  const runTranslation = useCallback(
    async (nextRegions: TranslationRegion[], token: number) => {
      if (engine === "ocr") {
        setEngineUsed("僅辨識文字");
        return;
      }
      setStatusText("正在翻譯辨識文字");
      setProgress(76);

      const runChromeFallback = async () => {
        const translations = await translateWithChrome(nextRegions, setProgress);
        if (jobToken.current !== token) return;
        updateTranslations(translations);
        setEngineUsed("Chrome Translator");
      };

      if (engine === "chrome") {
        await runChromeFallback();
        return;
      }

      if (engine === "openai") {
        const translations = await translateWithCompatibleApi(
          nextRegions,
          apiSettings,
        );
        if (jobToken.current !== token) return;
        updateTranslations(translations);
        setEngineUsed("OpenAI 相容 API");
        return;
      }

      if (apiSettings.apiKey && apiSettings.model) {
        try {
          const translations = await translateWithCompatibleApi(
            nextRegions,
            apiSettings,
          );
          if (jobToken.current !== token) return;
          updateTranslations(translations);
          setEngineUsed("OpenAI 相容 API");
          return;
        } catch {
          setNotice("外部翻譯暫時不可用，已改用 Chrome Translator。");
        }
      }
      await runChromeFallback();
    },
    [apiSettings, engine, updateTranslations],
  );

  const runOcr = async () => {
    if (!image) return;
    const token = jobToken.current + 1;
    jobToken.current = token;
    setStatus("processing");
    setError(null);
    setNotice(null);
    setRegions([]);
    setProgress(8);
    setStatusText("正在載入 PP-OCRv5");

    let nextRegions: TranslationRegion[];

    try {
      const modelLanguage = sourceLanguage === "en" ? "en" : "japan";
      const detectionModelUrl = new URL(
        OCR_DETECTION_MODEL_PATH,
        window.location.origin,
      ).href;
      const recognitionModelUrl = new URL(
        OCR_RECOGNITION_MODEL_PATH,
        window.location.origin,
      ).href;
      const getRunner = async (mode: "worker" | "compatible") => {
        const runnerKey = `PP-OCRv5-multilingual-${mode}`;
        let runner = ocrRunners.current.get(runnerKey);
        if (!runner) {
          const { PaddleOCR } = await import("@paddleocr/paddleocr-js");
          runner = (await PaddleOCR.create({
            lang: modelLanguage,
            ocrVersion: "PP-OCRv5",
            worker: mode === "worker",
            textDetectionModelName: "PP-OCRv5_mobile_det",
            textDetectionModelAsset: { url: detectionModelUrl },
            textRecognitionModelName: "PP-OCRv5_mobile_rec",
            textRecognitionModelAsset: { url: recognitionModelUrl },
            textRecognitionBatchSize: mode === "worker" ? 6 : 2,
            ortOptions: {
              backend: "wasm",
              wasmPaths: OCR_WASM_PATH,
              numThreads: 1,
              simd: true,
              disableWasmProxy: true,
            },
          })) as OcrRunner;
          ocrRunners.current.set(runnerKey, runner);
        }
        return { runner, runnerKey };
      };

      const predict = async (mode: "worker" | "compatible") => {
        const { runner, runnerKey } = await getRunner(mode);
        try {
          return await runner.predict(image.blob, {
            textDetBoxThresh: 0.5,
            textRecScoreThresh: 0.35,
          });
        } catch (caught) {
          ocrRunners.current.delete(runnerKey);
          await runner.dispose?.().catch(() => undefined);
          throw caught;
        }
      };

      setProgress(38);
      setStatusText("正在偵測與辨識文字區域");
      let results: Awaited<ReturnType<typeof predict>>;
      try {
        results = await predict("worker");
      } catch (workerError) {
        if (jobToken.current !== token) return;
        console.warn(
          "[Panelshift] PP-OCRv5 Worker failed; retrying in compatibility mode.",
          workerError,
        );
        setProgress(22);
        setStatusText("正在切換 PP-OCRv5 相容模式");
        results = await predict("compatible");
      }

      const [result] = results;
      if (jobToken.current !== token) return;
      setProgress(68);
      setStatusText("整理氣泡與漫畫閱讀順序");
      const rawItems: RawOcrItem[] = (result?.items ?? []).map((item) => ({
        poly: item.poly.map(([x, y]) => [x, y] as const),
        text: item.text,
        score: item.score,
      }));
      nextRegions = buildTranslationRegions(
        rawItems,
        image.width,
        image.height,
        sourceLanguage,
        readingOrder,
      );
      if (!nextRegions.length) {
        setStatus("error");
        setError(
          "這張圖片裡找不到可辨識的文字。可嘗試較清晰的圖片或更換原文語言。",
        );
        setStatusText("找不到文字");
        return;
      }
      setRegions(nextRegions);
      setSelectedId(nextRegions[0].id);
    } catch (caught) {
      if (jobToken.current !== token) return;
      console.error("[Panelshift] PP-OCRv5 failed.", caught);
      setStatus("error");
      setProgress(0);
      setStatusText("辨識未完成");
      setError(
        "PP-OCRv5 無法完成辨識。模型與相容模式都已嘗試，請確認網路後再試一次。",
      );
      return;
    }

    try {
      await runTranslation(nextRegions, token);
      if (jobToken.current !== token) return;
      setProgress(100);
      setStatus("done");
      setStatusText("校樣已就緒");
    } catch (caught) {
      if (jobToken.current !== token) return;
      console.warn("[Panelshift] Translation unavailable; preserving OCR.", caught);
      setStatus("done");
      setProgress(100);
      setStatusText("辨識完成，翻譯待處理");
      setNotice(
        caught instanceof Error &&
          caught.message === "CHROME_TRANSLATOR_UNAVAILABLE"
          ? "這個瀏覽器尚未提供 Chrome Translator API。辨識原文已保留，你可以手動編輯或設定 OpenAI 相容 API。"
          : "翻譯服務暫時不可用。辨識原文已保留，你可以手動編輯或改用其他引擎。",
      );
    }
  };

  const stopProcessing = () => {
    jobToken.current += 1;
    setStatus(image ? "ready" : "idle");
    setProgress(0);
    setStatusText("已停止處理");
  };

  const selectRegion = (id: string) => {
    setSelectedId(id);
    setWorkspaceTab("proof");
    proofRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const updateRegion = (id: string, patch: Partial<TranslationRegion>) => {
    setRegions((current) =>
      current.map((region) => (region.id === id ? { ...region, ...patch } : region)),
    );
  };

  const translateOne = async (region: TranslationRegion) => {
    setStatusText(`正在重譯 ${region.id.replace("region-", "")}`);
    try {
      let translation: string;
      if (engine === "chrome" || engine === "auto") {
        [translation] = await translateWithChrome([region], setProgress);
      } else {
        [translation] = await translateWithCompatibleApi([region], apiSettings);
      }
      updateRegion(region.id, { translation });
      setStatusText("校樣已更新");
      setNotice("這一段譯文已更新。");
    } catch {
      setNotice("這一段目前無法重譯，你仍可直接在校樣欄修改。");
    }
  };

  const saveApiSettings = () => {
    const normalized = {
      ...draftSettings,
      baseUrl: draftSettings.baseUrl.trim().replace(/\/+$/, ""),
      model: draftSettings.model.trim(),
      apiKey: draftSettings.apiKey.trim(),
    };
    setApiSettings(normalized);
    sessionStorage.setItem(
      "panelshift-api-settings",
      JSON.stringify(normalized),
    );
    setSettingsOpen(false);
    setNotice("翻譯引擎設定已保留在這個分頁中。");
  };

  const exportImage = async () => {
    if (!image) return;
    try {
      setStatusText("正在輸出成品");
      const source = await getImageElement(image.url);
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("CANVAS_UNAVAILABLE");
      context.drawImage(source, 0, 0, image.width, image.height);

      regions.forEach((region) => {
        const text = region.translation || region.sourceText;
        if (!text) return;
        const x = region.rect.x * image.width;
        const y = region.rect.y * image.height;
        const width = region.rect.width * image.width;
        const height = region.rect.height * image.height;

        context.save();
        context.beginPath();
        region.polygon.forEach(([pointX, pointY], index) => {
          const canvasX = pointX * image.width;
          const canvasY = pointY * image.height;
          if (index === 0) context.moveTo(canvasX, canvasY);
          else context.lineTo(canvasX, canvasY);
        });
        context.closePath();
        context.clip();
        if (overlayBackground !== "none") {
          context.fillStyle =
            overlayBackground === "white"
              ? "#fffdf7"
              : "rgba(255,253,247,.86)";
          context.fillRect(x, y, width, height);
        }
        if (region.orientation === "vertical") {
          drawVerticalText(context, text, x, y, width, height);
        } else {
          drawHorizontalText(context, text, x, y, width, height);
        }
        context.restore();
      });

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error("EXPORT_FAILED"))),
          "image/png",
        );
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${image.name.replace(/\.[^.]+$/, "")}-translated.png`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice("成品已輸出：譯文與排版已烙印到圖片中。");
      setStatusText("校樣已就緒");
    } catch {
      setNotice("目前無法輸出這張圖片，請稍後再試。");
    }
  };

  const averageScore = regions.length
    ? Math.round(
        (regions.reduce((sum, region) => sum + region.score, 0) /
          regions.length) *
          100,
      )
    : 0;
  const translatedCount = regions.filter((region) => region.translation).length;
  const warningCount = regions.filter((region) => region.score < 0.72).length;
  const currentStep = status === "done" ? 3 : status === "processing" ? 2 : image ? 1 : 0;
  const canvasStageStyle = image
    ? ({
        width: image.width * zoom,
        height: image.height * zoom,
      } satisfies CSSProperties)
    : undefined;
  const artboardStyle = image
    ? ({
        width: image.width,
        height: image.height,
        transform: `scale(${zoom})`,
      } satisfies CSSProperties)
    : undefined;

  const stageLabel = useMemo(() => {
    if (status === "processing") return "處理中";
    if (status === "done") return "校稿";
    return image ? "辨識" : "置入";
  }, [image, status]);

  return (
    <main className="translator-shell">
      <header className="masthead">
        <Link className="brand-lockup" href="/" aria-label="返回譯格 Panelshift 首頁">
          <span className="brand-mark">譯格</span>
          <span className="brand-latin">PANELSHIFT</span>
          <span className="brand-beta">ENGLISH · 日本語 → 繁體中文</span>
        </Link>
        <nav className="process-nav" aria-label="處理階段">
          {["置入", "辨識", "校稿", "輸出"].map((step, index) => (
            <span
              key={step}
              className={classNames(
                "process-step",
                index === currentStep && "is-current",
                index < currentStep && "is-complete",
              )}
            >
              <b>{String(index + 1).padStart(2, "0")}</b> {step}
            </span>
          ))}
        </nav>
        <div className="masthead-actions">
          <span className="privacy-chip">
            <i aria-hidden="true" /> 本機 OCR
          </span>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setDraftSettings(apiSettings);
              setSettingsOpen(true);
            }}
          >
            引擎設定
          </button>
        </div>
      </header>

      <div className="mobile-tabs" role="tablist" aria-label="工作區">
        {([
          ["canvas", "畫布"],
          ["proof", `譯文 ${regions.length ? regions.length : ""}`],
          ["settings", "設定"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={workspaceTab === value}
            className={workspaceTab === value ? "is-active" : undefined}
            onClick={() => setWorkspaceTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="workspace-grid">
        <aside
          className={classNames(
            "job-ticket",
            workspaceTab !== "settings" && "mobile-hidden",
          )}
          aria-label="辨識與翻譯設定"
        >
          <div className="ticket-heading">
            <span>翻譯設定</span>
            <b>{stageLabel}</b>
          </div>

          <section className="ticket-section">
            <h2><span>01</span> 來源</h2>
            <button
              type="button"
              className="compact-upload"
              onClick={() => fileInputRef.current?.click()}
            >
              <span aria-hidden="true">＋</span>
              {image ? "更換圖片" : "選擇圖片"}
            </button>
            <button type="button" className="link-button" onClick={loadDemo}>
              載入示範頁
            </button>
            <p className="field-note">PNG、JPG、WEBP · 最大 20 MB</p>
          </section>

          <section className="ticket-section">
            <h2><span>02</span> 語言與順序</h2>
            <label className="field-label" htmlFor="source-language">原文</label>
            <select
              id="source-language"
              value={sourceLanguage}
              onChange={(event) =>
                setSourceLanguage(event.target.value as SourceLanguage)
              }
            >
              <option value="auto">自動偵測</option>
              <option value="ja">日本語</option>
              <option value="en">English</option>
            </select>
            <div className="target-language">
              <span>譯為</span>
              <b>繁體中文</b>
            </div>
            <label className="field-label" htmlFor="reading-order">閱讀順序</label>
            <select
              id="reading-order"
              value={readingOrder}
              onChange={(event) =>
                setReadingOrder(event.target.value as ReadingOrder)
              }
            >
              <option value="auto">自動</option>
              <option value="rtl">右至左（漫畫）</option>
              <option value="ltr">左至右</option>
            </select>
            <p className="field-note">橫排／直排會依 polygon 比例自動判斷。</p>
          </section>

          <section className="ticket-section">
            <h2><span>03</span> 翻譯引擎</h2>
            <div className="radio-stack">
              {([
                ["auto", "自動 fallback"],
                ["openai", "OpenAI 相容 API"],
                ["chrome", "Chrome Translator"],
                ["ocr", "僅辨識文字"],
              ] as const).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="engine"
                    value={value}
                    checked={engine === value}
                    onChange={() => setEngine(value)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setDraftSettings(apiSettings);
                setSettingsOpen(true);
              }}
            >
              設定端點與金鑰
            </button>
            <p className="field-note">
              {apiSettings.apiKey && apiSettings.model
                ? `已設定 ${apiSettings.model}`
                : "未設定 API 時，會嘗試使用 Chrome Translator。"}
            </p>
          </section>

          <section className="ticket-section">
            <h2><span>04</span> 覆蓋樣式</h2>
            <div className="swatch-options" aria-label="譯文背景">
              {([
                ["white", "白色"],
                ["translucent", "半透明"],
                ["none", "無底色"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={overlayBackground === value ? "is-active" : undefined}
                  onClick={() => setOverlayBackground(value)}
                  aria-pressed={overlayBackground === value}
                >
                  <i className={`swatch-${value}`} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={showBoxes}
                onChange={(event) => setShowBoxes(event.target.checked)}
              />
              <span>顯示偵測框</span>
            </label>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={keepSource}
                onChange={(event) => setKeepSource(event.target.checked)}
              />
              <span>覆蓋層保留原文</span>
            </label>
          </section>

          <div className="ticket-actions">
            {status === "processing" ? (
              <button type="button" className="primary-action stop" onClick={stopProcessing}>
                停止處理
              </button>
            ) : (
              <button
                type="button"
                className="primary-action"
                onClick={runOcr}
                disabled={!image}
              >
                {regions.length ? "重新辨識" : "開始辨識"}
                <span aria-hidden="true">↗</span>
              </button>
            )}
            <p>
              圖片留在此瀏覽器內；使用外部引擎時，只傳送辨識出的文字。
            </p>
          </div>
        </aside>

        <section
          className={classNames(
            "canvas-panel",
            workspaceTab !== "canvas" && "mobile-hidden",
          )}
          aria-label="圖片工作畫布"
        >
          <div
            ref={canvasViewportRef}
            className={classNames("canvas-viewport", isDragging && "is-dragging")}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setIsDragging(false);
              }
            }}
            onDrop={onDrop}
          >
            {image ? (
              <div className="canvas-centering">
                <div className="canvas-stage" style={canvasStageStyle}>
                  <div className="artboard" style={artboardStyle}>
                    {/* Image and overlays intentionally share this transform wrapper. */}
                    {/* Blob URLs are browser-local and cannot use the image optimizer. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={image.url} alt={image.name} draggable={false} />
                    <div
                      className={classNames(
                        "overlay-layer",
                        compareMode === "original" && "showing-original",
                      )}
                    >
                      {regions.map((region) => {
                        const translated = Boolean(region.translation);
                        const text =
                          compareMode === "original"
                            ? region.sourceText
                            : region.translation || region.sourceText;
                        return (
                          <OverlayRegion
                            key={region.id}
                            region={region}
                            selected={selectedId === region.id}
                            text={text}
                            showBoxes={showBoxes}
                            background={
                              compareMode === "original" ? "none" : overlayBackground
                            }
                            keepSource={keepSource && compareMode !== "original"}
                            translated={translated && compareMode !== "original"}
                            onSelect={() => selectRegion(region.id)}
                          />
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="empty-artboard">
                <div className="empty-page" aria-hidden="true">
                  <b>01</b>
                </div>
                <div className="empty-copy">
                  <span className="eyebrow">開始新的翻譯</span>
                  <h1>放入一張圖片，<br />開始翻譯</h1>
                  <p>支援漫畫、掃描頁、遊戲截圖與社群圖片。</p>
                  <button
                    type="button"
                    className="primary-action upload-large"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    選擇圖片 <span aria-hidden="true">＋</span>
                  </button>
                  <button type="button" className="paste-hint" onClick={loadDemo}>
                    載入示範頁，或直接貼上剪貼簿圖片 ⌘V
                  </button>
                </div>
              </div>
            )}
            {isDragging ? (
              <div className="drop-curtain">
                <b>放下這一頁</b>
                <span>圖片會留在你的瀏覽器裡</span>
              </div>
            ) : null}
          </div>

          <div className="processing-strip" aria-live="polite">
            <div className="processing-copy">
              <span className={`status-dot status-${status}`} aria-hidden="true" />
              <div>
                <b>{statusText}</b>
                <span>
                  {status === "processing"
                    ? `${progress}% · ${image?.name ?? ""}`
                    : regions.length
                      ? `${regions.length} 個區塊 · ${translatedCount} 已翻譯${warningCount ? ` · ${warningCount} 待確認` : ""}`
                      : image?.name ?? "PP-OCRv5 · English / 日本語"}
                </span>
              </div>
            </div>
            <div className="progress-track" aria-hidden="true">
              <span style={{ width: `${progress}%` }} />
            </div>
          </div>

          <div className="canvas-toolbar">
            <div className="zoom-controls">
              <button
                type="button"
                onClick={() => setZoom((value) => Math.max(0.08, value - 0.1))}
                aria-label="縮小"
                disabled={!image}
              >−</button>
              <output>{Math.round(zoom * 100)}%</output>
              <button
                type="button"
                onClick={() => setZoom((value) => Math.min(2.5, value + 0.1))}
                aria-label="放大"
                disabled={!image}
              >＋</button>
              <button type="button" onClick={fitCanvas} disabled={!image}>
                符合視窗
              </button>
            </div>
            <div className="compare-toggle" aria-label="畫布內容">
              <button
                type="button"
                className={compareMode === "original" ? "is-active" : undefined}
                onClick={() => setCompareMode("original")}
                aria-pressed={compareMode === "original"}
              >原圖</button>
              <button
                type="button"
                className={compareMode === "translated" ? "is-active" : undefined}
                onClick={() => setCompareMode("translated")}
                aria-pressed={compareMode === "translated"}
              >譯文</button>
            </div>
          </div>
        </section>

        <aside
          className={classNames(
            "proof-panel",
            workspaceTab !== "proof" && "mobile-hidden",
          )}
          aria-label="譯文校樣"
        >
          <div className="proof-heading">
            <div>
              <span>TRANSLATION</span>
              <h2>譯文校樣</h2>
            </div>
            <span className="proof-count">{String(regions.length).padStart(2, "0")}</span>
          </div>

          {regions.length ? (
            <>
              <div className="proof-summary">
                <span>{regions.length} 段文字 · {averageScore}% 平均信心</span>
                {engineUsed ? <b>{engineUsed}</b> : null}
              </div>
              <div className="proof-list">
                {regions.map((region) => (
                  <div
                    key={region.id}
                    ref={(node) => {
                      if (node) proofRefs.current.set(region.id, node);
                      else proofRefs.current.delete(region.id);
                    }}
                    className={classNames(
                      "proof-row",
                      selectedId === region.id && "is-selected",
                      region.score < 0.72 && "is-warning",
                    )}
                    onClick={() => setSelectedId(region.id)}
                  >
                    <div className="proof-row-meta">
                      <b>{region.id.replace("region-", "")}</b>
                      <span>
                        {region.orientation === "vertical" ? "縱排" : "橫排"} · {Math.round(region.score * 100)}%
                      </span>
                      {region.score < 0.72 ? <em>辨識結果待確認</em> : null}
                    </div>
                    <p lang={region.sourceLanguage}>「{region.sourceText}」</p>
                    <textarea
                      aria-label={`區塊 ${region.id.replace("region-", "")} 的繁體中文譯文`}
                      lang="zh-Hant"
                      rows={Math.max(2, region.orientation === "vertical" ? 4 : 2)}
                      value={region.translation}
                      placeholder="輸入繁體中文譯文…"
                      onChange={(event) =>
                        updateRegion(region.id, { translation: event.target.value })
                      }
                      onClick={(event) => event.stopPropagation()}
                    />
                    <div className="proof-row-actions">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedId(region.id);
                          setWorkspaceTab("canvas");
                        }}
                      >定位</button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          updateRegion(region.id, {
                            orientation:
                              region.orientation === "vertical"
                                ? "horizontal"
                                : "vertical",
                          });
                        }}
                      >切換排版</button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void translateOne(region);
                        }}
                      >重譯</button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="proof-footer">
                <button type="button" className="export-button" onClick={exportImage}>
                  匯出圖片 <span aria-hidden="true">↓</span>
                </button>
                <p>PNG · 原始解析度 · DOM 排版將烙印至圖片</p>
              </div>
            </>
          ) : (
            <div className="proof-empty">
              <span aria-hidden="true">校</span>
              <h3>辨識後，譯文會在這裡排成校樣。</h3>
              <p>點選任一區塊可同步定位；修改文字時，畫布覆蓋層會立即更新。</p>
              <ol>
                <li><b>01</b> PP-OCRv5 偵測文字</li>
                <li><b>02</b> 合併氣泡與排序</li>
                <li><b>03</b> 翻譯並貼回畫格</li>
              </ol>
            </div>
          )}
        </aside>
      </div>

      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={onFileChange}
      />

      {(error || notice) && (
        <div
          className={classNames("toast", error ? "toast-error" : "toast-notice")}
          role={error ? "alert" : "status"}
        >
          <span aria-hidden="true">{error ? "!" : "✓"}</span>
          <p>{error || notice}</p>
          <button
            type="button"
            aria-label="關閉訊息"
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
          >×</button>
        </div>
      )}

      {settingsOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event: ReactPointerEvent<HTMLDivElement>) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
              if (event.key === "Escape") setSettingsOpen(false);
            }}
          >
            <div className="modal-heading">
              <span>ENGINE / 03</span>
              <button
                type="button"
                aria-label="關閉引擎設定"
                onClick={() => setSettingsOpen(false)}
              >×</button>
            </div>
            <h2 id="settings-title">OpenAI 相容 API</h2>
            <p>
              端點、模型與金鑰只保留在這個瀏覽器分頁。翻譯時只傳送 OCR 文字，不會傳送圖片。
            </p>
            <label>
              <span>API Base URL</span>
              <input
                type="url"
                value={draftSettings.baseUrl}
                onChange={(event) =>
                  setDraftSettings((current) => ({
                    ...current,
                    baseUrl: event.target.value,
                  }))
                }
                placeholder="https://…/v1"
              />
            </label>
            <label>
              <span>Model</span>
              <input
                type="text"
                value={draftSettings.model}
                onChange={(event) =>
                  setDraftSettings((current) => ({
                    ...current,
                    model: event.target.value,
                  }))
                }
                placeholder="gpt-5.6"
              />
            </label>
            <label>
              <span>API Key</span>
              <input
                type="password"
                value={draftSettings.apiKey}
                onChange={(event) =>
                  setDraftSettings((current) => ({
                    ...current,
                    apiKey: event.target.value,
                  }))
                }
                placeholder="sk-…"
                autoComplete="off"
              />
            </label>
            <div className="modal-note">
              <b>Fallback 規則</b>
              <span>API 連線失敗 → Chrome Translator → 保留 OCR 原文</span>
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => setSettingsOpen(false)}>
                取消
              </button>
              <button type="button" className="primary-action" onClick={saveApiSettings}>
                儲存設定
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
