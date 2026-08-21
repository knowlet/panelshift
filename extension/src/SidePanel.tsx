import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildTranslationRegions,
  type RawOcrItem,
  type ReadingOrder,
  type SourceLanguage,
  type TranslationRegion,
} from "../../app/lib/manga";
import {
  PickerStartFailure,
  pickerFailureMessage,
} from "./picker-errors.mjs";
import {
  CompatibleApiError,
  buildCompatibleApiHeaders,
  buildCompatibleApiUrl,
  compatibleApiOriginPattern,
  compatibleApiResponseError,
  describeCompatibleApiError,
  extractModelIds,
} from "./compatible-api.mjs";

type EngineMode = "openai" | "chrome" | "ocr";
type OverlayBackground = "white" | "translucent" | "none";
type ApiConnectionTone = "idle" | "testing" | "success" | "warning" | "error";
type PanelStatus =
  | "idle"
  | "selecting"
  | "loading-image"
  | "permission"
  | "ready"
  | "processing"
  | "done"
  | "error";

interface PageImageSelection {
  pageInstanceId: string;
  imageId: string;
  mediaRevision: number;
  url: string;
  dataUrl?: string;
  alt: string;
  naturalWidth: number;
  naturalHeight: number;
  displayWidth: number;
  displayHeight: number;
  hostname: string;
  localReadFailed?: boolean;
}

interface LoadedPageImage {
  selection: PageImageSelection;
  tabId: number;
  blob: Blob;
  dataUrl: string;
  byteLength: number;
}

interface ApiSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface ApiConnectionState {
  tone: ApiConnectionTone;
  title: string;
  detail: string;
}

interface ImagePermissionPrompt {
  origin: string;
  pattern: string;
  message: string;
  selection: PageImageSelection;
  tabId: number;
}

interface FetchImageSuccess {
  ok: true;
  dataUrl: string;
  byteLength: number;
  mime?: string;
}

interface FetchImageFailure {
  ok: false;
  code: string;
  message: string;
  origin?: string;
  pattern?: string;
}

interface OcrResultItem {
  poly: Array<readonly [number, number]>;
  text: string;
  score: number;
}

interface SandboxRequest {
  token: number;
  resolve(items: OcrResultItem[]): void;
  reject(error: Error): void;
}

type OcrModelKey = "det" | "rec";

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

const DEFAULT_API_SETTINGS: ApiSettings = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-5.6",
};

