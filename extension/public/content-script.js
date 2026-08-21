/* global chrome */

(() => {
  if (window.__panelshiftContentBridge) {
    window.__panelshiftContentBridge.ping();
    return;
  }

  const pageInstanceId = crypto.randomUUID();
  const imageIds = new WeakMap();
  let imageSequence = 0;
  let mediaRevision = 1;
  let overlayRevision = 0;
  let selectedImage = null;
  let selectedSignature = "";
  let pickerActive = false;
  let previousCursor = null;
  let frame = null;
  let pendingFrame = 0;
  let lastMeasuredBox = "";
  let stableMeasureFrames = 0;
  let selectionEpoch = 0;
  let pointerX = -1;
  let pointerY = -1;

  const host = document.createElement("div");
  host.id = "panelshift-extension-root";
  host.style.cssText = [
    "all:initial",
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "pointer-events:none",
    "contain:layout style",
  ].join(";");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .ps-banner {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      z-index: 30;
      display: none; align-items: center; gap: 10px; max-width: calc(100vw - 32px);
      padding: 10px 14px; border: 1px solid rgba(255,255,255,.45); border-radius: 999px;
      background: rgba(44,48,45,.94); color: #fffefa;
      box-shadow: 0 12px 36px rgba(21,24,21,.22); backdrop-filter: blur(14px);
      font: 600 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: .01em; white-space: nowrap;
    }
    .ps-banner[data-visible="true"] { display: flex; }
    .ps-banner kbd {
      padding: 2px 7px; border: 1px solid rgba(255,255,255,.25); border-radius: 6px;
      background: rgba(255,255,255,.1); color: inherit; font: inherit; font-size: 11px;
    }
    .ps-hover {
      position: fixed; display: none; border: 3px solid #758f77; border-radius: 7px;
      z-index: 20;
      background: rgba(117,143,119,.12); box-shadow: 0 0 0 1px rgba(255,255,255,.9) inset;
      transition: left 60ms linear, top 60ms linear, width 60ms linear, height 60ms linear;
    }
    .ps-hover[data-visible="true"] { display: block; }
    .ps-frame { position: fixed; z-index: 10; overflow: hidden; pointer-events: none; }
    .ps-region {
      position: absolute; display: grid; place-items: center; overflow: hidden;
      padding: 4px; color: #252925; text-align: center; font-family: -apple-system,
      BlinkMacSystemFont, "Noto Sans TC", "PingFang TC", "Hiragino Sans", sans-serif;
      font-weight: 650; line-height: 1.16; letter-spacing: .01em;
      overflow-wrap: anywhere; text-wrap: balance;
    }
    .ps-region[data-background="white"] { background: rgba(255,254,250,.97); }
    .ps-region[data-background="translucent"] {
      background: rgba(255,254,250,.80); backdrop-filter: blur(3px);
    }
    .ps-region[data-background="none"] {
      color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.95), 0 0 5px rgba(0,0,0,.75);
    }
    .ps-region[data-orientation="vertical"] {
      writing-mode: vertical-rl; text-orientation: mixed; text-align: start;
    }
    .ps-region > span { display: block; max-width: 100%; max-height: 100%; white-space: pre-wrap; }
  `;
  shadow.append(style);

  const banner = document.createElement("div");
  banner.className = "ps-banner";
  banner.setAttribute("role", "status");
  banner.append("移到漫畫圖片上並點一下", Object.assign(document.createElement("kbd"), { textContent: "Esc 取消" }));
  shadow.append(banner);

  const hover = document.createElement("div");
  hover.className = "ps-hover";
  shadow.append(hover);
  document.documentElement.append(host);

  function ping() {
    if (!host.isConnected) document.documentElement.append(host);
  }

  function imageId(image) {
    let id = imageIds.get(image);
    if (!id) {
      imageSequence += 1;
      id = `image-${imageSequence}`;
      imageIds.set(image, id);
    }
    return id;
  }

  function imageUrl(image) {
    return image.currentSrc || image.src || "";
  }

  function signature(image) {
    return `${imageUrl(image)}|${image.naturalWidth}x${image.naturalHeight}`;
  }

  function isEligible(image) {
    const rect = image.getBoundingClientRect();
    const css = getComputedStyle(image);
    return imageUrl(image)
      && image.naturalWidth >= 80
      && image.naturalHeight >= 80
      && rect.width >= 56
      && rect.height >= 56
      && css.visibility !== "hidden"
      && css.display !== "none"
      && Number(css.opacity) > 0;
  }

  function imageAtPoint(x, y) {
    for (const element of document.elementsFromPoint(x, y)) {
      const image = element instanceof HTMLImageElement ? element : element.closest?.("img");
      if (image instanceof HTMLImageElement && isEligible(image)) return image;
    }
    return null;
  }

  function updateHover(image) {
    if (!image) {
      hover.dataset.visible = "false";
      return;
    }
    const rect = image.getBoundingClientRect();
    Object.assign(hover.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    hover.dataset.visible = "true";
  }

  function onPointerMove(event) {
    if (!pickerActive) return;
    pointerX = event.clientX;
    pointerY = event.clientY;
    updateHover(imageAtPoint(event.clientX, event.clientY));
  }

  function stopPicking(cancelled = false) {
    if (!pickerActive) return;
    pickerActive = false;
    banner.dataset.visible = "false";
    hover.dataset.visible = "false";
    pointerX = -1;
    pointerY = -1;
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("click", onPickerClick, true);
    window.removeEventListener("keydown", onPickerKeyDown, true);
    if (previousCursor) {
      document.documentElement.style.setProperty("cursor", previousCursor.value, previousCursor.priority);
    } else {
      document.documentElement.style.removeProperty("cursor");
    }
    previousCursor = null;
    if (cancelled) {
      void chrome.runtime.sendMessage({ type: "PANELSHIFT_PICK_CANCELLED", pageInstanceId });
    }
  }

  function onPickerKeyDown(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    stopPicking(true);
  }

  async function dataUrlForPageLocalSource(image) {
    const url = imageUrl(image);
    if (url.startsWith("data:")) return url;
    let parsed;
    try {
      parsed = new URL(url, location.href);
    } catch {
      return undefined;
    }
    const isBlob = parsed.protocol === "blob:";
    const isSameOriginHttp = (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.origin === location.origin;
    if (!isBlob && !isSameOriginHttp) return undefined;
    try {
      const response = await fetch(url, {
        cache: "force-cache",
        credentials: "include",
      });
      if (!response.ok) return undefined;
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > 20 * 1024 * 1024) return undefined;
      const blob = await response.blob();
      if (blob.size > 20 * 1024 * 1024) return undefined;
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
        reader.onerror = () => resolve(undefined);
        reader.readAsDataURL(blob);
      });
    } catch {
      return undefined;
    }
  }

  async function selectImage(image) {
    if (selectedImage && selectedImage !== image) resizeObserver.unobserve(selectedImage);
    if (selectedImage && selectedImage !== image) {
      selectedImage.removeEventListener("load", scheduleMeasure);
    }
    selectionEpoch += 1;
    const token = selectionEpoch;
    mediaRevision += 1;
    overlayRevision = 0;
    selectedImage = image;
    resizeObserver.observe(image);
    image.addEventListener("load", scheduleMeasure);
    observeSelectedImage(image);
    selectedSignature = signature(image);
    clearFrame();
    const rect = image.getBoundingClientRect();
    const snapshot = {
      pageInstanceId,
      imageId: imageId(image),
      mediaRevision,
      url: imageUrl(image),
      alt: image.alt || "",
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      displayWidth: Math.round(rect.width),
      displayHeight: Math.round(rect.height),
      hostname: location.hostname,
      signature: selectedSignature,
    };
    const dataUrl = await dataUrlForPageLocalSource(image);
    if (
      selectionEpoch !== token
      || selectedImage !== image
      || signature(image) !== snapshot.signature
      || mediaRevision !== snapshot.mediaRevision
    ) return;
    void chrome.runtime.sendMessage({
      type: "PANELSHIFT_IMAGE_SELECTED",
      selection: {
        pageInstanceId: snapshot.pageInstanceId,
        imageId: snapshot.imageId,
        mediaRevision: snapshot.mediaRevision,
        url: snapshot.url,
        dataUrl,
        alt: snapshot.alt,
        naturalWidth: snapshot.naturalWidth,
        naturalHeight: snapshot.naturalHeight,
        displayWidth: snapshot.displayWidth,
        displayHeight: snapshot.displayHeight,
        hostname: snapshot.hostname,
        localReadFailed: snapshot.url.startsWith("blob:") && !dataUrl,
      },
    });
  }

  function onPickerClick(event) {
    if (!pickerActive) return;
    const image = imageAtPoint(event.clientX, event.clientY);
    if (!image) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stopPicking(false);
    void selectImage(image);
  }

  function startPicking() {
    ping();
    if (pickerActive) return { ok: true, pageInstanceId };
    pickerActive = true;
    previousCursor = {
      value: document.documentElement.style.getPropertyValue("cursor"),
      priority: document.documentElement.style.getPropertyPriority("cursor"),
    };
    document.documentElement.style.setProperty("cursor", "crosshair", "important");
    banner.dataset.visible = "true";
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("click", onPickerClick, true);
    window.addEventListener("keydown", onPickerKeyDown, true);
    return { ok: true, pageInstanceId };
  }

  function number(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function axisPosition(token, freeSpace, scale = 1) {
    const value = String(token || "50%").trim().toLowerCase();
    if (value === "left" || value === "top") return 0;
    if (value === "center") return freeSpace / 2;
    if (value === "right" || value === "bottom") return freeSpace;
    const calculation = value.match(/^calc\(\s*(-?[\d.]+)%\s*([+-])\s*([\d.]+)px\s*\)$/);
    if (calculation) {
      const percent = number(calculation[1]) / 100;
      const offset = number(calculation[3]) * scale * (calculation[2] === "-" ? -1 : 1);
      return freeSpace * percent + offset;
    }
    if (value.endsWith("%")) return freeSpace * number(value) / 100;
    if (value.endsWith("px")) return number(value) * scale;
    return freeSpace / 2;
  }

  function positionTokens(value) {
    return String(value || "50% 50%").match(/calc\([^)]*\)|[^\s]+/g) || ["50%", "50%"];
  }

  function resolveEdgePosition(edge, offset, freeSpace, scale) {
    const distance = offset ? axisPosition(offset, freeSpace, scale) : 0;
    return edge === "right" || edge === "bottom" ? freeSpace - distance : distance;
  }

  function resolveObjectPosition(value, freeX, freeY, scaleX, scaleY) {
    const tokens = positionTokens(value);
    const horizontalEdges = new Set(["left", "right"]);
    const verticalEdges = new Set(["top", "bottom"]);

    if (tokens.length >= 3) {
      let x = null;
      let y = null;
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index].toLowerCase();
        if (horizontalEdges.has(token)) {
          const offset = tokens[index + 1] && !horizontalEdges.has(tokens[index + 1].toLowerCase())
            && !verticalEdges.has(tokens[index + 1].toLowerCase())
            && tokens[index + 1].toLowerCase() !== "center"
            ? tokens[++index]
            : null;
          x = resolveEdgePosition(token, offset, freeX, scaleX);
        } else if (verticalEdges.has(token)) {
          const offset = tokens[index + 1] && !horizontalEdges.has(tokens[index + 1].toLowerCase())
            && !verticalEdges.has(tokens[index + 1].toLowerCase())
            && tokens[index + 1].toLowerCase() !== "center"
            ? tokens[++index]
            : null;
          y = resolveEdgePosition(token, offset, freeY, scaleY);
        } else if (token === "center") {
          if (x === null) x = freeX / 2;
          else if (y === null) y = freeY / 2;
        }
      }
      return {
        x: x ?? freeX / 2,
        y: y ?? freeY / 2,
      };
    }

    let [xToken = "50%", yToken = "50%"] = tokens;
    if (verticalEdges.has(xToken.toLowerCase()) || horizontalEdges.has(yToken.toLowerCase())) {
      [xToken, yToken] = [yToken, xToken];
    }
    return {
      x: axisPosition(xToken, freeX, scaleX),
      y: axisPosition(yToken, freeY, scaleY),
    };
  }

  function hasUnsupportedTransform(image) {
    for (let element = image; element instanceof Element; element = element.parentElement) {
      const transform = getComputedStyle(element).transform;
      if (!transform || transform === "none") continue;
      try {
        const matrix = new DOMMatrixReadOnly(transform);
        if (!matrix.is2D
          || Math.abs(matrix.b) > 0.0001
          || Math.abs(matrix.c) > 0.0001
          || matrix.a <= 0
          || matrix.d <= 0) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  function drawnImageBox(image) {
    if (hasUnsupportedTransform(image)) return null;
    const outer = image.getBoundingClientRect();
    const css = getComputedStyle(image);
    const scaleX = outer.width / Math.max(1, image.offsetWidth || outer.width);
    const scaleY = outer.height / Math.max(1, image.offsetHeight || outer.height);
    const borderLeft = number(css.borderLeftWidth) * scaleX;
    const borderTop = number(css.borderTopWidth) * scaleY;
    const borderRight = number(css.borderRightWidth) * scaleX;
    const borderBottom = number(css.borderBottomWidth) * scaleY;
    const paddingLeft = number(css.paddingLeft) * scaleX;
    const paddingTop = number(css.paddingTop) * scaleY;
    const paddingRight = number(css.paddingRight) * scaleX;
    const paddingBottom = number(css.paddingBottom) * scaleY;
    const boxLeft = outer.left + borderLeft + paddingLeft;
    const boxTop = outer.top + borderTop + paddingTop;
    const boxWidth = Math.max(1, outer.width - borderLeft - borderRight - paddingLeft - paddingRight);
    const boxHeight = Math.max(1, outer.height - borderTop - borderBottom - paddingTop - paddingBottom);
    const naturalWidth = Math.max(1, image.naturalWidth);
    const naturalHeight = Math.max(1, image.naturalHeight);
    const containScale = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
    let width = boxWidth;
    let height = boxHeight;

    switch (css.objectFit) {
      case "contain":
        width = naturalWidth * containScale;
        height = naturalHeight * containScale;
        break;
      case "cover": {
        const scale = Math.max(boxWidth / naturalWidth, boxHeight / naturalHeight);
        width = naturalWidth * scale;
        height = naturalHeight * scale;
        break;
      }
      case "none":
        width = naturalWidth;
        height = naturalHeight;
        break;
      case "scale-down": {
        const scale = Math.min(1, containScale);
        width = naturalWidth * scale;
        height = naturalHeight * scale;
        break;
      }
      default:
        break;
    }

    const position = resolveObjectPosition(
      css.objectPosition,
      boxWidth - width,
      boxHeight - height,
      scaleX,
      scaleY,
    );
    return {
      frameLeft: boxLeft,
      frameTop: boxTop,
      frameWidth: boxWidth,
      frameHeight: boxHeight,
      drawLeft: position.x,
      drawTop: position.y,
      drawWidth: width,
      drawHeight: height,
    };
  }

  function localPolygon(region) {
    if (!Array.isArray(region.polygon) || region.polygon.length < 3) return "none";
    const { x, y, width, height } = region.rect;
    if (!width || !height) return "none";
    const points = region.polygon.map((point) => {
      const localX = Math.max(0, Math.min(100, ((point[0] - x) / width) * 100));
      const localY = Math.max(0, Math.min(100, ((point[1] - y) / height) * 100));
      return `${localX.toFixed(2)}% ${localY.toFixed(2)}%`;
    });
    return `polygon(${points.join(", ")})`;
  }

  function fitText(regionElement) {
    const span = regionElement.firstElementChild;
    if (!(span instanceof HTMLElement)) return;
    const vertical = regionElement.dataset.orientation === "vertical";
    const width = regionElement.clientWidth;
    const height = regionElement.clientHeight;
    const fitKey = `${Math.round(width * 10)}|${Math.round(height * 10)}|${vertical ? "v" : "h"}|${span.textContent}`;
    if (regionElement.dataset.fitKey === fitKey) return;
    regionElement.dataset.fitKey = fitKey;
    let size = Math.min(34, Math.max(9, vertical ? width * 0.46 : height * 0.46));
    span.style.fontSize = `${size}px`;
    for (let attempts = 0; attempts < 30; attempts += 1) {
      if (span.scrollWidth <= regionElement.clientWidth && span.scrollHeight <= regionElement.clientHeight) break;
      size -= 1;
      if (size <= 8) break;
      span.style.fontSize = `${size}px`;
    }
  }

  function clearFrame() {
    cancelAnimationFrame(pendingFrame);
    pendingFrame = 0;
    frame?.remove();
    frame = null;
    lastMeasuredBox = "";
    stableMeasureFrames = 0;
  }

  function scheduleMeasure() {
    cancelAnimationFrame(pendingFrame);
    pendingFrame = requestAnimationFrame(measureFrame);
  }

  function invalidateSelectedMedia(reason) {
    if (!selectedImage) return;
    const image = selectedImage;
    const invalidatedImageId = imageId(image);
    selectionEpoch += 1;
    mediaRevision += 1;
    overlayRevision = 0;
    image.removeEventListener("load", scheduleMeasure);
    resizeObserver.unobserve(image);
    mutationObserver.disconnect();
    selectedImage = null;
    selectedSignature = "";
    clearFrame();
    void chrome.runtime.sendMessage({
      type: "PANELSHIFT_MEDIA_CHANGED",
      pageInstanceId,
      imageId: invalidatedImageId,
      mediaRevision,
      reason,
    });
  }

  function measureFrame() {
    pendingFrame = 0;
    if (!selectedImage) {
      clearFrame();
      return;
    }
    if (!selectedImage.isConnected) {
      invalidateSelectedMedia("image_removed");
      return;
    }
    const currentSignature = signature(selectedImage);
    if (currentSignature !== selectedSignature) {
      invalidateSelectedMedia("source_changed");
      return;
    }
    if (!frame) return;
    const box = drawnImageBox(selectedImage);
    if (!box) {
      const invalidatedImageId = imageId(selectedImage);
      clearFrame();
      void chrome.runtime.sendMessage({
        type: "PANELSHIFT_OVERLAY_INVALIDATED",
        pageInstanceId,
        imageId: invalidatedImageId,
        mediaRevision,
        reason: "non_axis_transform",
      });
      return;
    }
    const boxSignature = [
      box.frameLeft,
      box.frameTop,
      box.frameWidth,
      box.frameHeight,
      box.drawLeft,
      box.drawTop,
      box.drawWidth,
      box.drawHeight,
    ].map((value) => value.toFixed(2)).join("|");
    if (boxSignature === lastMeasuredBox) stableMeasureFrames += 1;
    else {
      lastMeasuredBox = boxSignature;
      stableMeasureFrames = 0;
    }
    Object.assign(frame.style, {
      left: `${box.frameLeft}px`,
      top: `${box.frameTop}px`,
      width: `${box.frameWidth}px`,
      height: `${box.frameHeight}px`,
      display: box.frameWidth > 0 && box.frameHeight > 0 ? "block" : "none",
    });
    for (const element of frame.querySelectorAll(".ps-region")) {
      const rect = JSON.parse(element.dataset.rect || "{}");
      Object.assign(element.style, {
        left: `${box.drawLeft + rect.x * box.drawWidth}px`,
        top: `${box.drawTop + rect.y * box.drawHeight}px`,
        width: `${rect.width * box.drawWidth}px`,
        height: `${rect.height * box.drawHeight}px`,
      });
      fitText(element);
    }
    const css = getComputedStyle(selectedImage);
    const transformMayAnimate = css.animationName !== "none"
      || css.transitionProperty.split(",").some((property) => {
        const value = property.trim();
        return value === "all" || value === "transform";
      });
    if (transformMayAnimate && (css.animationName !== "none" || stableMeasureFrames < 5)) {
      pendingFrame = requestAnimationFrame(measureFrame);
    }
  }

  function applyOverlays(payload) {
    if (!selectedImage || !payload) return { ok: false, code: "no_selection" };
    if (payload.pageInstanceId !== pageInstanceId
      || payload.imageId !== imageId(selectedImage)
      || payload.mediaRevision !== mediaRevision) {
      return { ok: false, code: "stale_selection" };
    }
    if (!Number.isFinite(payload.overlayRevision) || payload.overlayRevision < overlayRevision) {
      return { ok: false, code: "stale_overlay" };
    }
    if (payload.overlayRevision === overlayRevision) {
      return frame?.dataset.jobId === String(payload.jobId || "")
        ? { ok: true, idempotent: true }
        : { ok: false, code: "stale_overlay" };
    }
    if (!drawnImageBox(selectedImage)) {
      return { ok: false, code: "unsupported_transform" };
    }
    overlayRevision = payload.overlayRevision;
    clearFrame();
    frame = document.createElement("div");
    frame.className = "ps-frame";
    frame.dataset.jobId = String(payload.jobId || "");
    for (const region of payload.regions || []) {
      if (!region?.rect || !Number.isFinite(region.rect.x) || !Number.isFinite(region.rect.y)) continue;
      const element = document.createElement("div");
      element.className = "ps-region";
      element.dataset.orientation = region.orientation === "vertical" ? "vertical" : "horizontal";
      element.dataset.background = ["white", "translucent", "none"].includes(payload.background)
        ? payload.background
        : "white";
      element.dataset.rect = JSON.stringify(region.rect);
      const clipPath = localPolygon(region);
      if (clipPath !== "none") element.style.clipPath = clipPath;
      const span = document.createElement("span");
      span.textContent = region.translation || region.sourceText || "";
      element.append(span);
      frame.append(element);
    }
    shadow.append(frame);
    scheduleMeasure();
    return { ok: true };
  }

  const resizeObserver = new ResizeObserver(scheduleMeasure);
  const mutationObserver = new MutationObserver((records) => {
    if (!selectedImage) return;
    const picture = selectedImage.closest("picture");
    const relevant = records.some((record) => {
      if (record.type === "attributes") return true;
      if (!selectedImage?.isConnected || record.target === picture) return true;
      if (record.target instanceof Element && record.target.contains(selectedImage)) return true;
      return [...record.addedNodes, ...record.removedNodes].some((node) => (
        node === selectedImage
        || (node instanceof Element && node.contains(selectedImage))
      ));
    });
    if (relevant) scheduleMeasure();
  });

  function observeSelectedImage(image) {
    mutationObserver.disconnect();
    mutationObserver.observe(image, {
      attributes: true,
      attributeFilter: ["src", "srcset", "sizes", "style", "class", "hidden"],
    });
    const picture = image.closest("picture");
    if (picture) {
      mutationObserver.observe(picture, {
        attributes: true,
        subtree: true,
        attributeFilter: ["src", "srcset", "sizes", "media", "type", "style", "class"],
      });
    }
    for (let ancestor = image.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor === picture) continue;
      mutationObserver.observe(ancestor, {
        attributes: true,
        attributeFilter: ["style", "class", "hidden"],
      });
    }
    mutationObserver.observe(document, {
      childList: true,
      subtree: true,
    });
  }
  function onViewportChange() {
    scheduleMeasure();
    if (pickerActive && pointerX >= 0 && pointerY >= 0) {
      updateHover(imageAtPoint(pointerX, pointerY));
    }
  }

  window.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return undefined;
    if (message.type === "PANELSHIFT_START_PICKING") {
      sendResponse(startPicking());
      return undefined;
    }
    if (message.type === "PANELSHIFT_PING") {
      sendResponse({ ok: true, pageInstanceId });
      return undefined;
    }
    if (message.type === "PANELSHIFT_STOP_PICKING") {
      stopPicking(false);
      sendResponse({ ok: true });
      return undefined;
    }
    if (message.type === "PANELSHIFT_APPLY_OVERLAYS") {
      sendResponse(applyOverlays(message.payload));
      return undefined;
    }
    if (message.type === "PANELSHIFT_CLEAR_OVERLAYS") {
      clearFrame();
      sendResponse({ ok: true });
      return undefined;
    }
    if (message.type === "PANELSHIFT_GET_STATE") {
      sendResponse({
        ok: true,
        pageInstanceId,
        imageId: selectedImage ? imageId(selectedImage) : null,
        mediaRevision,
        hasOverlay: Boolean(frame),
      });
      return undefined;
    }
    return undefined;
  });

  Object.defineProperty(window, "__panelshiftContentBridge", {
    configurable: false,
    enumerable: false,
    value: { ping, startPicking },
  });
})();
