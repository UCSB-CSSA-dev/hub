import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppProviders } from "@/components/providers/app-providers";
import { fontSizeScript } from "@/lib/font-size";
import "./globals.css";

// Restore before paint; keep the default when browser storage is unavailable.
const themeScript = `try{if(localStorage.getItem("cssa-hub-theme")==="light"){document.documentElement.classList.replace("dark","light");document.querySelector('meta[name="theme-color"]')?.setAttribute("content","#fafafa")}}catch{}`;

export const metadata: Metadata = {
  title: "CSSA Hub",
  description: "UCSB CSSA internal platform",
  appleWebApp: { capable: true, title: "CSSA Hub", statusBarStyle: "black" },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  // Without this iOS reports zero safe-area insets, and the home indicator covers the bottom bar.
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" className="dark h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full">
        <script dangerouslySetInnerHTML={{ __html: themeScript + fontSizeScript }} />
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
