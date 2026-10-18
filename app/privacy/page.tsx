import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "隱私權政策",
  description:
    "了解譯格 Panelshift 如何在瀏覽器內處理圖片、OCR 文字、翻譯設定與 OpenAI 相容 API 資料。",
};

const sections = [
  ["overview", "重點摘要"],
  ["processing", "處理哪些資料"],
  ["storage", "本機儲存"],
  ["providers", "翻譯服務"],
  ["permissions", "Chrome 權限"],
  ["retention", "保留與刪除"],
  ["limited-use", "資料使用承諾"],
] as const;

export default function PrivacyPage() {
  return (
    <div className="landing-page info-page">
      <header className="landing-header">
        <div className="landing-wrap landing-header-inner">
          <Link className="landing-brand" href="/" aria-label="譯格 Panelshift 首頁">
            <span className="landing-brand-glyph" aria-hidden="true">譯</span>
            <span>
              <b>譯格</b>
              <small>PANELSHIFT</small>
            </span>
          </Link>

          <nav className="info-header-nav" aria-label="政策頁導覽">
            <a aria-current="page" href="/privacy">隱私權</a>
            <a href="/support">支援</a>
          </nav>

          <Link className="landing-header-link" href="/">
            回到首頁
          </Link>
        </div>
      </header>

      <main className="info-main">
        <section className="info-hero" aria-labelledby="privacy-title">
          <div className="landing-wrap info-hero-grid">
            <div>
              <p className="landing-eyebrow">Privacy policy</p>
              <h1 id="privacy-title">隱私，是功能設計的一部分。</h1>
            </div>
            <div className="info-hero-copy">
              <p>
                譯格的圖片辨識在瀏覽器內完成。我們不經營圖片上傳伺服器；只有當你主動選用 OpenAI 相容 API，辨識後的文字才會傳送到你指定的服務。
              </p>
              <p className="info-updated">生效日期：2026 年 7 月 16 日</p>
            </div>
          </div>
        </section>

        <div className="landing-wrap info-layout">
          <aside className="info-toc" aria-label="本頁目錄">
            <p>本頁內容</p>
            <nav>
              {sections.map(([id, label], index) => (
                <a href={`#${id}`} key={id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>{label}
                </a>
              ))}
            </nav>
          </aside>

          <article className="info-document">
            <section className="info-section" id="overview">
              <p className="info-kicker">01 — 重點摘要</p>
              <h2>圖片留在你的裝置；傳不傳文字，由你決定。</h2>
              <div className="info-summary-grid">
                <div>
                  <span>原始圖片</span>
                  <strong>瀏覽器內處理</strong>
                  <p>圖片像素供 PP-OCRv5 辨識，不會上傳到譯格自有伺服器。</p>
                </div>
                <div>
                  <span>翻譯文字</span>
                  <strong>依引擎決定</strong>
                  <p>Chrome Translator 在 Chrome 提供的環境內執行；相容 API 只在你選用時連線。</p>
                </div>
                <div>
                  <span>商業用途</span>
                  <strong>不販售、不追蹤</strong>
                  <p>不出售個人資料，不用於廣告、跨網站追蹤或建立使用者輪廓。</p>
                </div>
              </div>
            </section>

            <section className="info-section" id="processing">
              <p className="info-kicker">02 — 處理哪些資料</p>
              <h2>只處理完成圖片翻譯所需的內容。</h2>
              <ul>
                <li><strong>選取的網頁內容：</strong>你主動選取的圖片、圖片網址，以及從圖片辨識出的英文或日文文字。</li>
                <li><strong>翻譯工作內容：</strong>OCR 文字、語言、橫排或直排方向，以及產生的繁體中文譯文與疊圖位置。</li>
                <li><strong>相容 API 設定：</strong>Base URL、API Key 與模型名稱；模型列表連線測試只保留在目前側邊面板工作階段。</li>
                <li><strong>目前分頁資訊：</strong>只有在你點擊工具列圖示並操作譯格時，才用於選圖、定位與顯示譯文。</li>
              </ul>
              <p className="info-note">
                譯格不會在背景讀取瀏覽紀錄，也不會擷取你未選取的表單、密碼或頁面文字。
              </p>
            </section>

            <section className="info-section" id="storage">
              <p className="info-kicker">03 — 本機儲存</p>
              <h2>設定存在 Chrome，不會同步到譯格伺服器。</h2>
              <p>
                擴充功能使用 <code>chrome.storage.local</code> 保存你輸入的 Base URL、API Key 與模型名稱，方便下次使用。API Key 不會傳給譯格，只會在你執行連線測試或翻譯時，作為 Authorization 標頭送往你設定的 API 網域。
              </p>
              <p>
                網頁試用版的相容 API 設定只保存在該分頁的 <code>sessionStorage</code>，通常會在關閉分頁後清除。OCR 模型、圖片與譯文覆蓋層則只在瀏覽器本機執行或暫存。
              </p>
            </section>

            <section className="info-section" id="providers">
              <p className="info-kicker">04 — 翻譯服務</p>
              <h2>外部傳輸只發生在你明確選擇之後。</h2>
              <h3>Chrome Translator</h3>
              <p>
                這是預設翻譯引擎。文字由 Chrome 內建 Translator API 處理，不會傳送到你設定的 OpenAI 相容 API；Chrome 可能依其產品機制下載必要的語言模型。
              </p>
              <h3>OpenAI 相容 API</h3>
              <p>
                選用後，譯格會把 OCR 文字、來源語言、文字方向與翻譯指示送到你填寫的 <code>/chat/completions</code> 端點，並以你指定的模型產生譯文。按下連線測試時，會向同一 Base URL 的 <code>/models</code> 讀取模型 ID 清單。
              </p>
              <p>
                外部服務收到的內容、API Key、保留時間及後續使用方式，受該服務自己的隱私政策與合約約束。請只使用你信任且有權使用的服務。
              </p>
            </section>

            <section className="info-section" id="permissions">
              <p className="info-kicker">05 — Chrome 權限</p>
              <h2>權限在你操作時，才用來完成眼前的工作。</h2>
              <dl className="info-definition-list">
                <div><dt>activeTab</dt><dd>點擊譯格工具列圖示後，存取目前分頁以選取圖片與呈現譯文。</dd></div>
                <div><dt>scripting</dt><dd>在目前分頁加入選圖介面與 DOM 翻譯覆蓋層。</dd></div>
                <div><dt>sidePanel</dt><dd>顯示辨識、翻譯、校對與設定介面。</dd></div>
                <div><dt>storage</dt><dd>在本機保存你主動設定的相容 API 資訊。</dd></div>
                <div><dt>選用網站存取</dt><dd>只在需要讀取跨網域圖片或連線到你指定的 API 網域時提出；遠端 API 必須使用 HTTPS，本機服務才可使用 HTTP。</dd></div>
              </dl>
            </section>

            <section className="info-section" id="retention">
              <p className="info-kicker">06 — 保留與刪除</p>
              <h2>你可以從裝置上清除所有譯格資料。</h2>
              <ul>
                <li>API 設定會保留在本機，直到你清除擴充功能資料或解除安裝譯格。</li>
                <li>模型列表只保留在目前側邊面板工作階段；重新開啟後需再次載入。</li>
                <li>圖片、OCR 結果與覆蓋層不會由譯格伺服器保留；清除覆蓋層、重新整理或關閉分頁即可移除。</li>
                <li>使用相容 API 時，外部服務的保留與刪除規則由該服務決定，請向服務供應者提出資料刪除要求。</li>
              </ul>
            </section>

            <section className="info-section" id="limited-use">
              <p className="info-kicker">07 — 資料使用承諾</p>
              <h2>只為提供、維護與保護圖片翻譯功能。</h2>
              <p>
                譯格不含廣告、分析追蹤器或遙測，不出售或出租使用者資料，也不把資料用於信用、保險、招聘、廣告投放或其他與核心功能無關的目的。官方網站主機可能為安全與內容傳遞處理一般技術請求紀錄，但本站不以此建立個人輪廓。
              </p>
              <p>
                譯格對 Chrome API 取得的使用者資料之使用，遵守 Chrome Web Store User Data Policy，包括其中的 Limited Use（有限使用）要求。
              </p>
              <h3>安全、變更與聯絡</h3>
              <p>
                我們以最小權限、本機處理與僅限 HTTPS 的遠端 API 降低風險，但任何本機儲存或外部服務都無法保證絕對安全。若政策有重大變更，會更新本頁與生效日期。隱私問題請前往<a href="/support">支援與疑難排解</a>；商店上架後，也可透過 Chrome Web Store 項目頁的支援管道聯絡開發者。
              </p>
            </section>
          </article>
        </div>
      </main>

      <footer className="landing-footer info-footer">
        <div className="landing-wrap">
          <span>譯格 PANELSHIFT</span>
          <span>圖片留在瀏覽器，傳輸由你決定。</span>
          <nav aria-label="頁尾導覽">
            <Link href="/">首頁</Link>
            <a href="/support">支援</a>
            <a href="/try">網頁版</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
