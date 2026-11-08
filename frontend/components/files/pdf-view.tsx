"use client";

import type { PageViewport, PDFPageProxy } from "pdfjs-dist";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

const PAGE_GAP_PX = 12;

type PdfJs = typeof import("pdfjs-dist");

async function loadPdfJs(): Promise<PdfJs> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc ||= new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;
  return pdfjs;
}

/** Draws the page, then lays transparent text over it so selection lands where the words are. */
async function renderPage(pdfjs: PdfJs, el: HTMLElement, page: PDFPageProxy, viewport: PageViewport) {
  const ratio = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  const text = document.createElement("div");
  text.className = "textLayer";
  el.append(canvas, text);
  await page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise;
  await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport }).render();
}

/** A PDF fitted to the dialog's width; pages render as they scroll into view. */
export function PdfView({ blob }: { blob: Blob }) {
  const t = useTranslations("files");
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let cancelled = false;
    let destroy: (() => void) | undefined;
    const pending = new Map<Element, () => void>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const draw = entry.isIntersecting ? pending.get(entry.target) : undefined;
          if (!draw) continue;
          pending.delete(entry.target);
          observer.unobserve(entry.target);
          draw();
        }
      },
      { root: root.parentElement, rootMargin: "100% 0px" },
    );

    void (async () => {
      const pdfjs = await loadPdfJs();
      const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
      destroy = () => void task.destroy();
      const doc = await task.promise;
      const width = root.clientWidth - 2 * PAGE_GAP_PX;
      for (let n = 1; n <= doc.numPages && !cancelled; n++) {
        const page = await doc.getPage(n);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
        const el = document.createElement("div");
        el.className = "pdf-page";
        el.style.width = `${viewport.width}px`;
        el.style.height = `${viewport.height}px`;
        el.style.setProperty("--scale-factor", String(viewport.scale));
        el.style.setProperty("--user-unit", String(viewport.userUnit));
        root.append(el);
        pending.set(el, () => void renderPage(pdfjs, el, page, viewport).catch(() => undefined));
        observer.observe(el);
      }
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });

    return () => {
      cancelled = true;
      observer.disconnect();
      destroy?.();
      root.replaceChildren();
    };
  }, [blob]);

  if (failed) return <p className="p-8 text-center text-sm text-muted-foreground">{t("previewFailed")}</p>;
  return <div ref={ref} className="flex w-full flex-col items-center py-3" style={{ gap: PAGE_GAP_PX }} />;
}
