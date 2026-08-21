import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const baseUrl = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og-extension.png", baseUrl).toString();

  return {
    metadataBase: baseUrl,
    applicationName: "譯格 Panelshift",
    title: {
      default: "譯格 Panelshift｜網頁圖片與漫畫即時翻譯",
      template: "%s｜譯格 Panelshift",
    },
    description:
      "Chrome 擴充功能：直接選取網頁上的英文或日文圖片，以本機 PP-OCRv5 辨識，翻成繁體中文並疊回原位。",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "讓網頁裡的圖片，直接說繁體中文｜譯格 Panelshift",
      description: "選取網頁圖片，辨識英文與日文，翻成繁體中文並貼回原位。",
      type: "website",
      locale: "zh_TW",
      siteName: "譯格 Panelshift",
      url: baseUrl,
      images: [
        {
          url: socialImage,
          width: 1731,
          height: 909,
          alt: "譯格 Panelshift 網頁圖片與漫畫翻譯 Chrome 擴充功能",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "讓網頁裡的圖片，直接說繁體中文｜譯格 Panelshift",
      description: "選取網頁圖片，辨識英文與日文，翻成繁體中文並貼回原位。",
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
