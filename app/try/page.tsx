import type { Metadata } from "next";
import { TranslatorDesk } from "../TranslatorDesk";

export const metadata: Metadata = {
  title: "網頁版翻譯工作台",
  description:
    "上傳英文或日文圖片，在瀏覽器辨識、翻成繁體中文並校對輸出。",
};

export default function TryPage() {
  return <TranslatorDesk />;
}
