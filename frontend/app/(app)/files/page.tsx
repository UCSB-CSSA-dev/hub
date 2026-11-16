"use client";

import { useMutation, useQuery } from "convex/react";
import {
  ArchiveIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  DownloadIcon,
  FilePenLineIcon,
  FolderIcon,
  FolderInputIcon,
  FolderPlusIcon,
  LockIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RotateCcwIcon,
  SearchIcon,
  Share2Icon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Suspense, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { UsageBar } from "@/components/admin/storage-card";
import { NewDocumentDialog } from "@/components/docs/task-documents";
import { downloadFile } from "@/lib/file-cache";
import { formatBytes } from "@/lib/format";
import { FileTypeIcon } from "@/components/files/file-icon";
import {
  MoveDialog,
  NameDialog,
  PreviewDialog,
  ShareToChatDialog,
  useSpaceLabel,
  type FileView,
  type SpaceView,
} from "@/components/files/file-dialogs";
import { UploadPanel } from "@/components/files/upload-panel";
import { useFileUpload } from "@/components/files/use-file-upload";
import { PageHeader } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { api, LIMITS, type Id } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import { docHref, filesHref } from "@/lib/links";
import type { Locale } from "@/lib/locale-store";
import { displayName } from "@/lib/names";
import { cn } from "@/lib/utils";

type FolderView = NonNullable<ReturnType<typeof useFolder>>["folders"][number];

function useFolder(space: string, folderId: Id<"folders"> | undefined) {
  return useQuery(api.files.listFolder, { space, folderId });
}

export default function FilesPage() {
  return (
    <Suspense>
      <Files />
    </Suspense>
  );
}

function Files() {
  const params = useSearchParams();
  const space = params.get("s");
  const folderId = (params.get("f") as Id<"folders"> | null) ?? undefined;
  const fileId = params.get("file") as Id<"files"> | null;
  const trash = params.get("trash") === "1";
  return (
    <>
      {!space ? (
        <SpacesHome />
      ) : trash ? (
        <TrashView space={space} />
      ) : (
        <FolderPage key={`${space}:${folderId ?? ""}`} space={space} folderId={folderId} />
      )}
      {fileId ? <PreviewFromParam fileId={fileId} /> : null}
    </>
  );
}

function PreviewFromParam({ fileId }: { fileId: Id<"files"> }) {
  const t = useTranslations("files");
  const router = useRouter();
  const params = useSearchParams();
  const data = useQuery(api.files.get, { fileId });
  const documentId = data?.file.documentId;
  useEffect(() => {
    if (documentId) router.replace(docHref(documentId));
  }, [documentId, router]);
  const close = () => {
    const next = new URLSearchParams(params.toString());
    next.delete("file");
    const query = next.toString();
    router.replace(query ? `/files/?${query}` : "/files/");
  };
  if (data === null) {
    return (
      <Dialog open onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("fileGone")}</DialogTitle>
            <DialogDescription>{t("fileGoneBody")}</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }
  if (documentId) return null;
  return <PreviewDialog file={data?.file ?? null} onClose={close} />;
}

function SpacesHome() {
  const t = useTranslations("files");
  const label = useSpaceLabel();
  const spaces = useQuery(api.files.listSpaces);
  const [query, setQuery] = useState("");
  const results = useQuery(api.files.search, query.trim() ? { query: query.trim() } : "skip");

  return (
    <>
      <PageHeader title={t("title")} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
          <div className="relative">
            <SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} className="pl-9" />
            {query ? (
              <button
                type="button"
                aria-label={t("clear")}
                onClick={() => setQuery("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-accent"
              >
                <XIcon className="size-4" />
              </button>
            ) : null}
          </div>

          {query.trim() ? (
            <Card className="py-2">
              <CardContent className="flex flex-col px-2">
                {results === undefined ? (
                  <Skeleton className="m-2 h-8" />
                ) : results.length === 0 ? (
                  <p className="p-4 text-center text-sm text-muted-foreground">{t("noResults")}</p>
                ) : (
                  results.map(({ file, space }) => (
                    <Link
                      key={file._id}
                      href={file.documentId ? docHref(file.documentId) : filesHref({ s: space.key, f: file.folderId, file: file._id })}
                      className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-accent"
                    >
                      <FileTypeIcon contentType={file.contentType} name={file.name} document={Boolean(file.documentId)} />
                      <span className="min-w-0 flex-1 truncate">{file.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{label(space)}</span>
                    </Link>
                  ))
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {spaces === undefined
                ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)
                : spaces.map((space) => <SpaceCard key={space.key} space={space} />)}
            </div>
          )}
          <p className="text-xs text-subtle-foreground">{t("homeHint", { max: formatBytes(LIMITS.fileBytes), driveMax: formatBytes(LIMITS.driveFileBytes) })}</p>
        </div>
      </div>
    </>
  );
}

function SpaceCard({ space }: { space: SpaceView }) {
  const t = useTranslations("files");
  const label = useSpaceLabel();
  return (
    <Link href={filesHref({ s: space.key })}>
      <Card className="h-full py-4 transition-colors hover:bg-accent/40">
        <CardContent className="flex flex-col gap-3 px-4">
          <div className="flex items-center gap-2">
            {space.kind === "presidium" ? (
              <LockIcon className="size-5 text-primary" />
            ) : (
              <FolderIcon className="size-5 text-primary" />
            )}
            <span className="min-w-0 flex-1 truncate font-medium">{label(space)}</span>
            {space.archived ? (
              <Badge variant="secondary">{t("archived")}</Badge>
            ) : space.access.manage ? (
              <Badge variant="outline">{t("roleManage")}</Badge>
            ) : space.access.upload ? (
              <Badge variant="outline">{t("roleUpload")}</Badge>
            ) : (
              <Badge variant="secondary">{t("roleView")}</Badge>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <UsageBar used={space.usedBytes} total={space.quotaBytes} />
            <span className="text-xs text-muted-foreground">
              {t("usage", { used: formatBytes(space.usedBytes), quota: formatBytes(space.quotaBytes) })}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function Breadcrumb({ items }: { items: { label: ReactNode; href?: string }[] }) {
  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground">
      {items.map((item, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 ? <ChevronRightIcon className="size-3.5 shrink-0" /> : null}
          {item.href ? (
            <Link href={item.href} className="truncate hover:text-foreground">
              {item.label}
            </Link>
          ) : (
            <span className="truncate text-foreground">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

type Dialogs =
  | { type: "newFolder" }
  | { type: "renameFolder"; folder: FolderView }
  | { type: "moveFolder"; folder: FolderView }
  | { type: "deleteFolder"; folder: FolderView }
  | { type: "renameFile"; file: FileView }
  | { type: "moveFile"; file: FileView }
  | { type: "newDocument" }
  | null;

function FolderPage({ space, folderId }: { space: string; folderId: Id<"folders"> | undefined }) {
  const t = useTranslations("files");
  const tDocs = useTranslations("docs");
  const label = useSpaceLabel();
  const router = useRouter();
  const data = useFolder(space, folderId);
  const createFolder = useMutation(api.files.createFolder);
  const createDocument = useMutation(api.documents.createInFolder);
  const renameFolder = useMutation(api.files.renameFolder);
  const moveFolder = useMutation(api.files.moveFolder);
  const removeFolder = useMutation(api.files.removeFolder);
  const renameFile = useMutation(api.files.rename);
  const moveFile = useMutation(api.files.move);
  const removeFile = useMutation(api.files.remove);
  const showError = useErrorToast();
  const { upload, items, dismiss, clearDone } = useFileUpload();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [sharing, setSharing] = useState<FileView[] | null>(null);
  const [preview, setPreview] = useState<FileView | null>(null);
  const [dragging, setDragging] = useState(false);

  if (data === undefined) {
    return (
      <>
        <PageHeader title={t("title")} />
        <div className="flex flex-col gap-2 p-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      </>
    );
  }
  if (data === null) {
    return (
      <>
        <PageHeader title={t("title")} />
        <div className="m-auto flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-sm text-muted-foreground">{t("folderGone")}</p>
          <Button asChild size="sm" variant="secondary">
            <Link href="/files/">{t("allSpaces")}</Link>
          </Button>
        </div>
      </>
    );
  }

  const { access } = data.space;
  const canUpload = access.upload;
  const onFiles = (files: File[]) => {
    if (!canUpload || files.length === 0) return;
    void upload(files, { space, folderId });
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    onFiles([...event.dataTransfer.files]);
  };
  const crumbs = [
    { label: t("title"), href: "/files/" },
    { label: label(data.space), href: data.breadcrumb.length > 0 ? filesHref({ s: space }) : undefined },
    ...data.breadcrumb.map((f, i) => ({
      label: f.name,
      href: i < data.breadcrumb.length - 1 ? filesHref({ s: space, f: f._id }) : undefined,
    })),
  ];
  const taskFolder = data.breadcrumb.find((f) => f.assignmentId)?.assignmentId ?? null;
  const empty = data.folders.length === 0 && data.files.length === 0;

  return (
    <>
      <PageHeader title={data.folder?.name ?? label(data.space)}>
        {access.manage ? (
          <Button asChild size="sm" variant="ghost" aria-label={t("trash")}>
            <Link href={filesHref({ s: space, trash: true })}>
              <Trash2Icon />
              <span className="hidden sm:inline">{t("trash")}</span>
            </Link>
          </Button>
        ) : null}
        {access.manage ? (
          <Button size="sm" variant="secondary" onClick={() => setDialog({ type: "newFolder" })} aria-label={t("newFolder")}>
            <FolderPlusIcon />
            <span className="hidden sm:inline">{t("newFolder")}</span>
          </Button>
        ) : null}
        {canUpload ? (
          <Button size="sm" variant="secondary" onClick={() => setDialog({ type: "newDocument" })} aria-label={tDocs("new")}>
            <FilePenLineIcon />
            <span className="hidden sm:inline">{tDocs("new")}</span>
          </Button>
        ) : null}
        {canUpload ? (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                onFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <Button size="sm" onClick={() => fileInput.current?.click()}>
              <UploadIcon />
              {t("upload")}
            </Button>
          </>
        ) : null}
      </PageHeader>
      <div
        className={cn("relative min-h-0 flex-1 overflow-y-auto", dragging && "bg-primary/5 ring-2 ring-primary/40 ring-inset")}
        onDragOver={(e) => {
          if (!canUpload) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={canUpload ? onDrop : undefined}
      >
        <div className="mx-auto flex max-w-5xl flex-col gap-3 p-4">
          <Breadcrumb items={crumbs} />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <UsageBar used={data.space.usedBytes} total={data.space.quotaBytes} className="w-32" />
            <span>{t("usage", { used: formatBytes(data.space.usedBytes), quota: formatBytes(data.space.quotaBytes) })}</span>
            {!canUpload ? <span>· {data.space.archived ? t("archivedReadOnly") : t("readOnly")}</span> : null}
          </div>
          {taskFolder ? (
            <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm">
              <ClipboardListIcon className="size-4 text-primary" />
              <span className="flex-1">{t("taskFolderHint")}</span>
              <Button asChild size="xs" variant="ghost">
                <Link href={`/assignments/view/?a=${taskFolder}`}>{t("openTask")}</Link>
              </Button>
            </div>
          ) : null}

          {empty ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-14 text-center text-sm text-muted-foreground">
              <FolderIcon className="size-8 text-subtle-foreground" />
              {t("emptyFolder")}
              {canUpload ? <span className="text-xs">{t("dropHint")}</span> : null}
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {data.folders.map((folder) => (
                <div key={folder._id} className="group flex items-center gap-3 px-3 py-2 hover:bg-surface-hover">
                  <Link href={filesHref({ s: space, f: folder._id })} className="flex min-w-0 flex-1 items-center gap-3 text-sm">
                    {folder.isTaskFolder ? (
                      <ClipboardListIcon className="size-5 shrink-0 text-primary" />
                    ) : (
                      <FolderIcon className="size-5 shrink-0 text-primary" />
                    )}
                    <span className="truncate font-medium">{folder.name}</span>
                  </Link>
                  {access.manage ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label={t("more")}>
                          <MoreHorizontalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {folder.assignmentId ? (
                          <DropdownMenuItem asChild>
                            <Link href={`/assignments/view/?a=${folder.assignmentId}`}>
                              <ClipboardListIcon />
                              {t("openTask")}
                            </Link>
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem onSelect={() => setDialog({ type: "renameFolder", folder })}>
                          <PencilIcon />
                          {t("rename")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setDialog({ type: "moveFolder", folder })}>
                          <FolderInputIcon />
                          {t("move")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => setDialog({ type: "deleteFolder", folder })}>
                          <Trash2Icon />
                          {t("delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              ))}
              {data.files.map((file) => (
                <FileRow
                  key={file._id}
                  file={file}
                  canMove={file.canEdit && (access.upload || access.manage)}
                  onOpen={() => (file.documentId ? router.push(docHref(file.documentId)) : setPreview(file))}
                  onShare={() => setSharing([file])}
                  onRename={() => setDialog({ type: "renameFile", file })}
                  onMove={() => setDialog({ type: "moveFile", file })}
                  onDelete={() =>
                    removeFile({ fileId: file._id })
                      .then(() => toast.success(access.manage ? t("movedToTrash") : t("deleted")))
                      .catch(showError)
                  }
                />
              ))}
            </div>
          )}
        </div>
        <UploadPanel items={items} onDismiss={dismiss} onClear={clearDone} className="fixed right-4 bottom-20 z-30 w-72 md:bottom-4" />
      </div>

      <NameDialog
        open={dialog?.type === "newFolder"}
        title={t("newFolder")}
        initial=""
        max={LIMITS.folderName}
        onClose={() => setDialog(null)}
        onSubmit={(name) => createFolder({ space, parentId: folderId, name })}
      />
      <NameDialog
        open={dialog?.type === "renameFolder" || dialog?.type === "renameFile"}
        title={t("rename")}
        initial={dialog?.type === "renameFolder" ? dialog.folder.name : dialog?.type === "renameFile" ? dialog.file.name : ""}
        max={dialog?.type === "renameFolder" ? LIMITS.folderName : LIMITS.fileName}
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          if (dialog?.type === "renameFolder") await renameFolder({ folderId: dialog.folder._id, name });
          if (dialog?.type === "renameFile") await renameFile({ fileId: dialog.file._id, name });
        }}
      />
      <MoveDialog
        open={dialog?.type === "moveFolder" || dialog?.type === "moveFile"}
        space={space}
        name={dialog?.type === "moveFolder" ? dialog.folder.name : dialog?.type === "moveFile" ? dialog.file.name : ""}
        current={folderId}
        exclude={dialog?.type === "moveFolder" ? dialog.folder._id : undefined}
        onClose={() => setDialog(null)}
        onMove={async (target) => {
          if (dialog?.type === "moveFolder") await moveFolder({ folderId: dialog.folder._id, parentId: target });
          if (dialog?.type === "moveFile") await moveFile({ fileId: dialog.file._id, folderId: target });
        }}
      />
      <Dialog open={dialog?.type === "deleteFolder"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteFolderTitle", { name: dialog?.type === "deleteFolder" ? dialog.folder.name : "" })}</DialogTitle>
            <DialogDescription>{t("deleteFolderBody", { days: LIMITS.trashDays })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (dialog?.type !== "deleteFolder") return;
                const folder = dialog.folder;
                setDialog(null);
                removeFolder({ folderId: folder._id })
                  .then(() => toast.success(t("movedToTrash")))
                  .catch(showError);
              }}
            >
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <NewDocumentDialog
        key={dialog?.type === "newDocument" ? "open" : "closed"}
        open={dialog?.type === "newDocument"}
        description={tDocs("newInFolderBody")}
        onClose={() => setDialog(null)}
        onCreate={(title) => createDocument({ space, folderId, title })}
      />
      <ShareToChatDialog files={sharing} onClose={() => setSharing(null)} />
      <PreviewDialog file={preview} onClose={() => setPreview(null)} />
    </>
  );
}

function FileRow({
  file,
  canMove,
  onOpen,
  onShare,
  onRename,
  onMove,
  onDelete,
}: {
  file: FileView;
  canMove: boolean;
  onOpen: () => void;
  onShare: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("files");
  const locale = useLocale() as Locale;
  const format = useFormatter();
  const tDocs = useTranslations("docs");
  const showError = useErrorToast();
  const meta = [
    file.documentId ? tDocs("document") : formatBytes(file.size),
    file.uploadedBy ? displayName(file.uploadedBy, locale) : null,
    format.dateTime(file._creationTime, { dateStyle: "medium" }),
    file.drive ? t("inDrive") : null,
  ].filter(Boolean);
  return (
    <div className="group flex items-center gap-3 px-3 py-2 hover:bg-surface-hover">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left text-sm">
        {file.isImage && file.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- thumbnails come from Convex storage
          <img src={file.thumbUrl} alt="" className="size-8 shrink-0 rounded object-cover" loading="lazy" />
        ) : (
          <span className="flex size-8 shrink-0 items-center justify-center">
            <FileTypeIcon contentType={file.contentType} name={file.name} document={Boolean(file.documentId)} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{file.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{meta.join(" · ")}</span>
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label={t("more")}>
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {file.url && !file.drive ? (
            <DropdownMenuItem
              onSelect={() =>
                void downloadFile({ url: file.url!, name: file.name, contentType: file.contentType, size: file.size }).catch(
                  showError,
                )
              }
            >
              <DownloadIcon />
              {t("download")}
            </DropdownMenuItem>
          ) : file.url ? (
            <DropdownMenuItem asChild>
              <a href={file.url} target="_blank" rel="noopener noreferrer" download={file.name}>
                <DownloadIcon />
                {t("download")}
              </a>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={onShare}>
            <Share2Icon />
            {t("shareToChat")}
          </DropdownMenuItem>
          {file.canEdit ? (
            <>
              <DropdownMenuItem onSelect={onRename}>
                <PencilIcon />
                {t("rename")}
              </DropdownMenuItem>
              {canMove ? (
                <DropdownMenuItem onSelect={onMove}>
                  <FolderInputIcon />
                  {t("move")}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2Icon />
                {t("delete")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function TrashView({ space }: { space: string }) {
  const t = useTranslations("files");
  const locale = useLocale() as Locale;
  const format = useFormatter();
  const label = useSpaceLabel();
  const spaces = useQuery(api.files.listSpaces);
  const current = spaces?.find((s) => s.key === space);
  const trash = useQuery(api.files.listTrash, current?.access.manage ? { space } : "skip");
  const restoreFile = useMutation(api.files.restore);
  const restoreFolder = useMutation(api.files.restoreFolder);
  const purge = useMutation(api.files.purge);
  const showError = useErrorToast();
  const [confirm, setConfirm] = useState<{ fileId?: Id<"files">; folderId?: Id<"folders">; name: string } | null>(null);

  const rows = trash
    ? [
        ...trash.folders.map((f) => ({ ...f, kind: "folder" as const, size: undefined as number | undefined })),
        ...trash.files.map((f) => ({ ...f, kind: "file" as const })),
      ].sort((a, b) => b.deletedAt - a.deletedAt)
    : [];

  return (
    <>
      <PageHeader title={t("trash")} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 p-4">
          <Breadcrumb
            items={[
              { label: t("title"), href: "/files/" },
              { label: current ? label(current) : space, href: filesHref({ s: space }) },
              { label: t("trash") },
            ]}
          />
          <p className="text-xs text-muted-foreground">{t("trashHint", { days: LIMITS.trashDays })}</p>
          {spaces && !current?.access.manage ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{t("trashForbidden")}</p>
          ) : trash === undefined ? (
            <Skeleton className="h-20" />
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-14 text-sm text-muted-foreground">
              <ArchiveIcon className="size-8 text-subtle-foreground" />
              {t("trashEmpty")}
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {rows.map((row) => (
                <div key={row._id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  {row.kind === "folder" ? (
                    <FolderIcon className="size-5 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileTypeIcon contentType={row.contentType} name={row.name} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{row.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t("deletedBy", {
                        name: row.deletedBy ? displayName(row.deletedBy, locale) : "?",
                        date: format.dateTime(row.deletedAt, { dateStyle: "medium" }),
                      })}{" "}
                      · {t("purgesOn", { date: format.dateTime(row.purgeAt, { dateStyle: "medium" }) })}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      (row.kind === "folder" ? restoreFolder({ folderId: row._id }) : restoreFile({ fileId: row._id }))
                        .then(() => toast.success(t("restored")))
                        .catch(showError)
                    }
                  >
                    <RotateCcwIcon />
                    <span className="hidden sm:inline">{t("restore")}</span>
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("deleteForever")}
                    onClick={() =>
                      setConfirm(row.kind === "folder" ? { folderId: row._id, name: row.name } : { fileId: row._id, name: row.name })
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteForeverTitle", { name: confirm?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("deleteForeverBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!confirm) return;
                const target = confirm;
                setConfirm(null);
                purge({ fileId: target.fileId, folderId: target.folderId })
                  .then(() => toast.success(t("purged")))
                  .catch(showError);
              }}
            >
              {t("deleteForever")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
