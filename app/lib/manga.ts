export type Point = readonly [number, number];

export type SourceLanguage = "auto" | "ja" | "en";
export type ReadingOrder = "auto" | "rtl" | "ltr";
export type Orientation = "horizontal" | "vertical";

export interface RawOcrItem {
  poly: Point[];
  text: string;
  score: number;
}

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TranslationRegion {
  id: string;
  sourceText: string;
  translation: string;
  score: number;
  orientation: Orientation;
  rect: NormalizedRect;
  polygon: Point[];
  sourceLanguage: "ja" | "en";
  mergeConfidence: number;
}

interface NormalizedItem extends RawOcrItem {
  id: string;
  rect: NormalizedRect;
  polygon: Point[];
  orientation: Orientation;
}

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

function intervalGap(a0: number, a1: number, b0: number, b1: number) {
  return Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));
}

function intervalOverlap(a0: number, a1: number, b0: number, b1: number) {
  const overlap = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  return overlap / Math.max(0.000001, Math.min(a1 - a0, b1 - b0));
}

function boundsFromPoints(points: Point[]): NormalizedRect | null {
  if (points.length < 3) return null;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  if (x1 - x0 < 0.0005 || y1 - y0 < 0.0005) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function inferOrientation(
  rect: NormalizedRect,
  language: SourceLanguage,
): Orientation {
  if (rect.height >= rect.width * 1.22) return "vertical";
  if (rect.width >= rect.height * 1.22) return "horizontal";
  return language === "en" ? "horizontal" : "vertical";
}

export function detectTextLanguage(text: string): "ja" | "en" {
  return /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u9fff]/u.test(text)
    ? "ja"
    : "en";
}

function normalizeItem(
  item: RawOcrItem,
  index: number,
  imageWidth: number,
  imageHeight: number,
  language: SourceLanguage,
): NormalizedItem | null {
  if (!item.text.trim() || !Number.isFinite(item.score)) return null;

  const polygon = item.poly
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    .map(
      ([x, y]) =>
        [clamp(x / imageWidth), clamp(y / imageHeight)] as Point,
    );
  const rect = boundsFromPoints(polygon);
  if (!rect) return null;

  return {
    ...item,
    text: item.text.trim(),
    score: clamp(item.score),
    id: `ocr-${String(index + 1).padStart(3, "0")}`,
    rect,
    polygon,
    orientation: inferOrientation(rect, language),
  };
}

function pairScore(a: NormalizedItem, b: NormalizedItem) {
  if (a.orientation !== b.orientation) return -1;

  if (a.orientation === "horizontal") {
    const gap = intervalGap(
      a.rect.y,
      a.rect.y + a.rect.height,
      b.rect.y,
      b.rect.y + b.rect.height,
    );
    const overlap = intervalOverlap(
      a.rect.x,
      a.rect.x + a.rect.width,
      b.rect.x,
      b.rect.x + b.rect.width,
    );
    const maxGap = Math.max(0.012, Math.min(0.055, 1.25 * Math.max(a.rect.height, b.rect.height)));
    const scaleRatio = Math.max(a.rect.height, b.rect.height) /
      Math.max(0.0001, Math.min(a.rect.height, b.rect.height));
    if (gap > maxGap || scaleRatio > 1.9) return -1;
    const centerDelta = Math.abs(
      a.rect.x + a.rect.width / 2 - (b.rect.x + b.rect.width / 2),
    );
    const aligned = overlap >= 0.16 || centerDelta <= Math.max(a.rect.width, b.rect.width) * 0.58;
    return aligned ? 0.6 * (1 - gap / maxGap) + 0.4 * Math.min(1, overlap + 0.2) : -1;
  }

  const gap = intervalGap(
    a.rect.x,
    a.rect.x + a.rect.width,
    b.rect.x,
    b.rect.x + b.rect.width,
  );
  const overlap = intervalOverlap(
    a.rect.y,
    a.rect.y + a.rect.height,
    b.rect.y,
    b.rect.y + b.rect.height,
  );
  const maxGap = Math.max(0.012, Math.min(0.055, 1.3 * Math.max(a.rect.width, b.rect.width)));
  const scaleRatio = Math.max(a.rect.width, b.rect.width) /
    Math.max(0.0001, Math.min(a.rect.width, b.rect.width));
  if (gap > maxGap || scaleRatio > 1.9) return -1;
  const centerDelta = Math.abs(
    a.rect.y + a.rect.height / 2 - (b.rect.y + b.rect.height / 2),
  );
  const aligned = overlap >= 0.16 || centerDelta <= Math.max(a.rect.height, b.rect.height) * 0.58;
  return aligned ? 0.6 * (1 - gap / maxGap) + 0.4 * Math.min(1, overlap + 0.2) : -1;
}

function mergedRect(items: NormalizedItem[]): NormalizedRect {
  const x = Math.min(...items.map((item) => item.rect.x));
  const y = Math.min(...items.map((item) => item.rect.y));
  const right = Math.max(...items.map((item) => item.rect.x + item.rect.width));
  const bottom = Math.max(...items.map((item) => item.rect.y + item.rect.height));
  const pad = 0.004;
  return {
    x: clamp(x - pad),
    y: clamp(y - pad),
    width: clamp(right + pad) - clamp(x - pad),
    height: clamp(bottom + pad) - clamp(y - pad),
  };
}