const IDLE_API_CONNECTION: ApiConnectionState = {
  tone: "idle",
  title: "",
  detail: "",
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_OCR_MODEL_BYTES = 32 * 1024 * 1024;
const OCR_MODEL_PATHS: Record<OcrModelKey, string> = {
  det: "models/PP-OCRv5_mobile_det_onnx_infer.tar",
  rec: "models/PP-OCRv5_mobile_rec_onnx_infer.tar",
};
const ocrModelArchiveCache = new Map<OcrModelKey, Promise<ArrayBuffer>>();

function isOcrModelKey(value: unknown): value is OcrModelKey {
  return value === "det" || value === "rec";
}

function loadPackagedOcrModel(modelKey: OcrModelKey) {
  const cached = ocrModelArchiveCache.get(modelKey);
  if (cached) return cached;
  const request = fetch(chrome.runtime.getURL(OCR_MODEL_PATHS[modelKey]), {
    cache: "force-cache",
    credentials: "same-origin",
  }).then(async (response) => {
    if (!response.ok) throw new Error(`OCR_MODEL_${modelKey.toUpperCase()}_${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_OCR_MODEL_BYTES) throw new Error("OCR_MODEL_TOO_LARGE");
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_OCR_MODEL_BYTES) {
      throw new Error("OCR_MODEL_SIZE_INVALID");
    }
    return buffer;
  }).catch((error: unknown) => {
    ocrModelArchiveCache.delete(modelKey);
    throw error;
  });
  ocrModelArchiveCache.set(modelKey, request);
  return request;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isPageImageSelection(value: unknown): value is PageImageSelection {
  if (!isRecord(value)) return false;
  return typeof value.pageInstanceId === "string"
    && typeof value.imageId === "string"
    && typeof value.mediaRevision === "number"
    && typeof value.url === "string"
    && typeof value.naturalWidth === "number"
    && typeof value.naturalHeight === "number";
}

function isOcrResultItem(value: unknown): value is OcrResultItem {
  return isRecord(value)
    && Array.isArray(value.poly)
    && value.poly.every((point) => (
      Array.isArray(point)
      && point.length >= 2
      && typeof point[0] === "number"
      && typeof point[1] === "number"
    ))
    && typeof value.text === "string"
    && typeof value.score === "number";
}

function getTranslatorApi() {
  return (window as Window & { Translator?: ChromeTranslatorStatic }).Translator;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
    if (isRecord(item) && typeof item.translation === "string") {
      return item.translation.trim();
    }
    throw new Error(`TRANSLATION_FORMAT_${region.id}`);
  });
}

async function translateWithCompatibleApi(
  regions: TranslationRegion[],
  settings: ApiSettings,
) {
  if (!settings.model.trim() || !settings.baseUrl.trim()) {
    throw new CompatibleApiError("configuration_missing");
  }
  const endpoint = buildCompatibleApiUrl(settings.baseUrl, "chat/completions");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: buildCompatibleApiHeaders(settings.apiKey, true),
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model.trim(),
        messages: [
          {
            role: "system",
            content:
              "You translate English and Japanese manga dialogue into natural Traditional Chinese (Taiwan). Preserve tone, names, sound effects, punctuation, and line-break intent. Return only a JSON array in the same order, where every item is an object with a translation string. Never add explanations.",
          },
          {
            role: "user",
            content: JSON.stringify(
              regions.map((region) => ({
                id: region.id,
                sourceLanguage: region.sourceLanguage,
                orientation: region.orientation,
                text: region.sourceText,
              })),
            ),
          },
        ],
      }),
    });
  } catch (caught) {
    if (caught instanceof DOMException && caught.name === "AbortError") {
      throw new CompatibleApiError("timeout", { cause: caught });
    }
    throw caught;
  } finally {
    window.clearTimeout(timeout);
  }

  if (!response.ok) throw await compatibleApiResponseError(response);
  let data: { choices?: Array<{ message?: { content?: string } }> };
  try {
    data = (await response.json()) as typeof data;
  } catch (caught) {
    throw new CompatibleApiError("invalid_json", { cause: caught });
  }
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("TRANSLATION_EMPTY");
  return parseTranslationPayload(content, regions);
}

async function translateWithChrome(
  regions: TranslationRegion[],
  onProgress: (value: number) => void,
) {
  const Translator = getTranslatorApi();
  if (!Translator) throw new Error("CHROME_TRANSLATOR_UNAVAILABLE");
  const cache = new Map<string, ChromeTranslator>();
  const translations: string[] = [];

  try {
    for (let index = 0; index < regions.length; index += 1) {
      const region = regions[index];
      let translator = cache.get(region.sourceLanguage);
      if (!translator) {
        const availability = await Translator.availability({
          sourceLanguage: region.sourceLanguage,
          targetLanguage: "zh-Hant",
        });
        if (availability === "unavailable") throw new Error("CHROME_LANGUAGE_UNAVAILABLE");
        translator = await Translator.create({
          sourceLanguage: region.sourceLanguage,
          targetLanguage: "zh-Hant",
          monitor(monitor) {
            monitor.addEventListener("downloadprogress", (event) => {
              onProgress(74 + Math.round(event.loaded * 12));
            });
          },
        });
        cache.set(region.sourceLanguage, translator);
      }
      translations.push(await translator.translate(region.sourceText));
      onProgress(78 + Math.round(((index + 1) / regions.length) * 20));
    }
    return translations;
  } finally {
    cache.forEach((translator) => translator.destroy?.());
  }
}

function applyTranslations(regions: TranslationRegion[], translations: string[]) {
  return regions.map((region, index) => ({
    ...region,
    translation: translations[index] || region.translation,
  }));
}

export function SidePanel() {
  const [status, setStatus] = useState<PanelStatus>("idle");
  const [statusText, setStatusText] = useState("等待選取圖片");
  const [progress, setProgress] = useState(0);
  const [loadedImage, setLoadedImage] = useState<LoadedPageImage | null>(null);
  const [permissionPrompt, setPermissionPrompt] = useState<ImagePermissionPrompt | null>(null);
  const [sourceLanguage, setSourceLanguage] = useState<SourceLanguage>("auto");
  const [readingOrder, setReadingOrder] = useState<ReadingOrder>("auto");
  const [engine, setEngine] = useState<EngineMode>("chrome");
  const [background, setBackground] = useState<OverlayBackground>("translucent");
  const [regions, setRegions] = useState<TranslationRegion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [engineUsed, setEngineUsed] = useState<string | null>(null);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [apiSettings, setApiSettings] = useState<ApiSettings>(DEFAULT_API_SETTINGS);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [apiConnection, setApiConnection] = useState<ApiConnectionState>(IDLE_API_CONNECTION);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [sandboxEpoch, setSandboxEpoch] = useState(0);
  const [pickerSession, setPickerSession] = useState<{
    tabId: number;
    pageInstanceId: string;
  } | null>(null);
  const pickerSessionRef = useRef<typeof pickerSession>(null);
  const ocrFrame = useRef<HTMLIFrameElement>(null);
  const sandboxReady = useRef(false);
  const sandboxReadyPromise = useRef<Promise<void> | null>(null);
  const resolveSandboxReady = useRef<(() => void) | null>(null);
  const sandboxRequests = useRef(new Map<string, SandboxRequest>());
  const jobToken = useRef(0);
  const jobId = useRef(crypto.randomUUID());
  const overlayRevision = useRef(0);
  const selectionToken = useRef(0);

  useEffect(() => {
    let active = true;
    void chrome.storage.local.get("panelshiftApiSettings").then((stored) => {
      if (!active || !isRecord(stored.panelshiftApiSettings)) return;
      const settings = stored.panelshiftApiSettings;
      setApiSettings({
        baseUrl: typeof settings.baseUrl === "string" ? settings.baseUrl : DEFAULT_API_SETTINGS.baseUrl,
        apiKey: typeof settings.apiKey === "string" ? settings.apiKey : "",
        model: typeof settings.model === "string" ? settings.model : "",
      });
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const refreshActiveTab = () => chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      setActiveTabId(tab?.id ?? null);
    });
    const onActivated = () => void refreshActiveTab();
    void refreshActiveTab();
    chrome.tabs.onActivated.addListener(onActivated);
    return () => chrome.tabs.onActivated.removeListener(onActivated);
  }, []);

  const pingSandbox = useCallback(() => {
    ocrFrame.current?.contentWindow?.postMessage({
      channel: "panelshift-ocr",
      type: "PING",
    }, "*");
  }, []);

  const waitForSandbox = useCallback(() => {
    if (sandboxReady.current) return Promise.resolve();
    if (!sandboxReadyPromise.current) {
      sandboxReadyPromise.current = new Promise<void>((resolve) => {
        resolveSandboxReady.current = resolve;
      });
    }
    pingSandbox();
    return Promise.race([
      sandboxReadyPromise.current,
      new Promise<void>((_resolve, reject) => {
        window.setTimeout(() => reject(new Error("OCR_SANDBOX_TIMEOUT")), 8000);
      }),
    ]);
  }, [pingSandbox]);

  useEffect(() => {
    const requests = sandboxRequests.current;
    const onSandboxMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== ocrFrame.current?.contentWindow || !isRecord(event.data)) return;
      if (event.data.channel !== "panelshift-ocr") return;
      if (event.data.type === "READY") {
        sandboxReady.current = true;
        resolveSandboxReady.current?.();
        resolveSandboxReady.current = null;
        sandboxReadyPromise.current = null;
        return;
      }
      if (
        event.data.type === "MODEL_REQUEST"
        && typeof event.data.modelRequestId === "string"
        && isOcrModelKey(event.data.modelKey)
      ) {
        const target = ocrFrame.current?.contentWindow;
        if (!target) return;
        const { modelRequestId, modelKey } = event.data;
        void loadPackagedOcrModel(modelKey)
          .then((cachedBuffer) => {
            const buffer = cachedBuffer.slice(0);
            target.postMessage({
              channel: "panelshift-ocr",
              type: "MODEL_RESPONSE",
              modelRequestId,
              modelKey,
              ok: true,
              buffer,
            }, "*", [buffer]);
          })
          .catch((caught: unknown) => {
            target.postMessage({
              channel: "panelshift-ocr",
              type: "MODEL_RESPONSE",
              modelRequestId,
              modelKey,
              ok: false,
              message: caught instanceof Error ? caught.message : "OCR_MODEL_LOAD_FAILED",
            }, "*");
          });
        return;
      }
      if (typeof event.data.requestId !== "string") return;
      const request = requests.get(event.data.requestId);
      if (!request) return;
      if (event.data.type === "PROGRESS") {
        if (jobToken.current !== request.token) return;
        if (typeof event.data.value === "number") setProgress(event.data.value);
        if (event.data.phase === "loading-packaged-models") {
          setStatusText("正在載入內建 PP-OCRv5 模型");
        } else if (event.data.phase === "recognizing") {
          setStatusText("正在偵測與辨識文字區域");
        }
        return;
      }
      requests.delete(event.data.requestId);
      if (event.data.type === "RESULT" && Array.isArray(event.data.items)) {
        const items = event.data.items.filter(isOcrResultItem);
        if (items.length !== event.data.items.length) {
          request.reject(new Error("OCR_SANDBOX_RESULT_INVALID"));
        } else {
          request.resolve(items);
        }
        return;
      }
      request.reject(new Error(
        typeof event.data.message === "string" ? event.data.message : "OCR_SANDBOX_FAILED",
      ));
    };
    window.addEventListener("message", onSandboxMessage);
    return () => {
      window.removeEventListener("message", onSandboxMessage);
      requests.forEach((request) => request.reject(new Error("OCR_SANDBOX_CLOSED")));
      requests.clear();
    };
  }, []);

  const runSandboxOcr = useCallback(async (
    blob: Blob,
    modelLanguage: "en" | "japan",
    token: number,
  ) => {
    await waitForSandbox();
    if (jobToken.current !== token) throw new Error("OCR_CANCELLED");
    const buffer = await blob.arrayBuffer();
    if (jobToken.current !== token) throw new Error("OCR_CANCELLED");
    const requestId = crypto.randomUUID();
    return new Promise<OcrResultItem[]>((resolve, reject) => {
      const target = ocrFrame.current?.contentWindow;
      if (!target) {
        reject(new Error("OCR_SANDBOX_UNAVAILABLE"));
        return;
      }
      sandboxRequests.current.set(requestId, { token, resolve, reject });
      target.postMessage({
        channel: "panelshift-ocr",
        type: "RUN",
        requestId,
        buffer,
        mime: blob.type || "image/png",
        modelLanguage,
      }, "*", [buffer]);
    });
  }, [waitForSandbox]);

  const restartSandbox = useCallback((reason: string) => {
    sandboxReady.current = false;
    sandboxReadyPromise.current = null;
    resolveSandboxReady.current = null;
    sandboxRequests.current.forEach((request) => request.reject(new Error(reason)));
    sandboxRequests.current.clear();
    setSandboxEpoch((current) => current + 1);
  }, []);

  const loadSelection = useCallback(async (selection: PageImageSelection, tabId?: number) => {
    const token = selectionToken.current + 1;
    selectionToken.current = token;
    jobToken.current += 1;
    setStatus("loading-image");
    setStatusText("正在讀取頁面圖片");
    setProgress(5);
    setError(null);
    setNotice(null);
    setPermissionPrompt(null);
    setLoadedImage(null);
    setRegions([]);
    setEngineUsed(null);
    setOverlayVisible(true);
    if (selection.localReadFailed) {
      setStatus("error");
      setStatusText("圖片讀取失敗");
      setProgress(0);
      setError("這張網頁暫存圖片已失效或無法讀取，請重新載入頁面後再選一次。");
      return;
    }
    if (!tabId) {
      setStatus("error");
      setError("無法確認圖片所在的分頁，請重新選取一次。");
      return;
    }

    const sourceUrl = selection.dataUrl || selection.url;
    let response: FetchImageSuccess | FetchImageFailure;
    try {
      const received = await chrome.runtime.sendMessage<
        FetchImageSuccess | FetchImageFailure | undefined
      >({
        type: "PANELSHIFT_FETCH_IMAGE",
        url: sourceUrl,
      });
      if (!received || typeof received.ok !== "boolean") {
        throw new Error("INVALID_WORKER_RESPONSE");
      }
      response = received;
    } catch {
      response = {
        ok: false,
        code: "worker_unavailable",
        message: "擴充套件背景服務暫時沒有回應，請再試一次。",
      };
    }
    if (selectionToken.current !== token) return;

    if (response.ok === false) {
      if (response.code === "permission_required" && response.pattern && response.origin) {
        setPermissionPrompt({
          origin: response.origin,
          pattern: response.pattern,
          message: response.message,
          selection,
          tabId,
        });
        setStatus("permission");
        setStatusText("需要圖片來源權限");
        setProgress(0);
        return;
      }
      setStatus("error");
      setStatusText("圖片讀取失敗");
      setProgress(0);
      setError(response.message);
      return;
    }

    try {
      const blob = await fetch(response.dataUrl).then((result) => result.blob());
      if (blob.size > MAX_IMAGE_BYTES) throw new Error("TOO_LARGE");
      setLoadedImage({
        selection,
        tabId,
        blob,
        dataUrl: response.dataUrl,
        byteLength: response.byteLength,
      });
      setStatus("ready");
      setStatusText("圖片已就緒");
      setProgress(0);
    } catch {
      setStatus("error");
      setStatusText("圖片解碼失敗");
      setError("這張圖片的格式目前無法辨識，請改選 PNG、JPEG 或 WebP。");
    }
  }, []);

  useEffect(() => {
    const onMessage: PanelshiftRuntimeListener = (message, sender) => {
      if (!isRecord(message)) return;
      if (message.type === "PANELSHIFT_IMAGE_SELECTED" && isPageImageSelection(message.selection)) {
        const session = pickerSessionRef.current;
        if (
          !session
          || sender.tab?.id !== session.tabId
          || message.selection.pageInstanceId !== session.pageInstanceId
        ) return;
        pickerSessionRef.current = null;
        setPickerSession(null);
        void loadSelection(message.selection, sender.tab?.id);
      }
      if (
        message.type === "PANELSHIFT_PICK_CANCELLED"
        && pickerSession
        && sender.tab?.id === pickerSession.tabId
        && message.pageInstanceId === pickerSession.pageInstanceId
      ) {
        pickerSessionRef.current = null;
        setPickerSession(null);
        setStatus((current) => current === "selecting" ? (loadedImage ? "ready" : "idle") : current);
        setStatusText(loadedImage ? "圖片已就緒" : "等待選取圖片");
      }
      if (
        message.type === "PANELSHIFT_MEDIA_CHANGED"
        && loadedImage
        && sender.tab?.id === loadedImage.tabId
        && message.pageInstanceId === loadedImage.selection.pageInstanceId
        && message.imageId === loadedImage.selection.imageId
      ) {
        setLoadedImage(null);
        setRegions([]);
        setStatus("error");
        setStatusText("原圖已更新");
        setError("網頁已換掉這張圖片，請重新選取後再辨識。");
      }
      if (
        message.type === "PANELSHIFT_OVERLAY_INVALIDATED"
        && loadedImage
        && sender.tab?.id === loadedImage.tabId
        && message.pageInstanceId === loadedImage.selection.pageInstanceId
        && message.imageId === loadedImage.selection.imageId
      ) {
        setStatusText("翻譯完成，未能套用");
        setNotice("原圖目前有旋轉或傾斜 transform，為避免錯位已暫停顯示譯文。");
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [loadSelection, loadedImage, pickerSession]);

  useEffect(() => () => {
    const session = pickerSessionRef.current;
    if (!session) return;
    void chrome.tabs.sendMessage(session.tabId, {
      type: "PANELSHIFT_STOP_PICKING",
    }).catch(() => undefined);
  }, []);

  const startPicking = async () => {
    setError(null);
    setNotice(null);
    let tab: PanelshiftChromeTab | undefined;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new PickerStartFailure("no-tab");

      let response: { ok?: boolean; pageInstanceId?: string } | undefined;
      try {
        response = await chrome.tabs.sendMessage<{
          ok?: boolean;
          pageInstanceId?: string;
        }>(tab.id, { type: "PANELSHIFT_START_PICKING" });
      } catch {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content-script.js"],
          });
        } catch (cause) {
          throw new PickerStartFailure("inject", cause);
        }
        try {
          response = await chrome.tabs.sendMessage<{
            ok?: boolean;
            pageInstanceId?: string;
          }>(tab.id, { type: "PANELSHIFT_START_PICKING" });
        } catch (cause) {
          throw new PickerStartFailure("bridge", cause);
        }
      }
      if (!response?.ok || !response.pageInstanceId) {
        throw new PickerStartFailure("validate");
      }
      const session = { tabId: tab.id, pageInstanceId: response.pageInstanceId };
      pickerSessionRef.current = session;
      setPickerSession(session);
      setStatus("selecting");
      setStatusText("請在網頁上點選圖片");
      setProgress(0);
    } catch (caught) {
      setStatus("error");
      setStatusText("無法在這個分頁選圖");
      setError(pickerFailureMessage(caught, tab?.url));
    }
  };

  const cancelPicking = async () => {
    if (pickerSession) {
      await chrome.tabs.sendMessage(pickerSession.tabId, {
        type: "PANELSHIFT_STOP_PICKING",
      }).catch(() => undefined);
    }
    pickerSessionRef.current = null;
    setPickerSession(null);
    setStatus(loadedImage ? "ready" : "idle");
    setStatusText(loadedImage ? "圖片已就緒" : "等待選取圖片");
  };

  const requestImagePermission = async () => {
    if (!permissionPrompt) return;
    try {
      const granted = await chrome.permissions.request({ origins: [permissionPrompt.pattern] });
      if (!granted) {
        setError(`未取得 ${new URL(permissionPrompt.origin).host} 的讀取權限。`);
        return;
      }
      await loadSelection(permissionPrompt.selection, permissionPrompt.tabId);
    } catch {
      setError("Chrome 無法授予這個圖片網域的讀取權限，請到擴充功能的網站存取權設定後再試一次。");
    }
  };

  const saveSettings = async () => {
    const nextSettings = {
      baseUrl: apiSettings.baseUrl.trim().replace(/\/+$/, ""),
      apiKey: apiSettings.apiKey.trim(),
      model: apiSettings.model.trim(),
    };
    setSettingsSaved(false);
    setApiSettings(nextSettings);
    await chrome.storage.local.set({ panelshiftApiSettings: nextSettings });
    setSettingsSaved(true);
    window.setTimeout(() => setSettingsSaved(false), 1800);
  };

  const updateApiSetting = (field: keyof ApiSettings, value: string) => {
    setSettingsSaved(false);
    setApiSettings((current) => ({ ...current, [field]: value }));
    if (field === "baseUrl" || field === "apiKey") {
      setAvailableModels([]);
      setApiConnection(IDLE_API_CONNECTION);
    }
  };

  const testApiConnection = async () => {
    let endpoint: string;
    let pattern: string;
    try {
      endpoint = buildCompatibleApiUrl(apiSettings.baseUrl, "models");
      pattern = compatibleApiOriginPattern(apiSettings.baseUrl);
    } catch (caught) {
      const issue = describeCompatibleApiError(caught, "models");
      setAvailableModels([]);
      setApiConnection({ tone: "error", ...issue });
      return;
    }

    setApiConnection({
      tone: "testing",
      title: "正在測試連線",
      detail: `向 ${new URL(endpoint).host} 讀取 Models API…`,
    });
    setAvailableModels([]);

    try {
      let granted: boolean;
      try {
        granted = await chrome.permissions.request({ origins: [pattern] });
      } catch (caught) {
        throw new CompatibleApiError("permission_denied", { cause: caught });
      }
      if (!granted) throw new CompatibleApiError("permission_denied");

      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "GET",
          headers: buildCompatibleApiHeaders(apiSettings.apiKey),
          cache: "no-store",
          signal: controller.signal,
        });
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          throw new CompatibleApiError("timeout", { cause: caught });
        }
        throw caught;
      } finally {
        window.clearTimeout(timeout);
      }

      if (!response.ok) throw await compatibleApiResponseError(response);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (caught) {
        throw new CompatibleApiError("invalid_json", { cause: caught });
      }
      const modelIds = extractModelIds(payload);
      setAvailableModels(modelIds);
      if (!apiSettings.model.trim() && modelIds.length > 0) {
        setApiSettings((current) => ({ ...current, model: modelIds[0] }));
      }
      setApiConnection(modelIds.length > 0 ? {
        tone: "success",
        title: "連線成功",
        detail: `已載入 ${modelIds.length} 個模型，可直接輸入篩選或從清單選擇。`,
      } : {
        tone: "warning",
        title: "連線成功，但沒有模型清單",
        detail: "服務回傳空的 data 陣列；請手動輸入 Model 後儲存。",
      });
    } catch (caught) {
      const issue = describeCompatibleApiError(caught, "models");
      setAvailableModels([]);
      setApiConnection({ tone: "error", ...issue });
    }
  };

  const runOcr = async () => {
    if (!loadedImage) return;

    const compatibleApiConfigured = Boolean(
      apiSettings.baseUrl.trim() && apiSettings.model.trim(),
    );
    let apiPattern: string | null = null;
    try {
      apiPattern = compatibleApiOriginPattern(apiSettings.baseUrl);
    } catch {
      apiPattern = null;
    }
    let apiPermissionPromise: Promise<boolean> | null = null;
    if (
      compatibleApiConfigured
      && engine === "openai"
      && apiPattern
    ) {
      apiPermissionPromise = chrome.permissions.request({ origins: [apiPattern] });
    }

    const token = jobToken.current + 1;
    jobToken.current = token;
    jobId.current = crypto.randomUUID();
    setStatus("processing");
    setStatusText("正在載入 PP-OCRv5");
    setProgress(8);
    setError(null);
    setNotice(null);
    setEngineUsed(null);
    setRegions([]);
    setOverlayVisible(true);

    let nextRegions: TranslationRegion[];
    try {
      const modelLanguage = sourceLanguage === "en" ? "en" : "japan";
      setStatusText("正在偵測與辨識文字區域");
      setProgress(34);
      const results = await runSandboxOcr(loadedImage.blob, modelLanguage, token);
      if (jobToken.current !== token) return;

      const rawItems: RawOcrItem[] = results.map((item) => ({
        poly: item.poly.map(([x, y]) => [x, y] as const),
        text: item.text,
        score: item.score,
      }));
      setStatusText("整理氣泡與漫畫閱讀順序");
      setProgress(68);
      nextRegions = buildTranslationRegions(
        rawItems,
        loadedImage.selection.naturalWidth,
        loadedImage.selection.naturalHeight,
        sourceLanguage,
        readingOrder,
      );
      if (!nextRegions.length) {
        setStatus("error");
        setStatusText("找不到可辨識文字");
        setProgress(0);
        setError("這張圖片裡找不到英文或日文文字。可嘗試更清晰的圖片或指定原文語言。");
        return;
      }
      setRegions(nextRegions);
    } catch (caught) {
      if (jobToken.current !== token) return;
      console.error("[Panelshift] PP-OCRv5 failed.", caught);
      setStatus("error");
      setStatusText("辨識未完成");
      setProgress(0);
      setError("PP-OCRv5 無法完成辨識。請重新載入擴充功能後再試一次；內建模型不需要另外連網下載。");
      return;
    }

    if (engine === "ocr") {
      setEngineUsed("僅 OCR");
      setStatus("done");
      setStatusText("文字辨識完成");
      setProgress(100);
      return;
    }

    setStatusText("正在翻譯辨識文字");
    setProgress(76);
    const updateTranslationProgress = (value: number) => {
      if (jobToken.current === token) setProgress(value);
    };
    try {
      let translations: string[];
      if (engine === "openai") {
        if (!compatibleApiConfigured) throw new CompatibleApiError("configuration_missing");
        if (!apiPattern) {
          buildCompatibleApiUrl(apiSettings.baseUrl, "chat/completions");
          throw new CompatibleApiError("base_url_invalid");
        }
        if (!apiPermissionPromise) throw new CompatibleApiError("permission_denied");
        let granted: boolean;
        try {
          granted = await apiPermissionPromise;
        } catch (cause) {
          throw new CompatibleApiError("permission_denied", { cause });
        }
        if (!granted) throw new CompatibleApiError("permission_denied");
        translations = await translateWithCompatibleApi(nextRegions, apiSettings);
        setEngineUsed("OpenAI 相容 API");
      } else {
        translations = await translateWithChrome(nextRegions, updateTranslationProgress);
        setEngineUsed("Chrome Translator");
      }
      if (jobToken.current !== token) return;
      setRegions(applyTranslations(nextRegions, translations));
      setStatus("done");
      setStatusText("翻譯完成，正在套用");
      setProgress(100);
    } catch (caught) {
      if (jobToken.current !== token) return;
      console.warn("[Panelshift] Translation unavailable; preserving OCR.", caught);
      setStatus("done");
      setStatusText("辨識完成，翻譯待處理");
      setProgress(100);
      if (engine === "openai") {
        const issue = describeCompatibleApiError(caught, "translation");
        setNotice(`${issue.title}：${issue.detail} 已保留 OCR 文字供你校對。`);
      } else if (caught instanceof Error && caught.message === "CHROME_TRANSLATOR_UNAVAILABLE") {
        setNotice("這個 Chrome 版本或裝置尚未提供 Translator API；已保留 OCR 文字。你可以改選 OpenAI 相容 API。");
      } else if (caught instanceof Error && caught.message === "CHROME_LANGUAGE_UNAVAILABLE") {
        setNotice("Chrome Translator 不支援目前辨識到的語言組合；已保留 OCR 文字。你可以指定原文語言或改選 OpenAI 相容 API。");
      } else {
        setNotice("Chrome Translator 無法完成翻譯，可能是語言套件尚未下載或瀏覽器暫時無法使用；已保留 OCR 文字。");
      }
      setEngineUsed("僅 OCR");
    }
  };

  const cancelOcr = () => {
    jobToken.current += 1;
    restartSandbox("OCR_CANCELLED");
    setRegions([]);
    setEngineUsed(null);
    setProgress(0);
    setStatus(loadedImage ? "ready" : "idle");
    setStatusText(loadedImage ? "圖片已就緒" : "等待選取圖片");
    setNotice("已停止這次辨識。");
  };

  useEffect(() => {
    if (!loadedImage || !regions.length) return;
    const tabId = loadedImage.tabId;
    const selection = loadedImage.selection;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (activeTabId === null) return;
        if (activeTabId !== tabId) {
          setStatusText((current) => current === "翻譯完成，正在套用" ? "翻譯完成，切回原分頁套用" : current);
          setNotice("目前顯示的是另一個分頁；切回原圖片分頁後才會更新譯文。");
          return;
        }
        if (!overlayVisible) {
          await chrome.tabs.sendMessage(tabId, { type: "PANELSHIFT_CLEAR_OVERLAYS" });
          setNotice((current) => current === "目前顯示的是另一個分頁；切回原圖片分頁後才會更新譯文。" ? null : current);
          return;
        }
        overlayRevision.current += 1;
        const response = await chrome.tabs.sendMessage<unknown>(tabId, {
          type: "PANELSHIFT_APPLY_OVERLAYS",
          payload: {
            pageInstanceId: selection.pageInstanceId,
            imageId: selection.imageId,
            mediaRevision: selection.mediaRevision,
            jobId: jobId.current,
            overlayRevision: overlayRevision.current,
            sourceSize: {
              width: selection.naturalWidth,
              height: selection.naturalHeight,
            },
            background,
            regions,
          },
        });
        if (!isRecord(response) || response.ok !== true) {
          setStatusText((current) => (
            current === "翻譯完成，正在套用" || current === "翻譯完成，切回原分頁套用"
              ? "翻譯完成，未能套用"
              : current
          ));
          setNotice("原圖狀態已改變；請重新選取圖片後再套用譯文。");
          return;
        }
        setStatusText((current) => (
          current === "翻譯完成，正在套用" || current === "翻譯完成，切回原分頁套用"
            ? "翻譯已疊回原圖"
            : current
        ));
        setNotice((current) => current === "目前顯示的是另一個分頁；切回原圖片分頁後才會更新譯文。" ? null : current);
      })().catch(() => {
        setStatusText((current) => (
          current === "翻譯完成，正在套用" || current === "翻譯完成，切回原分頁套用"
            ? "翻譯完成，未能套用"
            : current
        ));
        setNotice("網頁內容已更新；若譯文沒有顯示，請重新選取圖片。");
      });
    }, 90);
    return () => window.clearTimeout(timer);
  }, [activeTabId, background, loadedImage, overlayVisible, regions]);

  const summary = useMemo(() => {
    if (!loadedImage) return null;
    const { selection } = loadedImage;
    return `${selection.naturalWidth} × ${selection.naturalHeight} · ${formatBytes(loadedImage.byteLength)}`;
  }, [loadedImage]);

  const editTranslation = (id: string, translation: string) => {
    setRegions((current) => current.map((region) => (
      region.id === id ? { ...region, translation } : region
    )));
  };

  const clearOverlay = () => {
    setOverlayVisible(false);
  };

  const readyForRun = Boolean(loadedImage)
    && !["selecting", "loading-image", "permission", "processing"].includes(status);

  return (
    <div className="panel-shell">
      <header className="panel-header">
        <div className="brand-mark" aria-hidden="true">譯</div>
        <div className="brand-copy">
          <strong>譯格</strong>
          <span>Panelshift · 圖片即時翻譯</span>
        </div>
        <span className="header-pill">PP-OCRv5</span>
      </header>

      <main className="panel-main">
        <section className="status-line" aria-live="polite">
          <span className={`status-dot status-${status}`} />
          <div>
            <strong>{statusText}</strong>
            <span>{status === "processing" ? `${progress}%` : "日文／英文 → 繁體中文"}</span>
          </div>
        </section>

        {status === "processing" && (
          <div className="progress-track" aria-label={`處理進度 ${progress}%`}>
            <span style={{ width: `${progress}%` }} />
          </div>
        )}

        {error && <div className="message message-error" role="alert">{error}</div>}
        {notice && <div className="message message-notice" role="status" aria-live="polite">{notice}</div>}

        {!loadedImage && status !== "permission" && (
          <section className="empty-card">
            <div className="empty-visual" aria-hidden="true">
              <span className="empty-frame" />
              <span className="empty-copy">あ</span>
            </div>
            <h1>從網頁選一張圖片</h1>
            <p>點一下按鈕，再回到網頁選取漫畫或插圖。譯文會直接貼回原圖位置。</p>
            <button className="button button-primary button-wide" type="button" onClick={status === "selecting" ? cancelPicking : startPicking}>
              {status === "selecting" ? "取消選取" : "選取頁面圖片"}
            </button>
            <small>只會存取你當下選取的分頁與圖片。</small>
          </section>
        )}

        {permissionPrompt && status === "permission" && (
          <section className="permission-card">
            <span className="eyebrow">圖片來源權限</span>
            <h2>{new URL(permissionPrompt.origin).host}</h2>
            <p>{permissionPrompt.message} 權限只套用到這個網域，可隨時在 Chrome 擴充套件設定中撤銷。</p>
            <div className="button-row">
              <button className="button button-primary" type="button" onClick={requestImagePermission}>
                允許並繼續
              </button>
              <button className="button button-quiet" type="button" onClick={startPicking}>
                改選圖片
              </button>
            </div>
          </section>
        )}

        {loadedImage && (
          <>
            <section className="source-card">
              {/* eslint-disable-next-line @next/next/no-img-element -- The extension previews an in-memory data URL. */}
              <img src={loadedImage.dataUrl} alt={loadedImage.selection.alt || "已選取的頁面圖片"} />
              <div className="source-copy">
                <span className="eyebrow">目前圖片</span>
                <strong>{loadedImage.selection.hostname || "頁面圖片"}</strong>
                <span>{summary}</span>
              </div>
              <button
                className="text-button"
                type="button"
                disabled={status === "processing"}
                onClick={status === "selecting" ? cancelPicking : startPicking}
              >
                {status === "selecting" ? "取消" : "重選"}
              </button>
            </section>

            <section className="settings-card">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">快速設定</span>
                  <h2>辨識與排版</h2>
                </div>
                <span className="step-label">01</span>
              </div>
              <div className="field-grid">
                <label>
                  <span>原文</span>
                  <select value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value as SourceLanguage)}>
                    <option value="auto">自動判斷</option>
                    <option value="ja">日文</option>
                    <option value="en">英文</option>
                  </select>
                </label>
                <label>
                  <span>閱讀順序</span>
                  <select value={readingOrder} onChange={(event) => setReadingOrder(event.target.value as ReadingOrder)}>
                    <option value="auto">自動</option>
                    <option value="rtl">右 → 左</option>
                    <option value="ltr">左 → 右</option>
                  </select>
                </label>
                <label>
                  <span>翻譯引擎</span>
                  <select value={engine} onChange={(event) => setEngine(event.target.value as EngineMode)}>
                    <option value="chrome">Chrome Translator</option>
                    <option value="openai">OpenAI 相容 API</option>
                    <option value="ocr">僅 OCR</option>
                  </select>
                </label>
                <label>
                  <span>譯文底色</span>
                  <select value={background} onChange={(event) => setBackground(event.target.value as OverlayBackground)}>
                    <option value="translucent">半透明</option>
                    <option value="white">白色</option>
                    <option value="none">無底色</option>
                  </select>
                </label>
              </div>
              <p className="field-note">橫排／直排會依 polygon 比例判斷；日文預設採漫畫閱讀順序。</p>
            </section>

            {regions.length > 0 && (
              <section className="results-section">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">校對</span>
                    <h2>{regions.length} 個文字區域</h2>
                  </div>
                  <span className="engine-label">{engineUsed || "處理中"}</span>
                </div>
                <div className="result-list">
                  {regions.map((region, index) => (
                    <article className="result-card" key={region.id}>
                      <div className="result-meta">
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <span>{region.orientation === "vertical" ? "直排" : "橫排"} · {Math.round(region.score * 100)}%</span>
                      </div>
                      <p lang={region.sourceLanguage === "ja" ? "ja" : "en"}>{region.sourceText}</p>
                      <label>
                        <span>繁體中文</span>
                        <textarea
                          rows={region.orientation === "vertical" ? 4 : 3}
                          value={region.translation}
                          placeholder="尚未翻譯；可直接輸入譯文"
                          onChange={(event) => editTranslation(region.id, event.target.value)}
                        />
                      </label>
                    </article>
                  ))}
                </div>
              </section>
            )}

            {engine === "openai" && (
              <section className="api-card api-card-visible" aria-labelledby="api-settings-title">
                <div className="api-card-heading">
                  <div>
                  <span className="eyebrow">翻譯服務</span>
                    <h2 id="api-settings-title">OpenAI 相容 API</h2>
                  </div>
                  <span>{apiSettings.model.trim() ? "可測試" : "待設定"}</span>
                </div>
                <div className="api-fields">
                  <label>
                    <span>Base URL</span>
                    <input
                      type="url"
                      value={apiSettings.baseUrl}
                      onChange={(event) => updateApiSetting("baseUrl", event.target.value)}
                      placeholder="https://api.openai.com/v1"
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    <span>API Key（本機服務可留白）</span>
                    <input
                      type="password"
                      value={apiSettings.apiKey}
                      onChange={(event) => updateApiSetting("apiKey", event.target.value)}
                      placeholder="只儲存在這台瀏覽器"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    <span>Model</span>
                    <input
                      value={apiSettings.model}
                      onChange={(event) => updateApiSetting("model", event.target.value)}
                      placeholder="gpt-5.6"
                      list={availableModels.length > 0 ? "panelshift-model-options" : undefined}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {availableModels.length > 0 && (
                      <datalist id="panelshift-model-options">
                        {availableModels.map((model) => <option value={model} key={model} />)}
                      </datalist>
                    )}
                  </label>
                  <div className="api-actions">
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={apiConnection.tone === "testing"}
                      onClick={testApiConnection}
                    >
                      {apiConnection.tone === "testing" ? "正在測試…" : "測試連線並載入模型"}
                    </button>
                    <button className="button button-quiet" type="button" onClick={saveSettings}>
                      {settingsSaved ? "已儲存" : "儲存設定"}
                    </button>
                  </div>
                  {apiConnection.tone !== "idle" && (
                    <div
                      className={`api-connection api-connection-${apiConnection.tone}`}
                      role={apiConnection.tone === "error" ? "alert" : "status"}
                      aria-live="polite"
                    >
                      <strong>{apiConnection.title}</strong>
                      <span>{apiConnection.detail}</span>
                    </div>
                  )}
                  <p>測試會呼叫 Base URL 下的 <code>/models</code>。只接受 HTTPS 或本機 HTTP；API Key 只寫入 Chrome 本機儲存空間。</p>
                </div>
              </section>
            )}
          </>
        )}
      </main>

      <footer className="panel-footer">
        {loadedImage ? (
          <>
            {regions.length > 0 && status !== "processing" && status !== "selecting" && (
              <button className="button button-quiet footer-secondary" type="button" onClick={overlayVisible ? clearOverlay : () => setOverlayVisible(true)}>
                {overlayVisible ? "隱藏譯文" : "顯示譯文"}
              </button>
            )}
            {status === "processing" ? (
              <button className="button button-stop footer-primary" type="button" onClick={cancelOcr}>
                停止辨識 · {progress}%
              </button>
            ) : status === "selecting" ? (
              <button className="button button-quiet footer-primary" type="button" onClick={cancelPicking}>
                取消選取
              </button>
            ) : (
              <button className="button button-primary footer-primary" type="button" disabled={!readyForRun} onClick={runOcr}>
                {regions.length ? "重新辨識並翻譯" : "辨識並翻譯"}
              </button>
            )}
          </>
        ) : (
          <button
            className={`button ${status === "selecting" ? "button-quiet" : "button-primary"} footer-primary`}
            type="button"
            onClick={status === "selecting" ? cancelPicking : startPicking}
          >
            {status === "selecting" ? "取消選取" : "選取頁面圖片"}
          </button>
        )}
      </footer>
      <iframe
        key={sandboxEpoch}
        ref={ocrFrame}
        className="ocr-sandbox"
        src={`./ocr-sandbox.html?session=${sandboxEpoch}`}
        title="PP-OCRv5 隔離執行環境"
        tabIndex={-1}
        aria-hidden="true"
        onLoad={pingSandbox}
      />
    </div>
  );
}
