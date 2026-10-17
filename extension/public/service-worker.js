/* global chrome */

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "data:"]);

async function configureSidePanel() {
  try {
    // This setting persists across extension reloads. Keep it disabled so the
    // action click reaches our handler, where Chrome guarantees activeTab.
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (error) {
    console.warn("[Panelshift] Unable to configure the side panel.", error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void configureSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
  void configureSidePanel();
});

void configureSidePanel();

async function ensurePageBridge(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "PANELSHIFT_PING" });
    if (response?.ok) return;
  } catch {
    // No live bridge yet. The action click's activeTab grant lets us inject it.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-script.js"],
  });
}

chrome.action.onClicked.addListener((tab) => {
  // sidePanel.open() must be called synchronously from the user gesture. Do
  // not put an await before this call.
  const panelPromise = typeof tab.windowId === "number"
    ? chrome.sidePanel.open({ windowId: tab.windowId })
    : chrome.sidePanel.open({ tabId: tab.id });
  const bridgePromise = typeof tab.id === "number"
    ? ensurePageBridge(tab.id)
    : Promise.reject(new Error("No active tab was supplied by Chrome."));

  void panelPromise.catch((error) => {
    console.warn("[Panelshift] Unable to open the side panel.", error);
  });
  void bridgePromise.catch((error) => {
    console.warn("[Panelshift] Unable to prepare the selected page.", error);
  });
});

function permissionPattern(url) {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "hath.network" || hostname.endsWith(".hath.network")) {
    // H@H image nodes use rotating subdomains and non-default ports. One
    // domain-scoped grant avoids asking again for every page image.
    return `${parsed.protocol}//*.hath.network/*`;
  }
  // Chrome host-permission match patterns use a hostname, not URL.origin;
  // omitting the port covers both default and non-default ports.
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function estimateDataUrlBytes(url) {
  const comma = url.indexOf(",");
  if (comma < 0) return Number.POSITIVE_INFINITY;
  const metadata = url.slice(0, comma);
  const payload = url.slice(comma + 1);
  return metadata.includes(";base64")
    ? Math.floor((payload.length * 3) / 4)
    : new TextEncoder().encode(decodeURIComponent(payload)).byteLength;
}

async function fetchImage(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: "invalid_url", message: "圖片網址無效。" };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      code: "unsupported_protocol",
      message: "這個圖片來源無法由擴充套件讀取。",
    };
  }

  if (parsed.protocol === "data:") {
    const byteLength = estimateDataUrlBytes(url);
    if (byteLength > MAX_IMAGE_BYTES) {
      return { ok: false, code: "too_large", message: "圖片超過 20 MB。" };
    }
    return { ok: true, dataUrl: url, byteLength };
  }

  const pattern = permissionPattern(url);
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  if (!granted) {
    return {
      ok: false,
      code: "permission_required",
      origin: parsed.origin,
      pattern,
      message: `需要你允許讀取 ${parsed.host} 的這張圖片。`,
    };
  }

  let response;
  try {
    response = await fetch(url, {
      cache: "force-cache",
      credentials: "include",
      redirect: "follow",
    });
  } catch {
    return {
      ok: false,
      code: "fetch_failed",
      message: "圖片伺服器拒絕讀取，請改用可直接開啟的圖片。",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      code: "fetch_failed",
      message: `圖片伺服器回傳 ${response.status}，目前無法讀取。`,
    };
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_IMAGE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, code: "too_large", message: "圖片超過 20 MB。" };
  }

  // Content-Length can be absent or inaccurate. Enforce the limit while
  // reading, so a large or endless response is never buffered in full.
  const chunks = [];
  let byteLength = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > MAX_IMAGE_BYTES) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, code: "too_large", message: "圖片超過 20 MB。" };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const mime = response.headers.get("content-type")?.split(";")[0] || "image/png";
  if (!mime.startsWith("image/")) {
    return { ok: false, code: "not_image", message: "選取的網址不是圖片內容。" };
  }

  const base64 = bytesToBase64(bytes);
  return {
    ok: true,
    dataUrl: `data:${mime};base64,${base64}`,
    byteLength,
    mime,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "PANELSHIFT_FETCH_IMAGE") return undefined;
  void fetchImage(message.url)
    .then(sendResponse)
    .catch(() => sendResponse({
      ok: false,
      code: "fetch_failed",
      message: "圖片讀取失敗，請再試一次。",
    }));
  return true;
});
