import {
  FileArchiveIcon,
  FileAudioIcon,
  FileIcon,
  FileImageIcon,
  FilePenLineIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  PresentationIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function FileTypeIcon({
  contentType,
  name,
  document,
  className,
}: {
  contentType: string;
  name: string;
  /** A collaborative document created in the Hub. */
  document?: boolean;
  className?: string;
}) {
  if (document) return <FilePenLineIcon className={cn("size-5 shrink-0 text-primary", className)} />;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const Icon = contentType.startsWith("image/")
    ? FileImageIcon
    : contentType.startsWith("video/")
      ? FileVideoIcon
      : contentType.startsWith("audio/")
        ? FileAudioIcon
        : ["xls", "xlsx", "csv", "numbers"].includes(ext)
          ? FileSpreadsheetIcon
          : ["ppt", "pptx", "key"].includes(ext)
            ? PresentationIcon
            : ["zip", "rar", "7z", "gz", "tar"].includes(ext)
              ? FileArchiveIcon
              : contentType === "application/pdf" || contentType.startsWith("text/") || ["doc", "docx", "pages", "md"].includes(ext)
                ? FileTextIcon
                : FileIcon;
  return <Icon className={cn("size-5 shrink-0 text-muted-foreground", className)} />;
}

/** Files the viewer can show inline. */
export function previewKind(contentType: string): "image" | "pdf" | "video" | "audio" | "text" | null {
  if (contentType.startsWith("image/")) return "image";
  if (contentType === "application/pdf") return "pdf";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("text/") || contentType === "application/json") return "text";
  return null;
}
