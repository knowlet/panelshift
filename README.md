# Panelshift 譯格

Panelshift is a Chrome extension and web app that translates English and Japanese text inside images and manga, then places the Traditional Chinese translation back over the original artwork. It is designed for the common moment when a reader can see a manga page in the browser but cannot select, copy, or translate any of its text.

**Extension site:** https://panelshift-manga-translator.knowlet.chatgpt.site

**Chrome Web Store:** https://chromewebstore.google.com/detail/panelshift/dokfdbdcdiocconacblgcjdhipmjagnm

**Web trial:** https://panelshift-manga-translator.knowlet.chatgpt.site/try

## What it does

1. Select an image on the current page from the Chrome side panel, or upload one in the web app.
2. Run PP-OCRv5 text detection and Japanese or English recognition in the browser.
3. Normalize polygons, infer horizontal versus vertical text, merge boxes that belong to one speech bubble, and sort them in manga reading order.
4. Translate the recognized regions with Chrome Translator by default, or explicitly choose an OpenAI-compatible API and model.
5. Render editable DOM overlays at the normalized text-region positions, including `vertical-rl` text, automatic font fitting, selectable backgrounds, and synchronized transforms when the source image resizes or moves.

Only OCR text is sent to the configured translation API. The source image stays in the browser.

## Chrome extension

The published Chrome extension is the primary Panelshift experience: it is made for translating manga and other image-based pages without leaving the current reading flow. Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/panelshift/dokfdbdcdiocconacblgcjdhipmjagnm), then pin Panelshift and select a page image from the side panel.

Requirements:

- Chrome 116 or newer
- A Chrome version that exposes the Translator API, or an optional OpenAI-compatible translation service

Build and load the extension:

```bash
npm install
npm run build:extension
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `extension-dist/`. Pin **Panelshift 譯格**, open a normal web page containing a manga or image, click the toolbar icon, and choose **Select page image**.

The build also creates `artifacts/panelshift-chrome-extension.zip`. The same installable archive is available from the extension site. Unzip it before loading it through Chrome's developer-mode flow.

## Web app

```bash
npm install
npm run dev
```

Open `/try` on the local URL shown by the development server, upload a PNG, JPEG, or WebP image, select English, Japanese, or automatic recognition, and run OCR.

## Architecture

```text
Image
  -> PP-OCRv5 detection and recognition
  -> polygon normalization
       -> horizontal / vertical inference
       -> speech-bubble box merging
       -> manga reading order
  -> selected translation engine
       -> Chrome Translator (default)
       -> OpenAI-compatible Chat Completions API (optional)
       -> OCR only
  -> synchronized DOM overlay
```

The extension uses Manifest V3, `activeTab`, a side panel, a service worker, and a dynamically injected content script. PaddleOCR's OpenCV dependency requires dynamic code evaluation, so OCR runs inside a manifest-declared sandbox that has no `chrome.*` APIs. The privileged extension pages keep a strict Content Security Policy and communicate with the sandbox using a narrow `postMessage` protocol. PP-OCRv5 model archives and ONNX Runtime are packaged with the extension, so OCR does not depend on a cross-origin model download.

## How Codex and GPT-5.6 were used

GPT-5.6 is one supported runtime translation model for the Build Week demo. Chrome Translator is the default engine. When the user explicitly selects an OpenAI-compatible service, Panelshift can load the service's `/models` list and sends ordered OCR text regions—not the image—with language, orientation, and line-break context to its Chat Completions endpoint. The prompt asks the selected model to preserve manga tone, names, sound effects, punctuation, and region order while producing natural Traditional Chinese.

Codex was the engineering partner for the project. It helped turn the original web experience into a production-oriented Chrome extension; implemented the side panel, service worker, least-privilege permissions, page image picker, responsive overlay geometry, and OCR sandbox; diagnosed the Manifest V3/OpenCV CSP conflict; designed the warm Nordic interface; and reviewed race conditions across image selection, cancellation, tab switching, scrolling, and DOM mutations. Codex also created the packaging workflow and the automated checks that verify CSP isolation, local executable assets, stale-result protection, bounded image fetches, and archive integrity.

Key decisions made with Codex included:

- keeping OCR local while sending only extracted text to GPT-5.6;
- requesting cross-origin permissions only for the exact image or API origin at the moment they are needed;
- isolating OpenCV's dynamic execution in a powerless sandbox instead of weakening privileged extension pages;
- treating vertical Japanese layout and manga reading order as first-class geometry rather than flattening OCR into plain text;
- preserving recognized text when translation is unavailable so the result remains editable and useful.

## Verification

```bash
npm run lint
npm run build:extension
npm run test:extension
npm test
npx playwright install --with-deps chromium
npm run test:browser
```

The extension tests statically verify the Manifest V3 permission surface, sandbox CSP boundary, packaged ONNX Runtime assets, page picker and overlay bridge, stale-result guards, and bounded cross-origin image fetching. The generated ZIP is also checked with `unzip -t artifacts/panelshift-chrome-extension.zip`.

Product CI runs these checks on pull requests to `develop` and pushes to `develop`. The browser suite uses the built production worker with a local test-only HTTP adapter and Chromium. It checks all eight home links, client-side navigation without a document reload, and repeated Back/Forward navigation. It blocks external requests and does not run OCR or call translation services. It does not deploy or publish extension archives.

## Main technologies

- Codex and GPT-5.6
- TypeScript, React, Vite, and vinext
- Chrome Manifest V3, Side Panel API, and Translator API
- PaddleOCR.js with PP-OCRv5
- ONNX Runtime Web and OpenCV.js
- DOM and Shadow DOM overlays

## Repository map

- `app/page.tsx` — extension introduction and installation page
- `app/try/page.tsx` — hosted web trial
- `extension/` — Chrome extension UI, sandbox, manifest, service worker, and content script
- `app/lib/manga.ts` — polygon normalization, bubble grouping, orientation, and reading order
- `build/build-extension.mjs` — reproducible unpacked-extension and ZIP packaging
- `tests/extension.test.mjs` — extension security and packaging checks
