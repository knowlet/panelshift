const STORE_URL = "https://chromewebstore.google.com/detail/panelshift/dokfdbdcdiocconacblgcjdhipmjagnm";
const DOWNLOAD_URL = "/downloads/panelshift-chrome-extension-v0.1.3.zip";

export default function Home() {
  return (
    <div className="landing-page">
      <header className="landing-header">
        <div className="landing-wrap landing-header-inner">
          <a className="landing-brand" href="/" aria-label="譯格 Panelshift 首頁">
            <span className="landing-brand-glyph" aria-hidden="true">譯</span>
            <span>
              <b>譯格</b>
              <small>PANELSHIFT</small>
            </span>
          </a>

          <nav className="landing-nav" aria-label="主要導覽">
            <a href="#features">功能</a>
            <a href="#how-it-works">怎麼使用</a>
            <a href="#privacy">隱私方式</a>
            <a href="#install">安裝預覽版</a>
          </nav>

          <a className="landing-header-link" href={STORE_URL} target="_blank" rel="noreferrer">
            前往 Chrome 商店 <span aria-hidden="true">↗</span>
          </a>
        </div>
      </header>

      <main>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-wrap landing-hero-grid">
            <div className="landing-hero-copy">
              <p className="landing-eyebrow">
                漫畫翻譯 Chrome 擴充功能 <span aria-hidden="true">·</span> English・日本語 → 繁體中文
              </p>
              <h1 id="landing-title">把漫畫裡的英文與日文，直接翻成繁體中文。</h1>
              <p className="landing-lead">
                譯格 Panelshift 專門處理網頁漫畫與圖片：在目前分頁選取圖片，辨識氣泡裡的英文或日文，翻譯後貼回原圖位置，讓你不用跳出閱讀動線。
              </p>
              <div className="landing-actions">
                <a className="landing-button landing-button-primary" href={STORE_URL} target="_blank" rel="noreferrer">
                  從 Chrome 商店安裝 <span aria-hidden="true">↗</span>
                </a>
                <a className="landing-button landing-button-secondary" href="/try">
                  先試網頁版 <span aria-hidden="true">→</span>
                </a>
              </div>
              <p className="landing-compatibility">
                已上架 Chrome Web Store <span aria-hidden="true">·</span> Chrome 116+ <span aria-hidden="true">·</span> PP-OCRv5
              </p>
            </div>

            <figure className="landing-product-figure">
              <div className="landing-browser-demo" aria-hidden="true">
                <div className="landing-browser-bar">
                  <span />
                  <span />
                  <span />
                  <b>manga.example / chapter-15</b>
                </div>
                <div className="landing-browser-content">
                  <div className="landing-manga-page">
                    <div className="landing-manga-label">ORIGINAL PAGE</div>
                    <div className="landing-manga-panel landing-manga-panel-dark">
                      <span className="landing-japanese-copy">この先へ行くの？</span>
                      <span className="landing-translation-copy">還要繼續往前嗎？</span>
                    </div>
                    <div className="landing-manga-panel landing-manga-panel-light">
                      <span className="landing-english-copy">Don&apos;t look back.</span>
                      <span className="landing-translation-copy landing-translation-copy-low">不要回頭。</span>
                    </div>
                  </div>

                  <div className="landing-side-panel">
                    <div className="landing-side-heading">
                      <span className="landing-side-icon">譯</span>
                      <span><b>譯格</b><small>圖片翻譯</small></span>
                    </div>
                    <div className="landing-side-status"><i /> 已選取 1 張圖片</div>
                    <div className="landing-side-section">
                      <small>01　原文</small>
                      <b>日本語・English</b>
                    </div>
                    <div className="landing-side-section">
                      <small>02　翻譯引擎</small>
                      <b>Chrome Translator</b>
                    </div>
                    <div className="landing-side-result">
                      <small>辨識完成</small>
                      <span>03 個文字區塊</span>
                    </div>
                    <div className="landing-side-button">翻譯並貼回原圖</div>
                  </div>
                </div>
              </div>
              <figcaption>在側邊面板選圖，譯文會跟著原圖位置與縮放。</figcaption>
            </figure>
          </div>
        </section>

        <div className="landing-wrap landing-trust-row" aria-label="產品特色">
          <span><i aria-hidden="true" /> 圖片留在瀏覽器</span>
          <span><i aria-hidden="true" /> 日文直排</span>
          <span><i aria-hidden="true" /> 漫畫閱讀順序</span>
          <span><i aria-hidden="true" /> 譯文可校對</span>
        </div>

        <section className="landing-section landing-features" id="features" aria-labelledby="features-title">
          <div className="landing-wrap">
            <div className="landing-section-heading">
              <p className="landing-eyebrow">為漫畫而做</p>
              <h2 id="features-title">不是把圖片丟進翻譯器，而是把閱讀保留下來。</h2>
              <p>譯格把 OCR、漫畫版面理解、翻譯與原位覆蓋層串成一條流程，專注處理網頁上無法選取文字的漫畫圖片。</p>
            </div>

            <ul className="landing-feature-grid">
              <li>
                <span>01</span>
                <h3>選取頁面圖片</h3>
                <p>從 Chrome 側邊面板直接挑選漫畫頁或插圖，不必另存圖片，也不必複製圖片網址。</p>
              </li>
              <li>
                <span>02</span>
                <h3>PP-OCRv5 辨識英日文</h3>
                <p>在瀏覽器內完成文字偵測與英文、日文識別，保留每個文字區塊的 polygon 位置。</p>
              </li>
              <li>
                <span>03</span>
                <h3>讀懂漫畫版面</h3>
                <p>判斷橫排與直排，合併同一個氣泡的 boxes，並依右至左或左至右的閱讀順序整理內容。</p>
              </li>
              <li>
                <span>04</span>
                <h3>譯文貼回原位</h3>
                <p>支援 Chrome Translator 與 OpenAI 相容 API；DOM overlay 會跟著原圖縮放、移動與版面變化同步更新。</p>
              </li>
            </ul>
          </div>
        </section>

        <section className="landing-section" id="how-it-works" aria-labelledby="how-title">
          <div className="landing-wrap">
            <div className="landing-section-heading">
              <p className="landing-eyebrow">從畫面到譯文</p>
              <h2 id="how-title">三步，留在原本的閱讀動線。</h2>
              <p>不用另存圖片，也不用在翻譯網站之間來回切換。</p>
            </div>

            <ol className="landing-steps">
              <li>
                <span>01</span>
                <h3>打開漫畫頁</h3>
                <p>點一下工具列的譯格圖示，從側邊面板選取頁面中的圖片。</p>
              </li>
              <li>
                <span>02</span>
                <h3>一鍵辨識</h3>
                <p>PP-OCRv5 在瀏覽器內辨識英文或日文，判斷橫排、直排與閱讀順序。</p>
              </li>
              <li>
                <span>03</span>
                <h3>在原位閱讀</h3>
                <p>翻譯完成後，譯文會覆蓋在原圖位置；可校對、切換底色或隨時清除。</p>
              </li>
            </ol>
          </div>
        </section>

        <section className="landing-privacy" id="privacy" aria-labelledby="privacy-title">
          <div className="landing-wrap landing-privacy-grid">
            <div>
              <p className="landing-eyebrow">Privacy by design</p>
              <h2 id="privacy-title">看圖，留在你的瀏覽器裡。</h2>
            </div>
            <div className="landing-privacy-copy">
              <p>
                原始圖片不會上傳到譯格伺服器。PP-OCRv5 直接在瀏覽器內辨識；若使用 OpenAI 相容 API，只有辨識後的文字會傳送到你設定的翻譯服務。
              </p>
              <p>
                你也可以改用瀏覽器支援的 Chrome Translator，或選擇只做 OCR，讓辨識結果留在本機校對。
              </p>
              <dl>
                <div><dt>原始圖片</dt><dd>留在目前裝置</dd></div>
                <div><dt>OCR</dt><dd>瀏覽器內執行</dd></div>
                <div><dt>翻譯服務</dt><dd>由你選擇與設定</dd></div>
              </dl>
            </div>
          </div>
        </section>

        <section className="landing-section landing-install" id="install" aria-labelledby="install-title">
          <div className="landing-wrap landing-install-grid">
            <div className="landing-install-intro">
              <p className="landing-eyebrow">Chrome Web Store · Panelshift v0.1.3</p>
              <h2 id="install-title">安裝譯格，下一頁就能開始翻。</h2>
              <p>
                譯格 Panelshift 已上架 Chrome 線上應用程式商店。安裝後固定工具列圖示，打開漫畫頁就能從側邊面板選圖、辨識並翻譯。
              </p>
              <a className="landing-button landing-button-primary" href={STORE_URL} target="_blank" rel="noreferrer">
                開啟 Chrome 商店安裝 <span aria-hidden="true">↗</span>
              </a>
              <p className="landing-install-note">
                需要測試未上架版本？<a href={DOWNLOAD_URL} download>下載開發預覽版</a>。
              </p>
            </div>

            <ol className="landing-install-steps">
              <li>
                <span>1</span>
                <div><h3>開啟商店頁</h3><p>點擊「開啟 Chrome 商店安裝」，確認擴充功能名稱為「譯格 Panelshift」。</p></div>
              </li>
              <li>
                <span>2</span>
                <div><h3>安裝並固定</h3><p>按下「加到 Chrome」，再從工具列的擴充功能選單固定譯格圖示。</p></div>
              </li>
              <li>
                <span>3</span>
                <div><h3>打開漫畫開始翻譯</h3><p>點譯格圖示，在側邊面板選取圖片；辨識、翻譯與覆蓋層會留在目前分頁。</p></div>
              </li>
            </ol>
          </div>
        </section>

        <section className="landing-final-cta" aria-labelledby="final-cta-title">
          <div className="landing-wrap landing-final-inner">
            <div>
              <p className="landing-eyebrow">Panelshift</p>
              <h2 id="final-cta-title">下一頁，就用自己的語言讀。</h2>
              <p>譯格就是為漫畫翻譯而做：安裝 Chrome 擴充功能，或先用網頁版上傳一張圖片試試。</p>
            </div>
            <div className="landing-actions">
              <a className="landing-button landing-button-light" href={STORE_URL} target="_blank" rel="noreferrer">
                前往 Chrome 商店 <span aria-hidden="true">↗</span>
              </a>
              <a className="landing-button landing-button-outline-light" href="/try">
                開啟網頁版 <span aria-hidden="true">→</span>
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-wrap">
          <span>譯格 PANELSHIFT</span>
          <span>English・日本語 → 繁體中文</span>
          <nav aria-label="頁尾導覽">
            <a href={STORE_URL} target="_blank" rel="noreferrer">Chrome 線上商店</a>
            <a href="/privacy">隱私權政策</a>
            <a href="/support">支援與疑難排解</a>
            <a href="/try">網頁版翻譯工作台</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
