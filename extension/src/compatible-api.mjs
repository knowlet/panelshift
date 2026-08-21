const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const MAX_PROVIDER_MESSAGE_LENGTH = 180;

export class CompatibleApiError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = "CompatibleApiError";
    this.code = code;
    this.status = options.status;
    this.providerMessage = options.providerMessage;
    this.cause = options.cause;
  }
}

function normalizeProviderMessage(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [已隱藏]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "[已隱藏的 API Key]")
    .replace(/\b(?:api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*\S+/gi, "[已隱藏的憑證]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PROVIDER_MESSAGE_LENGTH);
}

function providerMessageFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const error = payload.error;
  if (error && typeof error === "object" && typeof error.message === "string") {
    return normalizeProviderMessage(error.message);
  }
  if (typeof payload.message === "string") {
    return normalizeProviderMessage(payload.message);
  }
  return "";
}

export function normalizeCompatibleApiBaseUrl(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) throw new CompatibleApiError("base_url_missing");

  let url;
  try {
    url = new URL(candidate);
  } catch (cause) {
    throw new CompatibleApiError("base_url_invalid", { cause });
  }

  const localHttp = url.protocol === "http:" && LOCAL_HTTP_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new CompatibleApiError("base_url_unsafe");
  }
  if (url.username || url.password) {
    throw new CompatibleApiError("base_url_credentials");
  }

  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}

export function buildCompatibleApiUrl(baseUrl, resource) {
  const normalized = normalizeCompatibleApiBaseUrl(baseUrl);
  const path = String(resource || "").replace(/^\/+/, "");
  if (!path) return normalized;
  return `${normalized}/${path}`;
}

export function compatibleApiOriginPattern(baseUrl) {
  const url = new URL(normalizeCompatibleApiBaseUrl(baseUrl));
  return `${url.protocol}//${url.hostname}/*`;
}

export function buildCompatibleApiHeaders(apiKey, includeJson = false) {
  const headers = {};
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (includeJson) headers["Content-Type"] = "application/json";
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

export function extractModelIds(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
    throw new CompatibleApiError("models_schema_invalid");
  }

  const ids = payload.data
    .map((item) => (
      item && typeof item === "object" && typeof item.id === "string"
        ? item.id.trim()
        : ""
    ))
    .filter(Boolean);

  return [...new Set(ids)].sort((left, right) => left.localeCompare(right, "en"));
}

export async function compatibleApiResponseError(response) {
  let providerMessage = "";
  try {
    const text = (await response.text()).slice(0, 4096);
    if (text) providerMessage = providerMessageFromPayload(JSON.parse(text));
  } catch {
    // HTML and malformed response bodies are intentionally not surfaced.
  }
  return new CompatibleApiError("http_error", {
    status: response.status,
    providerMessage,
  });
}

function withProviderDetail(detail, providerMessage) {
  return providerMessage ? `${detail} 服務訊息：${providerMessage}` : detail;
}

export function describeCompatibleApiError(error, operation = "models") {
  const modelsOperation = operation === "models";
  if (error instanceof CompatibleApiError) {
    if (error.code === "base_url_missing") {
      return { title: "尚未填寫 Base URL", detail: "請輸入包含 API 版本路徑的網址，例如 https://api.openai.com/v1。" };
    }
    if (error.code === "base_url_invalid") {
      return { title: "Base URL 格式無效", detail: "請輸入完整網址，並確認沒有多餘空格或錯字。" };
    }
    if (error.code === "base_url_unsafe") {
      return { title: "Base URL 不安全", detail: "遠端服務必須使用 HTTPS；只有 localhost、127.0.0.1 或 ::1 可使用 HTTP。" };
    }
    if (error.code === "base_url_credentials") {
      return { title: "Base URL 不能包含帳號密碼", detail: "請移除網址中的登入資訊，API Key 請填在獨立欄位。" };
    }
    if (error.code === "configuration_missing") {
      return { title: "API 設定不完整", detail: "請填寫 Base URL 與 Model。API Key 可留白給不需驗證的本機相容服務。" };
    }
    if (error.code === "permission_denied") {
      return { title: "未取得 API 網域權限", detail: "Chrome 沒有允許譯格連線到這個網域；請再按一次測試並允許存取。" };
    }
    if (error.code === "invalid_json") {
      return { title: "回應不是有效的 JSON", detail: modelsOperation ? "端點可連線，但回應不符合 OpenAI Models API 格式。請確認 Base URL 是否已包含 /v1。" : "翻譯端點可連線，但回應不是 OpenAI 相容的 JSON。" };
    }
    if (error.code === "models_schema_invalid") {
      return { title: "模型列表格式不相容", detail: "回應必須包含 data 陣列，且每個模型要有字串 id；仍可手動輸入 Model。" };
    }
    if (error.code === "timeout") {
      return { title: "連線逾時", detail: "服務在期限內沒有回應。請確認伺服器已啟動、網址正確，或稍後再試。" };
    }
    if (error.code === "http_error") {
      const status = error.status;
      if (status === 400) {
        return { title: "請求格式或 Base URL 不正確（400）", detail: withProviderDetail("請確認 Base URL 已包含正確 API 版本路徑。", error.providerMessage) };
      }
      if (status === 401) {
        return { title: "API Key 缺少或無效（401）", detail: "請重新確認金鑰是否完整、有效且屬於目前服務。" };
      }
      if (status === 403) {
        return { title: "沒有存取權限（403）", detail: "目前金鑰、帳號、組織或所選模型沒有權限。" };
      }
      if (status === 404) {
        return {
          title: modelsOperation ? "找不到 Models API（404）" : "找不到翻譯端點（404）",
          detail: modelsOperation
            ? "服務可能未提供 /models，或 Base URL 不正確；你仍可手動輸入 Model 後儲存。"
            : "請確認 Base URL 可組成 /chat/completions；目前已保留 OCR 原文。",
        };
      }
      if (status === 408 || status === 504) {
        return { title: `服務逾時（${status}）`, detail: "上游服務沒有及時完成請求，請稍後再試。" };
      }
      if (status === 429) {
        return { title: "已達速率或額度限制（429）", detail: "請檢查用量、帳務與速率限制，或稍後再試。" };
      }
      if (typeof status === "number" && status >= 500) {
        return { title: `服務暫時異常（${status}）`, detail: "相容 API 伺服器目前無法完成請求，請稍後再試。" };
      }
      return {
        title: typeof status === "number" ? `API 回傳錯誤（${status}）` : "API 回傳錯誤",
        detail: withProviderDetail("請檢查服務設定後再試。", error.providerMessage),
      };
    }
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return { title: "連線逾時", detail: "服務在期限內沒有回應。請確認伺服器已啟動、網址正確，或稍後再試。" };
  }
  if (error instanceof TypeError) {
    return { title: "無法連線到 API", detail: "請檢查網路、DNS、TLS 憑證、CORS 設定與 Chrome 網域權限；本機服務也要確認已啟動。" };
  }
  return { title: "連線測試失敗", detail: "發生未預期錯誤，請檢查設定後再試。" };
}
