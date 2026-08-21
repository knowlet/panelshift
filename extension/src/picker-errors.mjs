export class PickerStartFailure extends Error {
  constructor(stage, cause) {
    super(cause instanceof Error ? cause.message : String(cause || stage));
    this.name = "PickerStartFailure";
    this.stage = stage;
  }
}

export function pickerFailureMessage(error, url) {
  if (url?.startsWith("chrome://") || url?.startsWith("chrome-extension://")) {
    return "Chrome 系統頁面不允許擴充套件選取圖片，請切到一般網頁。";
  }
  if (
    url?.startsWith("https://chrome.google.com/webstore")
    || url?.startsWith("https://chromewebstore.google.com")
  ) {
    return "Chrome 線上應用程式商店不允許頁面注入，請切到一般網頁。";
  }
  if (url?.startsWith("file:")) {
    return "若要讀取本機圖片，請先到擴充套件詳細資料開啟「允許存取檔案網址」。";
  }

  const stage = error instanceof PickerStartFailure ? error.stage : undefined;
  if (stage === "no-tab") return "找不到可使用的目前分頁，請切到一般網頁後再試一次。";
  if (stage === "validate") {
    return "頁面選圖程式版本不一致，請重新整理網頁後再點一次譯格工具列圖示。";
  }
  if (stage === "bridge") {
    return "頁面選圖程式沒有回應。若剛重新載入擴充套件，請重新整理網頁，再點一次譯格工具列圖示。";
  }

  const detail = error instanceof Error ? error.message : String(error || "");
  if (
    !url
    || /Cannot access contents|host permission|permission|not allowed/i.test(detail)
  ) {
    return "請在要翻譯的分頁點一次譯格工具列圖示，授權後面板會自動開啟。";
  }
  return "目前網站拒絕啟動選圖；請檢查譯格的「網站存取權」，重新整理頁面後再試一次。";
}
