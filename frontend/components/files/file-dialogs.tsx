"use client";

import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronRightIcon, DownloadIcon, ExternalLinkIcon, FolderIcon, HomeIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { formatBytes } from "@/lib/format";
import { useChannelName } from "@/components/chat/use-channel-name";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, LIMITS, type Id } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import type { Locale } from "@/lib/locale-store";
import { localized } from "@/lib/names";
import { cn } from "@/lib/utils";
import { FileTypeIcon } from "./file-icon";
import { FileViewer } from "./file-viewer";

export type SpaceView = FunctionReturnType<typeof api.files.listSpaces>[number];
export type FileView = NonNullable<FunctionReturnType<typeof api.files.listFolder>>["files"][number];

export function useSpaceLabel() {
  const locale = useLocale() as Locale;
  return (space: { nameZh: string; nameEn: string }) => localized(space.nameZh, space.nameEn, locale);
}

/** New folder and rename: one text field. */
export function NameDialog({
  open,
  title,
  initial,
  max,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: string;
  max: number;
  onClose: () => void;
  onSubmit: (name: string) => Promise<unknown>;
}) {
  const t = useTranslations("files");
  const showError = useErrorToast();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setValue(initial);
  }
  const name = value.trim();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!name) return;
            setBusy(true);
            try {
              await onSubmit(name);
              onClose();
            } catch (error) {
              showError(error);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input autoFocus value={value} maxLength={max} onChange={(e) => setValue(e.target.value)} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy || !name}>
              {t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A folder list for one space, with the space root first. */
export function FolderPicker({
  space,
  value,
  onChange,
  exclude,
}: {
  space: string;
  value: Id<"folders"> | undefined;
  onChange: (id: Id<"folders"> | undefined) => void;
  exclude?: Id<"folders">;
}) {
  const t = useTranslations("files");
  const tree = useQuery(api.files.folderTree, { space });
  // Hide the excluded folder and everything under it (a folder can't move into itself).
  const visible: NonNullable<typeof tree> = [];
  let skipDepth: number | null = null;
  for (const folder of tree ?? []) {
    if (skipDepth !== null && folder.depth > skipDepth) continue;
    skipDepth = null;
    if (folder._id === exclude) {
      skipDepth = folder.depth;
      continue;
    }
    visible.push(folder);
  }
  const row = (id: Id<"folders"> | undefined, label: string, depth: number, icon = <FolderIcon className="size-4" />) => (
    <button
      key={id ?? "root"}
      type="button"
      onClick={() => onChange(id)}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
        value === id ? "bg-primary/15 text-primary" : "hover:bg-accent",
      )}
      style={{ paddingLeft: 8 + depth * 16 }}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
  return (
    <ScrollArea className="h-60 rounded-md border border-border">
      <div className="flex flex-col p-1">
        {row(undefined, t("rootFolder"), 0, <HomeIcon className="size-4" />)}
        {visible.map((f) => row(f._id, f.name, f.depth + 1))}
      </div>
    </ScrollArea>
  );
}

