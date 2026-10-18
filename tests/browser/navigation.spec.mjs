import { test, expect } from "@playwright/test";

const routes = [
  ["/", 1, "譯格 Panelshift 首頁", "把漫畫裡的英文與日文，直接翻成繁體中文。"],
  ["/try", 1, "返回譯格 Panelshift 首頁", /^放入一張圖片，\s*開始翻譯$/],
  ["/privacy", 3, "譯格 Panelshift 首頁", "隱私，是功能設計的一部分。"],
  ["/support", 3, "譯格 Panelshift 首頁", "先看狀態，再找原因。"],
];

for (const [route, count, brandLabel, content] of routes) {
  for (let index = 0; index < count; index += 1) {
    test(`${route} home anchor ${index + 1}: hydrated click and browser history`, async ({ page }) => {
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // Keep the regression entirely local; OCR/model and third-party traffic
      // must not be required for basic navigation to work.
      await page.route("**/*", (request) => new URL(request.request().url()).origin === "http://127.0.0.1:4173"
        ? request.continue() : request.abort());
      await page.goto(route);
      await page.waitForFunction(() => typeof window.__VINEXT_RSC_NAVIGATE__ === "function");
      const homeLinks = page.locator('a[href="/"]');
      await expect(homeLinks).toHaveCount(count);
      await expect(page.getByRole("heading", { name: content, level: 1, exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: brandLabel, exact: true })).toBeVisible();
      // The sentinel must survive client-side navigation, proving the test did
      // not merely follow a server-rendered anchor through a document reload.
      await page.evaluate(() => { window.__panelshiftNavigationSentinel = "hydrated"; });
      await homeLinks.nth(index).click();
      await expect(page).toHaveURL("/");
      await expect(page.locator(".landing-brand")).toBeVisible();
      expect(await page.evaluate(() => window.__panelshiftNavigationSentinel)).toBe("hydrated");
      if (route !== "/") {
        await page.goBack();
        await expect(page).toHaveURL(route);
        await expect(page.getByRole("heading", { name: content, level: 1, exact: true })).toBeVisible();
        await expect(page.locator('a[href="/"]')).toHaveCount(count);
        await page.goForward();
        await expect(page).toHaveURL("/");
        await expect(page.locator(".landing-brand")).toBeVisible();
        expect(await page.evaluate(() => window.__panelshiftNavigationSentinel)).toBe("hydrated");
        // Repeating the history cycle catches stale or duplicate route entries.
        await page.goBack();
        await expect(page).toHaveURL(route);
        await expect(page.getByRole("heading", { name: content, level: 1, exact: true })).toBeVisible();
        await page.goForward();
        await expect(page).toHaveURL("/");
      }
      expect(errors).toEqual([]);
    });
  }
}
