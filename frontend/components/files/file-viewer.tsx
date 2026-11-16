"use client";

import { DownloadIcon, ExternalLinkIcon, HardDriveIcon, LoaderIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { downloadFile, isCacheable, loadFile, MAX_CACHED_BYTES, type FileSource } from "@/lib/file-cache";
import { formatBytes } from "@/lib/format";
import { useErrorToast } from "@/lib/errors";
import { FileTypeIcon, previewKind } from "./file-icon";

const PdfView = dynamic(() => import("./pdf-view").then((m) => m.PdfView), { ssr: false });

const TEXT_PREVIEW_BYTES = 1_000_000;

/** Opens a stored file in a dialog, reading it from this device after the first time. */
export function FileViewer({ file, onClose }: { file: FileSource | null; onClose: () => void }) {
  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && onClose()}>
      {file ? <ViewerContent key={file.url} file={file} /> : null}
    </Dialog>
  );
}

type Loaded = { blob: Blob; href: string } | { error: true } | null;

function useFileBlob({ url, name, contentType, size }: FileSource): Loaded {
  const [loaded, setLoaded] = useState<Loaded>(null);
  useEffect(() => {
    let live = true;
    let href: string | null = null;
    loadFile({ url, name, contentType, size })
      .then((blob) => {
        if (!live) return;
        href = URL.createObjectURL(blob);
        setLoaded({ blob, href });
      })
      .catch(() => live && setLoaded({ error: true }));
    return () => {
      live = false;
      if (href) URL.revokeObjectURL(href);
    };
  }, [url, name, contentType, size]);
  return loaded;
}

function ViewerContent({ file }: { file: FileSource }) {
  const t = useTranslations("files");
  const showError = useErrorToast();
  const loaded = useFileBlob(file);
  const kind = previewKind(file.contentType);
  const kept = isCacheable(file.url) && file.size <= MAX_CACHED_BYTES;

  let body;
  if (loaded === null) {
    body = <LoaderIcon className="m-auto size-6 animate-spin text-muted-foreground" />;
  } else if ("error" in loaded) {
    body = (
      <div className="m-auto flex flex-col items-center gap-3 p-8 text-sm text-muted-foreground">
        {t("previewFailed")}
        <Button variant="outline" size="sm" asChild>
          <a href={file.url} target="_blank" rel="noopener noreferrer">
            <ExternalLinkIcon />
            {t("openOriginal")}
          </a>
        </Button>
      </div>
    );
  } else if (kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element -- a local object URL
    body = <img src={loaded.href} alt={file.name} className="m-auto max-h-full max-w-full object-contain" />;
  } else if (kind === "pdf") {
    body = <PdfView blob={loaded.blob} />;
  } else if (kind === "video") {
    body = <video src={loaded.href} controls playsInline className="m-auto max-h-full max-w-full" />;
  } else if (kind === "audio") {
    body = <audio src={loaded.href} controls className="m-auto" />;
  } else if (kind === "text") {
    body = <TextView blob={loaded.blob} />;
  } else {
    body = (
      <div className="m-auto flex flex-col items-center gap-2 p-8 text-sm text-muted-foreground">
        <FileTypeIcon contentType={file.contentType} name={file.name} className="size-10" />
        {t("noPreview")}
      </div>
    );
  }

  return (
    <DialogContent className="flex h-[90dvh] flex-col gap-3 sm:max-w-4xl">
      <DialogHeader className="min-w-0 pr-8">
        <DialogTitle className="truncate leading-snug">{file.name}</DialogTitle>
        <DialogDescription className="flex items-center gap-1.5">
          {formatBytes(file.size)}
          {kept ? (
            <>
              <span>·</span>
              <HardDriveIcon className="size-3.5" />
              {t("keptOnDevice")}
            </>
          ) : null}
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 overflow-auto rounded-md bg-secondary/40">{body}</div>
      <DialogFooter className="mx-0 mb-0 rounded-none border-0 bg-transparent p-0">
        <Button onClick={() => void downloadFile(file).catch(showError)}>
          <DownloadIcon />
          {t("download")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function TextView({ blob }: { blob: Blob }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void blob
      .slice(0, TEXT_PREVIEW_BYTES)
      .text()
      .then((value) => live && setText(value));
    return () => {
      live = false;
    };
  }, [blob]);
  return <pre className="w-full p-4 font-mono text-xs break-words whitespace-pre-wrap select-text">{text}</pre>;
}
