import { test, expect } from "@playwright/test";
import { count, leaveWorkbench, openWorkbench, settle, startOcr, waitForStage } from "./workbench-mocks.mjs";

const pageErrors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const errors = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

test("navigation during OCR import never initializes a runner", async ({ page }) => {
  await openWorkbench(page, ["import"]);
  await startOcr(page);
  await waitForStage(page, "import");
  await leaveWorkbench(page);
  await settle(page, "import");
  expect(await count(page, "create")).toBe(0);
  expect(await count(page, "api")).toBe(0);
});

for (const cancel of ["navigate", "stop"]) {
  test(`${cancel} during OCR initialization disposes the late runner without prediction`, async ({ page }) => {
    await openWorkbench(page, ["create"]);
    await startOcr(page);
    await waitForStage(page, "create");
    if (cancel === "navigate") await leaveWorkbench(page);
    else await page.getByRole("button", { name: "停止處理" }).click();
    await settle(page, "create");
    expect(await count(page, "predict")).toBe(0);
    expect(await count(page, "dispose")).toBe(1);
    expect(await count(page, "create")).toBe(1);
    expect(await count(page, "api")).toBe(0);
  });
}

for (const fail of [false, true]) {
  test(`Stop then restart isolates a late OCR ${fail ? "rejection" : "success"}`, async ({ page }) => {
    await openWorkbench(page, ["predict"]);
    await startOcr(page);
    await waitForStage(page, "predict");
    await page.getByRole("button", { name: "停止處理" }).click();
    await page.getByRole("button", { name: "開始辨識" }).click();
    await waitForStage(page, "predict", 2);
    await settle(page, "predict", 0, fail);
    expect(await count(page, "dispose")).toBe(1);
    expect(await count(page, "api")).toBe(0);
    await settle(page, "predict", 1);
    await expect(page.locator(".processing-copy b")).toHaveText("校樣已就緒");
    await page.getByRole("button", { name: "重新辨識" }).click();
    await waitForStage(page, "predict", 3);
    expect(await count(page, "create")).toBe(2);
    await settle(page, "predict", 2);
    await leaveWorkbench(page);
    expect(await count(page, "dispose")).toBe(2);
  });
}

test("navigation destroys a late Chrome translator without sending it text", async ({ page }) => {
  await openWorkbench(page, ["chromeCreate"]);
  await startOcr(page, "chrome");
  await waitForStage(page, "chromeCreate");
  await leaveWorkbench(page);
  await settle(page, "chromeCreate");
  expect(await count(page, "destroy")).toBe(1);
  expect(await count(page, "translate")).toBe(0);
});

test("navigation while decoding an image does not create a late object URL", async ({ page }) => {
  await openWorkbench(page, ["image"]);
  await page.getByRole("button", { name: "載入示範頁", exact: true }).click();
  await waitForStage(page, "image");
  await leaveWorkbench(page);
  await settle(page, "image");
  expect(await count(page, "objectURL")).toBe(0);
});

test("navigation during OCR prediction never submits its late text to the API", async ({ page }) => {
  await openWorkbench(page, ["predict"]);
  await startOcr(page);
  await waitForStage(page, "predict");
  await leaveWorkbench(page);
  await settle(page, "predict");
  expect(await count(page, "api")).toBe(0);
  expect(await count(page, "dispose")).toBe(1);
});

for (const cancel of ["navigate", "stop"]) {
  test(`${cancel} aborts in-flight API translation without starting Chrome fallback`, async ({ page }) => {
    await openWorkbench(page, ["apiResponse"]);
    await startOcr(page);
    await waitForStage(page, "api");
    if (cancel === "navigate") await leaveWorkbench(page);
    else await page.getByRole("button", { name: "停止處理" }).click();
    await waitForStage(page, "apiAbort");
    await settle(page, "apiResponse", 0, true);
    expect(await count(page, "availability")).toBe(0);
    expect(await count(page, "chromeCreate")).toBe(0);
    if (cancel === "stop") await expect(page.locator(".processing-copy b")).toHaveText("已停止處理");
  });
}
