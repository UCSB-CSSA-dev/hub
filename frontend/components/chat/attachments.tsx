"use client";

import { DownloadIcon, FileIcon, FileXIcon, FolderDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { SaveToFilesDialog } from "@/components/files/file-dialogs";
import { FileViewer } from "@/components/files/file-viewer";
import { LIMITS } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import { downloadFile, type FileSource } from "@/lib/file-cache";
import { formatBytes } from "@/lib/format";
import type { Message } from "./types";

type Attachment = Message["attachments"][number];

export { formatBytes };

function source(attachment: Attachment): FileSource {
  return { url: attachment.url!, name: attachment.name, contentType: attachment.contentType, size: attachment.size };
}

export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  const [saving, setSaving] = useState<Attachment | null>(null);
  const [viewing, setViewing] = useState<FileSource | null>(null);
  if (attachments.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {attachments.map((a) => (
        <AttachmentItem key={a._id} attachment={a} onSave={() => setSaving(a)} onOpen={() => setViewing(source(a))} />
      ))}
      <SaveToFilesDialog attachment={saving} onClose={() => setSaving(null)} />
      <FileViewer file={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}

function AttachmentItem({
  attachment,
  onSave,
  onOpen,
}: {
  attachment: Attachment;
  onSave: () => void;
  onOpen: () => void;
}) {
  const t = useTranslations("chat");
  const showError = useErrorToast();
  if (attachment.expired || !attachment.url) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        <FileXIcon className="size-4" />
        <span className="max-w-48 truncate">{attachment.name}</span>
        <span>· {t("fileExpired")}</span>
      </div>
    );
  }
  const saveButton = (
    <button
      type="button"
      onClick={onSave}
      aria-label={t("saveToFiles")}
      title={t("saveToFiles")}
      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <FolderDownIcon className="size-4" />
    </button>
  );
  if (attachment.isImage && attachment.thumbUrl) {
    return (
      <div className="group/attachment relative">
        <button
          type="button"
          onClick={onOpen}
          title={t("openOriginal", { name: attachment.name, size: formatBytes(attachment.size) })}
          className="block overflow-hidden rounded-md border border-border"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- static export, thumbnails come from Convex storage */}
          <img src={attachment.thumbUrl} alt={attachment.name} className="max-h-48 max-w-64 object-cover" loading="lazy" />
        </button>
        <div className="absolute top-1 right-1 hidden rounded-md bg-popover/90 shadow-sm group-hover/attachment:block">{saveButton}</div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 py-2 pr-3 pl-1 text-sm">
      <button type="button" onClick={onOpen} className="flex min-w-0 items-center gap-2 rounded-md px-2 text-left">
        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="max-w-56 truncate">{attachment.name}</div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(attachment.size)} · {t("fileKeptDays", { days: LIMITS.attachmentRetentionDays })}
          </div>
        </div>
      </button>
      {saveButton}
      <button
        type="button"
        onClick={() => void downloadFile(source(attachment)).catch(showError)}
        aria-label={t("download")}
        title={t("download")}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <DownloadIcon className="size-4" />
      </button>
    </div>
  );
}