export function MoveDialog({
  open,
  space,
  name,
  current,
  exclude,
  onClose,
  onMove,
}: {
  open: boolean;
  space: string;
  name: string;
  current: Id<"folders"> | undefined;
  exclude?: Id<"folders">;
  onClose: () => void;
  onMove: (folderId: Id<"folders"> | undefined) => Promise<unknown>;
}) {
  const t = useTranslations("files");
  const showError = useErrorToast();
  const [target, setTarget] = useState<Id<"folders"> | undefined>(current);
  const [busy, setBusy] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setTarget(current);
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("moveTitle", { name })}</DialogTitle>
        </DialogHeader>
        {open ? <FolderPicker space={space} value={target} onChange={setTarget} exclude={exclude} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            disabled={busy || target === current}
            onClick={async () => {
              setBusy(true);
              try {
                await onMove(target);
                toast.success(t("moved"));
                onClose();
              } catch (error) {
                showError(error);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("moveHere")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Posts the files to a chat as a link card; only people who can see the space can open them. */
export function ShareToChatDialog({
  files,
  onClose,
}: {
  files: { _id: Id<"files">; name: string }[] | null;
  onClose: () => void;
}) {
  const t = useTranslations("files");
  const channelName = useChannelName();
  const lists = useQuery(api.channels.listMine, files ? {} : "skip");
  const send = useMutation(api.messages.send);
  const showError = useErrorToast();
  const [channelId, setChannelId] = useState<string>("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const channels = lists
    ? [...lists.org, ...lists.departments, ...lists.groups, ...lists.dms].filter((c) => !c.archived && !c.ended)
    : [];
  const close = () => {
    setChannelId("");
    setNote("");
    onClose();
  };
  return (
    <Dialog open={files !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("shareTitle")}</DialogTitle>
          <DialogDescription>{t("shareBody")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1 text-sm">
          {(files ?? []).map((f) => (
            <div key={f._id} className="truncate text-muted-foreground">
              {f.name}
            </div>
          ))}
        </div>
        <Select value={channelId} onValueChange={setChannelId}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t("pickChat")} />
          </SelectTrigger>
          <SelectContent>
            {channels.map((c) => (
              <SelectItem key={c._id} value={c._id}>
                {channelName(c)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("shareNote")}
          rows={2}
          maxLength={LIMITS.messageBody}
        />
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t("cancel")}
          </Button>
          <Button
            disabled={busy || !channelId || !files}
            onClick={async () => {
              if (!files) return;
              setBusy(true);
              try {
                await send({ channelId: channelId as Id<"channels">, body: note.trim(), fileIds: files.map((f) => f._id) });
                toast.success(t("shared"));
                close();
              } catch (error) {
                showError(error);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("share")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Copies a chat attachment into a space the viewer can upload to. */
export function SaveToFilesDialog({
  attachment,
  onClose,
}: {
  attachment: { _id: Id<"attachments">; name: string } | null;
  onClose: () => void;
}) {
  const t = useTranslations("files");
  const label = useSpaceLabel();
  const spaces = useQuery(api.files.listSpaces, attachment ? {} : "skip");
  const saveAttachment = useMutation(api.files.saveAttachment);
  const showError = useErrorToast();
  const uploadable = (spaces ?? []).filter((s) => s.access.upload);
  const [space, setSpace] = useState<string>("");
  const [folderId, setFolderId] = useState<Id<"folders"> | undefined>();
  const [busy, setBusy] = useState(false);
  const selected = space || uploadable[0]?.key || "";
  const close = () => {
    setSpace("");
    setFolderId(undefined);
    onClose();
  };
  return (
    <Dialog open={attachment !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("saveTitle", { name: attachment?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("saveBody")}</DialogDescription>
        </DialogHeader>
        {spaces && uploadable.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noUploadableSpace")}</p>
        ) : (
          <>
            <Select
              value={selected}
              onValueChange={(v) => {
                setSpace(v);
                setFolderId(undefined);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("pickSpace")} />
              </SelectTrigger>
              <SelectContent>
                {uploadable.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {label(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected ? <FolderPicker space={selected} value={folderId} onChange={setFolderId} /> : null}
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t("cancel")}
          </Button>
          <Button
            disabled={busy || !selected || !attachment}
            onClick={async () => {
              if (!attachment) return;
              setBusy(true);
              try {
                await saveAttachment({ attachmentId: attachment._id, space: selected, folderId });
                toast.success(t("savedToFiles"));
                close();
              } catch (error) {
                showError(error);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("saveHere")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Browse spaces and folders and pick files (for sharing into a chat from the composer). */
export function FilePickerDialog({
  open,
  max,
  onClose,
  onPick,
}: {
  open: boolean;
  max: number;
  onClose: () => void;
  onPick: (files: FileView[]) => void;
}) {
  const t = useTranslations("files");
  const label = useSpaceLabel();
  const spaces = useQuery(api.files.listSpaces, open ? {} : "skip");
  const [space, setSpace] = useState<string | null>(null);
  const [folderId, setFolderId] = useState<Id<"folders"> | undefined>();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Map<string, FileView>>(new Map());
  const folder = useQuery(api.files.listFolder, open && space && !query.trim() ? { space, folderId } : "skip");
  const results = useQuery(api.files.search, open && query.trim() ? { query: query.trim() } : "skip");

  const close = () => {
    setSpace(null);
    setFolderId(undefined);
    setQuery("");
    setPicked(new Map());
    onClose();
  };
  const toggle = (file: FileView) =>
    setPicked((map) => {
      const next = new Map(map);
      if (next.has(file._id)) next.delete(file._id);
      else if (next.size < max) next.set(file._id, file);
      else toast.error(t("pickLimit", { max }));
      return next;
    });

  const fileRow = (file: FileView, hint?: string) => (
    <label key={file._id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
      <Checkbox checked={picked.has(file._id)} onCheckedChange={() => toggle(file)} />
      <FileTypeIcon contentType={file.contentType} name={file.name} className="size-4" />
      <span className="min-w-0 flex-1 truncate">{file.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{hint ?? formatBytes(file.size)}</span>
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("pickTitle")}</DialogTitle>
          <DialogDescription>{t("pickBody")}</DialogDescription>
        </DialogHeader>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} />
        <ScrollArea className="h-72 rounded-md border border-border">
          <div className="flex flex-col p-1">
            {query.trim() ? (
              results === undefined ? null : results.length === 0 ? (
                <p className="p-3 text-center text-sm text-muted-foreground">{t("noResults")}</p>
              ) : (
                results.map((r) => fileRow(r.file, label(r.space)))
              )
            ) : space === null ? (
              (spaces ?? []).map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSpace(s.key)}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <FolderIcon className="size-4 text-primary" />
                  <span className="flex-1 truncate">{label(s)}</span>
                  <ChevronRightIcon className="size-4 text-muted-foreground" />
                </button>
              ))
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
                  <button type="button" className="hover:text-foreground" onClick={() => setSpace(null)}>
                    {t("allSpaces")}
                  </button>
                  {folder ? (
                    <>
                      <ChevronRightIcon className="size-3" />
                      <button type="button" className="hover:text-foreground" onClick={() => setFolderId(undefined)}>
                        {label(folder.space)}
                      </button>
                      {folder.breadcrumb.map((f) => (
                        <span key={f._id} className="flex items-center gap-1">
                          <ChevronRightIcon className="size-3" />
                          <button type="button" className="hover:text-foreground" onClick={() => setFolderId(f._id)}>
                            {f.name}
                          </button>
                        </span>
                      ))}
                    </>
                  ) : null}
                </div>
                {folder?.folders.map((f) => (
                  <button
                    key={f._id}
                    type="button"
                    onClick={() => setFolderId(f._id)}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <FolderIcon className="size-4 text-primary" />
                    <span className="flex-1 truncate">{f.name}</span>
                    <ChevronRightIcon className="size-4 text-muted-foreground" />
                  </button>
                ))}
                {folder?.files.map((f) => fileRow(f))}
                {folder && folder.folders.length === 0 && folder.files.length === 0 ? (
                  <p className="p-3 text-center text-sm text-muted-foreground">{t("emptyFolder")}</p>
                ) : null}
              </>
            )}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t("cancel")}
          </Button>
          <Button
            disabled={picked.size === 0}
            onClick={() => {
              onPick([...picked.values()]);
              close();
            }}
          >
            {t("pickConfirm", { count: picked.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PreviewDialog({ file, onClose }: { file: FileView | null; onClose: () => void }) {
  const t = useTranslations("files");
  const stored =
    file && !file.drive && file.url
      ? { url: file.url, name: file.name, contentType: file.contentType, size: file.size }
      : null;
  const drive = file?.drive ? file : null;
  return (
    <>
      <FileViewer file={stored} onClose={onClose} />
      <Dialog open={drive !== null} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="truncate pr-6">{drive?.name}</DialogTitle>
            <DialogDescription>{drive ? formatBytes(drive.size) : ""}</DialogDescription>
          </DialogHeader>
          {drive?.previewUrl ? (
            <div className="overflow-hidden rounded-md bg-secondary/40">
              <iframe src={drive.previewUrl} title={drive.name} allow="autoplay" className="h-[70vh] w-full" />
            </div>
          ) : null}
          <DialogFooter>
            {drive?.openUrl ? (
              <Button variant="outline" asChild>
                <a href={drive.openUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLinkIcon />
                  {t("openInDrive")}
                </a>
              </Button>
            ) : null}
            {drive?.url ? (
              <Button asChild>
                <a href={drive.url} target="_blank" rel="noopener noreferrer" download={drive.name}>
                  <DownloadIcon />
                  {t("download")}
                </a>
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
