"use client";

import type { Editor } from "@tiptap/core";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  ArrowLeftIcon,
  CalendarDaysIcon,
  ClipboardListIcon,
  DownloadIcon,
  EyeIcon,
  FolderIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PrinterIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { DocEditor } from "@/components/docs/doc-editor";
import { MarkdownView } from "@/components/docs/markdown-view";
import { PageHeader } from "@/components/layout/app-shell";
import { useTaskChatName } from "@/components/tasks/task-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, LIMITS } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import { useEnterSubmit } from "@/lib/keyboard";
import { filesHref } from "@/lib/links";
import type { Locale } from "@/lib/locale-store";
import { displayName, localized } from "@/lib/names";

type Doc = NonNullable<FunctionReturnType<typeof api.documents.get>>;

export default function DocumentPage() {
  return (
    <Suspense>
      <DocumentView />
    </Suspense>
  );
}

function DocumentView() {
  const t = useTranslations("docs");
  const id = useSearchParams().get("d");
  const doc = useQuery(api.documents.get, id ? { documentId: id } : "skip");

  if (!id || doc === null) {
    return (
      <>
        <PageHeader title={t("title")} />
        <div className="m-auto flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-sm text-muted-foreground">{t("notFound")}</p>
          <Button asChild size="sm" variant="secondary">
            <Link href="/">{t("backHome")}</Link>
          </Button>
        </div>
      </>
    );
  }
  if (doc === undefined) {
    return (
      <>
        <PageHeader title="" />
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-64" />
        </div>
      </>
    );
  }
  return <DocumentDetail doc={doc} />;
}

/** Where the document lives: its task, chat or folder, with a link back. */
function useParentLink(doc: Doc): { href: string; label: string; back: string; icon: LucideIcon } {
  const t = useTranslations("docs");
  const locale = useLocale() as Locale;
  const chatName = useTaskChatName();
  const parent = doc.parent;
  if (parent.kind === "task") {
    return {
      href: `/assignments/view/?a=${parent._id}`,
      label: parent.title,
      back: parent.taskKind === "event" ? t("backToEvent") : t("backToTask"),
      icon: parent.taskKind === "event" ? CalendarDaysIcon : ClipboardListIcon,
    };
  }
  if (parent.kind === "chat") {
    return { href: `/chat/?c=${parent.chat._id}`, label: chatName(parent.chat), back: t("backToChat"), icon: MessageSquareIcon };
  }
  return {
    href: filesHref({ s: parent.spaceKey, f: parent.folderId }),
    label: localized(parent.spaceNameZh, parent.spaceNameEn, locale),
    back: t("backToFolder"),
    icon: FolderIcon,
  };
}

function DocumentDetail({ doc }: { doc: Doc }) {
  const t = useTranslations("docs");
  const locale = useLocale() as Locale;
  const format = useFormatter();
  const parent = useParentLink(doc);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [printing, setPrinting] = useState<string | null>(null);
  const ParentIcon = parent.icon;
  const closedTask = doc.parent.kind === "task" && doc.parent.status === "closed";
  // Files documents are renamed like files: by their creator or the space's managers.
  const canRename = doc.parent.kind === "file" ? doc.canDelete : doc.canEdit;

  const markdown = () => editor?.getMarkdown() ?? "";

  const downloadMarkdown = () => {
    const blob = new Blob([`# ${doc.title}\n\n${markdown()}\n`], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${doc.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "document"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    if (printing === null) return;
    const previousTitle = document.title;
    document.title = doc.title;
    const done = () => setPrinting(null);
    window.addEventListener("afterprint", done);
    const frame = requestAnimationFrame(() => window.print());
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("afterprint", done);
      document.title = previousTitle;
    };
  }, [printing, doc.title]);

  return (
    <>
      <PageHeader title={doc.title}>
        <Button asChild size="sm" variant="ghost" className="hidden sm:inline-flex">
          <Link href={parent.href}>
            <ArrowLeftIcon />
            {parent.back}
          </Link>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={t("more")}>
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canRename ? (
              <DropdownMenuItem onSelect={() => setRenaming(true)}>
                <PencilIcon />
                {t("rename")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem disabled={!editor} onSelect={downloadMarkdown}>
              <DownloadIcon />
              {t("downloadMarkdown")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!editor} onSelect={() => setPrinting(markdown())}>
              <PrinterIcon />
              {t("exportPdf")}
            </DropdownMenuItem>
            {doc.canDelete ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                  <Trash2Icon />
                  {t("delete")}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:px-8">
          <div className="flex flex-col gap-1.5">
            <Link href={parent.href} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary">
              <ParentIcon className="size-3.5" />
              {parent.label}
            </Link>
            <h2 className="text-2xl font-bold">{doc.title}</h2>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                {t("edited", {
                  name: doc.updatedBy ? displayName(doc.updatedBy, locale) : "?",
                  time: format.relativeTime(doc.updatedAt),
                })}
              </span>
              {doc.canEdit ? (
                <span className="text-subtle-foreground">· {t("liveHint")}</span>
              ) : (
                <Badge variant="secondary" className="gap-1">
                  <EyeIcon className="size-3" />
                  {closedTask ? t("closedReadOnly") : t("readOnly")}
                </Badge>
              )}
            </div>
          </div>
          <DocEditor documentId={doc._id} editable={doc.canEdit} mentionable={doc.mentionable} onEditor={setEditor} />
        </div>
      </div>
      <RenameDialog key={String(renaming)} doc={doc} open={renaming} onClose={() => setRenaming(false)} />
      <DeleteDialog doc={doc} parentHref={parent.href} open={deleting} onClose={() => setDeleting(false)} />
      {printing !== null
        ? createPortal(
            <div className="print-root">
              <h1>{doc.title}</h1>
              <MarkdownView source={printing} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function RenameDialog({ doc, open, onClose }: { doc: Doc; open: boolean; onClose: () => void }) {
  const t = useTranslations("docs");
  const showError = useErrorToast();
  const rename = useMutation(api.documents.rename);
  const [title, setTitle] = useState(doc.title);
  const save = () =>
    rename({ documentId: doc._id, title })
      .then(onClose)
      .catch(showError);
  const enter = useEnterSubmit(() => {
    if (title.trim()) void save();
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("rename")}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={title}
          maxLength={LIMITS.documentTitle}
          onChange={(e) => setTitle(e.target.value)}
          {...enter}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button disabled={!title.trim()} onClick={() => void save()}>
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  doc,
  parentHref,
  open,
  onClose,
}: {
  doc: Doc;
  parentHref: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("docs");
  const router = useRouter();
  const showError = useErrorToast();
  const remove = useMutation(api.documents.remove);
  const inFiles = doc.parent.kind === "file";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("deleteTitle", { title: doc.title })}</DialogTitle>
          <DialogDescription>{inFiles ? t("trashBody", { days: LIMITS.trashDays }) : t("deleteBody")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={() =>
              remove({ documentId: doc._id })
                .then(({ trashed }) => {
                  toast.success(trashed ? t("trashed") : t("deleted"));
                  router.replace(parentHref);
                })
                .catch(showError)
            }
          >
            {t("delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
