# 譯格 Panelshift — Chrome Extension

這個資料夾是現有圖片／漫畫翻譯網站的 Manifest V3 side panel 版本。它會在使用者點擊工具列圖示後，讓使用者從目前分頁選取一張圖片，再以 PP-OCRv5 辨識日文或英文、整理漫畫閱讀順序、翻譯並把譯文疊回原圖。

## 本機安裝

1. 在專案根目錄執行 `npm run build:extension`。
2. 開啟 `chrome://extensions`，打開「開發人員模式」。
3. 選擇「載入未封裝項目」，指定專案內的 `extension-dist` 資料夾。
4. 把「譯格 Panelshift」釘選到工具列，進入一般網頁後點一下圖示。

工具列圖示會在點擊當下授權並準備目前分頁，再自動開啟側邊面板。切換到不同網站或重新載入未封裝擴充套件後，請重新整理目標網頁並再點一次工具列圖示。

PP-OCRv5 偵測與辨識模型已包含在擴充功能中，第一次辨識不需要再向外部模型伺服器下載。

也可以使用 `artifacts/panelshift-chrome-extension.zip`；解壓縮後再以「載入未封裝項目」載入。

## 權限設計

- `activeTab`：只在使用者按下工具列圖示後暫時存取目前分頁。
- 內建模型：PP-OCRv5 的 ONNX 偵測與辨識模型、ONNX Runtime 都封裝在擴充套件內，不需要模型網域權限。
- OCR sandbox：Paddle 依賴的 OpenCV 需要動態執行程式，因此只在 Manifest 宣告的隔離頁面內執行；該頁面沒有 `chrome.*` API 或擴充套件儲存空間權限，只透過 `postMessage` 收發圖片位元組與 OCR 結果。
- 選用網站權限：跨網域圖片或 OpenAI 相容 API 需要讀取時，才針對實際網域向使用者詢問。
- API Key：只儲存在 `chrome.storage.local`，不會送到譯格自己的伺服器。

## 開發驗證

```sh
npm run build:extension
npm run test:extension
```

翻譯引擎預設為 Chrome Translator；它不一定在每個 Chrome 版本、語言組合或裝置上可用。若改選 OpenAI 相容 API，面板才會顯示 Base URL、API Key 與 Model 欄位，並可透過 `/models` 測試連線與載入可篩選的模型清單。兩種引擎都無法使用時仍會保留 OCR 結果供人工校對，不會在未告知的情況下自動切換服務。