function localPolygon(rect: NormalizedRect): Point[] {
  return [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x + rect.width, rect.y + rect.height],
    [rect.x, rect.y + rect.height],
  ];
}

function clusterItems(items: NormalizedItem[]) {
  const parent = items.map((_, index) => index);
  const find = (value: number): number => {
    if (parent[value] !== value) parent[value] = find(parent[value]);
    return parent[value];
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  const edges: Array<{ a: number; b: number; score: number }> = [];
  for (let a = 0; a < items.length; a += 1) {
    for (let b = a + 1; b < items.length; b += 1) {
      const score = pairScore(items[a], items[b]);
      if (score >= 0.36) edges.push({ a, b, score });
    }
  }

  edges
    .sort((left, right) => right.score - left.score || left.a - right.a || left.b - right.b)
    .forEach(({ a, b }) => {
      const members = items.filter((_, index) => {
        const root = find(index);
        return root === find(a) || root === find(b);
      });
      const rect = mergedRect(members);
      const span = items[a].orientation === "horizontal" ? rect.height : rect.width;
      if (span <= 0.38) union(a, b);
    });

  const groups = new Map<number, NormalizedItem[]>();
  items.forEach((item, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  });
  return [...groups.values()];
}

function orderWithinGroup(items: NormalizedItem[], orientation: Orientation) {
  return [...items].sort((a, b) => {
    if (orientation === "vertical") {
      const column = b.rect.x - a.rect.x;
      return Math.abs(column) > 0.012 ? column : a.rect.y - b.rect.y;
    }
    const row = a.rect.y - b.rect.y;
    return Math.abs(row) > 0.012 ? row : a.rect.x - b.rect.x;
  });
}

function orderPage(
  regions: TranslationRegion[],
  language: SourceLanguage,
  readingOrder: ReadingOrder,
) {
  const rtl = readingOrder === "rtl" || (readingOrder === "auto" && language !== "en");
  const rows: TranslationRegion[][] = [];

  [...regions]
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    .forEach((region) => {
      const match = rows.find((row) => {
        const top = Math.min(...row.map((item) => item.rect.y));
        const bottom = Math.max(...row.map((item) => item.rect.y + item.rect.height));
        const overlap = Math.max(
          0,
          Math.min(bottom, region.rect.y + region.rect.height) - Math.max(top, region.rect.y),
        );
        return overlap / Math.max(0.0001, Math.min(bottom - top, region.rect.height)) >= 0.25;
      });
      if (match) match.push(region);
      else rows.push([region]);
    });

  rows.sort((a, b) => Math.min(...a.map((item) => item.rect.y)) - Math.min(...b.map((item) => item.rect.y)));
  return rows.flatMap((row) =>
    row.sort((a, b) => (rtl ? b.rect.x - a.rect.x : a.rect.x - b.rect.x)),
  );
}

export function buildTranslationRegions(
  rawItems: RawOcrItem[],
  imageWidth: number,
  imageHeight: number,
  language: SourceLanguage,
  readingOrder: ReadingOrder,
): TranslationRegion[] {
  const normalized = rawItems
    .map((item, index) => normalizeItem(item, index, imageWidth, imageHeight, language))
    .filter((item): item is NormalizedItem => Boolean(item));

  const groups = clusterItems(normalized).map((items, index) => {
    const orientation = items[0].orientation;
    const ordered = orderWithinGroup(items, orientation);
    const rect = mergedRect(items);
    const sourceText = ordered.map((item) => item.text).join(orientation === "vertical" ? "\n" : " ");
    const sourceLanguage = language === "auto" ? detectTextLanguage(sourceText) : language;
    const confidence = items.reduce((sum, item) => sum + item.score, 0) / items.length;
    const pairScores = items.flatMap((item, itemIndex) =>
      items.slice(itemIndex + 1).map((other) => pairScore(item, other)).filter((score) => score >= 0),
    );

    return {
      id: `region-${String(index + 1).padStart(2, "0")}`,
      sourceText,
      translation: "",
      score: confidence,
      orientation,
      rect,
      polygon: localPolygon(rect),
      sourceLanguage,
      mergeConfidence: items.length === 1
        ? 1
        : pairScores.reduce((sum, score) => sum + score, 0) / Math.max(1, pairScores.length),
    } satisfies TranslationRegion;
  });

  return orderPage(groups, language, readingOrder).map((region, index) => ({
    ...region,
    id: `region-${String(index + 1).padStart(2, "0")}`,
  }));
}

export function polygonToLocalCss(region: TranslationRegion) {
  const { rect } = region;
  return region.polygon
    .map(([x, y]) => {
      const localX = ((x - rect.x) / rect.width) * 100;
      const localY = ((y - rect.y) / rect.height) * 100;
      return `${clamp(localX, 0, 100).toFixed(2)}% ${clamp(localY, 0, 100).toFixed(2)}%`;
    })
    .join(", ");
}
