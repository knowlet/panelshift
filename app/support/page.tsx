import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "支援與疑難排解",
  description:
    "譯格 Panelshift 安裝、圖片選取、PP-OCRv5、翻譯引擎、連線測試與 DOM 覆蓋層疑難排解。",
};

const connectionErrors = [
  ["400", "請求格式或 Base URL 不正確", "確認 Base URL 包含服務要求的 API 版本路徑，例如 /v1；不要再手動加上 /models。"],
  ["401", "API Key 缺少或無效", "重新貼上完整金鑰，並確認金鑰屬於目前填寫的服務。"],
  ["403", "帳號或模型沒有權限", "檢查金鑰所屬的帳號、組織、專案與模型權限。"],
  ["404", "找不到 Models API", "服務可能沒有提供 /models，或 Base URL 不正確；仍可手動輸入 Model 後儲存。"],
  ["408 / 504", "服務端逾時", "上游服務未及時完成請求；稍後再試，並確認本機或遠端服務仍在運作。"],
  ["429", "速率或額度已達上限", "檢查用量、帳務與速率限制，或等待限制解除。"],
  ["5xx", "相容 API 服務暫時異常", "這是服務端錯誤；查看供應者狀態，稍後再試。"],
] as const;

export default function SupportPage() {
  return (
    <div className="landing-page info-page">
      <header className="landing-header">
        <div className="landing-wrap landing-header-inner">
          <a className="landing-brand" href="/" aria-label="譯格 Panelshift 首頁">
            <span className="landing-brand-glyph" aria-hidden="true">譯</span>
            <span>
              <b>譯格</b>
              <small>PANELSHIFT</small>
            </span>
          </a>

          <nav className="info-header-nav" aria-label="支援頁導覽">
            <a href="/privacy">隱私權</a>
            <a aria-current="page" href="/support">支援</a>
          </nav>

          <a className="landing-header-link" href="/">
            回到首頁
          </a>
        </div>
      </header>

      <main className="info-main">
        <section className="info-hero" aria-labelledby="support-title">
          <div className="landing-wrap info-hero-grid">
            <div>
              <p className="landing-eyebrow">Support desk</p>
              <h1 id="support-title">先看狀態，再找原因。</h1>
            </div>
            <div className="info-hero-copy">
              <p>
                從選圖、OCR 到翻譯連線，這裡整理每一步最常見的阻礙與可直接採取的處理方式。
              </p>
              <p className="info-updated">適用版本：Chrome 擴充功能 v0.1.3</p>
            </div>
          </div>
        </section>

        <div className="landing-wrap info-layout">
          <aside className="info-toc" aria-label="本頁目錄">
            <p>快速前往</p>
            <nav>
              <a href="#quick-start"><span>01</span>安裝與開始</a>
              <a href="#select-image"><span>02</span>選取圖片</a>
              <a href="#ocr"><span>03</span>OCR 辨識</a>
              <a href="#translation"><span>04</span>翻譯引擎</a>
              <a href="#connection"><span>05</span>連線錯誤</a>
              <a href="#overlay"><span>06</span>譯文覆蓋</a>
              <a href="#contact"><span>07</span>仍需協助</a>
            </nav>
          </aside>

          <article className="info-document">
            <section className="info-section" id="quick-start">
              <p className="info-kicker">01 — 安裝與開始</p>
              <h2>完成安裝後，在要翻譯的分頁開啟譯格。</h2>
              <ol>
                <li>Chrome 116 或更新版本可使用譯格；若要使用預設的 Chrome Translator，請更新到桌面版 Chrome 138 或更新版本。</li>
                <li>打開含有英文或日文圖片的普通網頁，再點一下工具列的譯格圖示。</li>
                <li>側邊面板開啟後，按「選取網頁圖片」，點選頁面上的漫畫或圖片。</li>
                <li>選擇來源語言與翻譯引擎，開始辨識並把譯文貼回原圖。</li>
              </ol>
              <p className="info-note">
                Chrome 內建頁面（例如 <code>chrome://</code>）、Chrome Web Store 與部分受保護頁面不允許擴充功能注入選圖工具，請改在一般網頁測試。
              </p>
            </section>

            <section className="info-section" id="select-image">
              <p className="info-kicker">02 — 選取圖片</p>
              <h2>看到「分頁尚未授權」或讀不到圖片。</h2>
              <ul>
                <li><strong>先授權目前分頁：</strong>切回要翻譯的分頁，再點一次工具列的譯格圖示。</li>
                <li><strong>允許圖片網域：</strong>圖片若由另一個網域提供，Chrome 會要求額外網站存取權；允許後再選一次。</li>
                <li><strong>確認圖片已載入：</strong>先捲動到圖片實際顯示的位置；延遲載入圖片要等清晰內容出現後再選。</li>
                <li><strong>避開暫時網址：</strong>若圖片連結已過期或需要網站登入，重新整理原頁並確認你仍能直接看到圖片。</li>
              </ul>
              <p>
                若錯誤訊息提到 CORS，通常是圖片來源禁止跨網域讀取。譯格會在需要時請求該圖片網域權限；若網站仍拒絕，請改用網頁試用版手動上傳你有權處理的圖片。
              </p>
            </section>

            <section className="info-section" id="ocr">
              <p className="info-kicker">03 — PP-OCRv5 辨識</p>
              <h2>模型已隨擴充功能封裝，不需要另外下載。</h2>
              <p>
                第一次辨識會載入本機模型，可能比之後稍慢。若顯示「PP-OCRv5 無法完成辨識」，請重新載入擴充功能、重新開啟側邊面板並再試一次；也請確認裝置有足夠記憶體，且圖片不是損壞或極端尺寸。
              </p>
              <ul>
                <li>日文漫畫請選「日本語」，英文圖片選「English」；自動判斷不準時可明確指定。</li>
                <li>低解析、強烈透視、描邊字、手寫字與文字貼近背景時，辨識率可能下降。</li>
                <li>完成後可在校對區直接修改 OCR 原文或譯文，再更新覆蓋層。</li>
              </ul>
            </section>

            <section className="info-section" id="translation">
              <p className="info-kicker">04 — 翻譯引擎</p>
              <h2>預設使用 Chrome Translator；相容 API 需主動設定。</h2>
              <h3>Chrome Translator</h3>
              <p>
                不需要 API Key。Translator API 自桌面版 Chrome 138 起穩定提供；若顯示瀏覽器不支援，請更新 Chrome。部分語言組合可能需要 Chrome 先下載翻譯模型。Chrome Translator 無法使用時，OCR 原文仍會保留供你校對。
              </p>
              <h3>OpenAI 相容 API</h3>
              <p>
                選擇此引擎後才會顯示 Base URL、API Key 與 Model 欄位。Base URL 請填到 API 版本層級，例如 <code>https://api.openai.com/v1</code>；譯格會自行加上 <code>/models</code> 與 <code>/chat/completions</code>。
              </p>
              <p>
                按「測試連線並載入模型」後，Model 欄位會在成功取得清單時成為可輸入、可篩選的選單。未提供 Models API 的服務仍可手動輸入模型名稱。
              </p>
            </section>

            <section className="info-section" id="connection">
              <p className="info-kicker">05 — 連線錯誤</p>
              <h2>依狀態碼修正，不必猜是哪一欄。</h2>
              <div className="info-error-list" aria-label="API 連線錯誤對照表">
                {connectionErrors.map(([code, title, detail]) => (
                  <div className="info-error-row" key={code}>
                    <code>{code}</code>
                    <div>
                      <strong>{title}</strong>
                      <p>{detail}</p>
                    </div>
                  </div>
                ))}
              </div>

              <h3>沒有狀態碼的錯誤</h3>
              <dl className="info-definition-list">
                <div><dt>連線逾時</dt><dd>15 秒內沒有回應。確認網址、DNS、TLS 憑證與服務狀態；本機 API 也要先啟動。</dd></div>
                <div><dt>Network / CORS</dt><dd>檢查網路、憑證與服務端 CORS 設定，並確認已允許譯格存取 API 網域。遠端服務必須使用 HTTPS；只有 localhost、127.0.0.1 或 ::1 可用 HTTP。</dd></div>
                <div><dt>無效 JSON</dt><dd>端點有回應，但不是有效 JSON。確認 Base URL 指向 OpenAI 相容 API，而不是登入頁、代理首頁或一般網站。</dd></div>
                <div><dt>模型格式不相容</dt><dd>Models API 回應必須含有 <code>data</code> 陣列，且每個模型要有字串 <code>id</code>。</dd></div>
                <div><dt>空模型清單</dt><dd>連線成功，但 <code>data</code> 是空陣列；直接在 Model 欄手動輸入供應者提供的模型 ID。</dd></div>
              </dl>
            </section>

            <section className="info-section" id="overlay">
              <p className="info-kicker">06 — 譯文覆蓋</p>
              <h2>位置或字級不合適時，先讓頁面完成排版。</h2>
              <ul>
                <li>等圖片與頁面字型載入完成後再選圖，避免網站後續排版讓位置偏移。</li>
                <li>原圖縮放時，譯格會同步更新覆蓋層；若網站用特殊動畫搬動圖片，請清除後重新選取。</li>
                <li>直排日文會使用直排顯示；狹窄氣泡可在校對區縮短譯文，改善自動字體縮放。</li>
                <li>按「清除覆蓋層」或重新整理目前分頁，即可移除所有貼回原圖的譯文。</li>
              </ul>
            </section>

            <section className="info-section" id="contact">
              <p className="info-kicker">07 — 仍需協助</p>
              <h2>帶著可重現資訊，問題會更快被定位。</h2>
              <p>
                請記下 Chrome 版本、譯格版本、發生步驟、畫面上的完整錯誤標題與狀態碼；不要貼出 API Key、Authorization 標頭或含私人內容的圖片。商店上架後，可從 Chrome Web Store 的譯格項目頁使用支援／聯絡開發人員管道回報。
              </p>
              <div className="info-actions">
                <a className="landing-button landing-button-secondary" href="/privacy">閱讀隱私權政策</a>
                <a className="landing-button landing-button-primary" href="/try">用網頁版測試</a>
              </div>
            </section>
          </article>
        </div>
      </main>

      <footer className="landing-footer info-footer">
        <div className="landing-wrap">
          <span>譯格 PANELSHIFT</span>
          <span>English・日本語 → 繁體中文</span>
          <nav aria-label="頁尾導覽">
            <a href="/">首頁</a>
            <a href="/privacy">隱私權</a>
            <a href="/try">網頁版</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
