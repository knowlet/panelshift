import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/lib/manga.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { buildTranslationRegions } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

const box = (x, y, width, height, text = "Synthetic text") => ({
  poly: [[x, y], [x + width, y], [x + width, y + height], [x, y + height]],
  text,
  score: 0.99,
});
const regions = (items, width, height, language = "auto") =>
  buildTranslationRegions(items, width, height, language, "auto");

for (const [imageWidth, imageHeight] of [[1000, 1000], [100, 1000], [1000, 100]]) {
  for (const language of ["auto", "ja", "en"]) {
    test(`pixel aspect determines orientation on ${imageWidth}x${imageHeight} (${language})`, () => {
      assert.equal(regions([box(20, 20, 20, 40)], imageWidth, imageHeight, language)[0].orientation, "vertical");
      assert.equal(regions([box(20, 20, 40, 20)], imageWidth, imageHeight, language)[0].orientation, "horizontal");
    });

    test(`near-square pixel boxes retain the language fallback on ${imageWidth}x${imageHeight} (${language})`, () => {
      const expected = language === "en" ? "horizontal" : "vertical";
      for (const [width, height] of [[20, 20], [20, 24.2], [24.2, 20]]) {
        assert.equal(regions([box(20, 20, width, height)], imageWidth, imageHeight, language)[0].orientation, expected);
      }
    });
  }
}

test("portrait-page vertical columns merge right to left with line breaks", () => {
  const result = regions([
    box(20, 20, 10, 20, "左"),
    box(32, 20, 10, 20, "右"),
  ], 100, 1000, "ja");
  assert.equal(result.length, 1);
  assert.equal(result[0].orientation, "vertical");
  assert.equal(result[0].sourceText, "右\n左");
});

test("landscape-page horizontal lines merge top to bottom with spaces", () => {
  const result = regions([
    box(20, 32, 20, 10, "Second"),
    box(20, 20, 20, 10, "First"),
  ], 1000, 100, "en");
  assert.equal(result.length, 1);
  assert.equal(result[0].orientation, "horizontal");
  assert.equal(result[0].sourceText, "First Second");
});

test("orientation uses clipped pixel bounds while output stays normalized", () => {
  const [region] = regions([box(-80, 20, 100, 40)], 100, 1000, "en");
  assert.equal(region.orientation, "vertical");
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
  for (const [key, value] of Object.entries({ x: 0, y: 0.016, width: 0.204, height: 0.048 })) {
    close(region.rect[key], value);
  }
  const expectedPolygon = [[0, 0.016], [0.204, 0.016], [0.204, 0.064], [0, 0.064]];
  region.polygon.forEach(([x, y], index) => {
    close(x, expectedPolygon[index][0]);
    close(y, expectedPolygon[index][1]);
  });
});

test("orientation survives uniform scaling of the image and its OCR polygons", () => {
  const item = box(20, 20, 20, 40);
  const scaled = { ...item, poly: item.poly.map(([x, y]) => [x * 3, y * 3]) };
  assert.deepEqual(regions([scaled], 300, 3000), regions([item], 100, 1000));
});
