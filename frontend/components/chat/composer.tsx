"use client";

import { useMutation, useQuery } from "convex/react";
import {
  ClipboardListIcon,
  EyeIcon,
  FileIcon,
  FilePenLineIcon,
  FolderIcon,
  LoaderIcon,
  LockIcon,
  MegaphoneIcon,
  PaperclipIcon,
  PencilIcon,
  ReplyIcon,
  SendIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { useAiCredits } from "@/components/ai/ai-chat";
import { SasaDocPicker, type PickedDoc } from "@/components/ai/doc-picker";
import { useViewer } from "@/components/auth/account-state";
import { chatHasDocs, NewChatDocumentDialog } from "@/components/docs/chat-documents";
import { FilePickerDialog } from "@/components/files/file-dialogs";
import { PersonAvatar } from "@/components/people/person-avatar";
import { matchesPerson } from "@/components/people/use-people";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, LIMITS, mentionToken, type Id } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import { thumbnail, uploadBlob } from "@/lib/image";
import { isImeEnter, useEnterSubmit } from "@/lib/keyboard";
import type { Locale } from "@/lib/locale-store";
import { displayName } from "@/lib/names";
import { cn } from "@/lib/utils";
import { formatBytes } from "./attachments";
import { useChat } from "./chat-context";
import { usePlainPreview } from "./markdown";
import { personById, type Person } from "./types";

const SASA_TEXT = /@(?:sasa\b|小飒)/i;

const THUMBNAIL_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

type Upload = {
  key: string;
  name: string;
  size: number;
  previewUrl?: string;
  attachmentId?: Id<"attachments">;
  failed?: boolean;
};

/** "@Name" labels in the textarea map to `<@id>` tokens when sending. */
type MentionMap = Map<string, string>;

function encodeMentions(text: string, mentions: MentionMap) {
  let result = text;
  const labels = [...mentions.keys()].sort((a, b) => b.length - a.length);
  for (const label of labels) result = result.split(`@${label}`).join(mentionToken(mentions.get(label)!));
  return result;
}

export function Composer({ name }: { name: string }) {
  const { channel } = useChat();
  const t = useTranslations("chat");

  if (channel.access.via === "oversight") {
    return (
      <Banner icon={<EyeIcon className="size-4" />} tone="gold">
        {t("oversightBanner")}
      </Banner>
    );
  }
  if (channel.access.readOnly) {
    return <Banner icon={<LockIcon className="size-4" />}>{t(`readOnly.${channel.access.readOnly}`)}</Banner>;
  }
  if (!channel.access.canPost) {
    return <Banner icon={<LockIcon className="size-4" />}>{t("announcementOnly")}</Banner>;
  }
  return <Editor key={channel._id} name={name} />;
}

function Banner({ icon, children, tone }: { icon: ReactNode; children: ReactNode; tone?: "gold" }) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center gap-2 border-t border-border px-4 py-3 text-center text-sm",
        tone === "gold" ? "bg-primary/10 text-primary" : "text-muted-foreground",
      )}
    >
      {icon}
      {children}
    </div>
  );
}

function Editor({ name }: { name: string }) {
  const t = useTranslations("chat");
  const tAi = useTranslations("ai");
  const locale = useLocale() as Locale;
  const { channel, replyTo, setReplyTo, editing, setEditing } = useChat();
  const send = useMutation(api.messages.send);
  const edit = useMutation(api.messages.edit);
  const generateUploadUrl = useMutation(api.attachments.generateUploadUrl);
  const register = useMutation(api.attachments.register);
  const discard = useMutation(api.attachments.discard);
  const participants = useQuery(api.channels.participants, { channelId: channel._id });
  const showError = useErrorToast();
  const preview = usePlainPreview();

  const viewer = useViewer();
  const canManageTasks =
    (viewer.isAdmin || viewer.ledDepartmentIds.length > 0) &&
    (channel.type === "org" || channel.type === "department" || channel.type === "group");
  const creatable = useQuery(api.assignments.creatableChannels, canManageTasks ? {} : "skip");
  const canCreateTask = creatable?.some((c) => c._id === channel._id) ?? false;

  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState<MentionMap>(new Map());
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [sharedFiles, setSharedFiles] = useState<{ _id: Id<"files">; name: string }[]>([]);
  const [sasaDocs, setSasaDocs] = useState<PickedDoc[]>([]);
  const [pickingFiles, setPickingFiles] = useState(false);
  const [newDoc, setNewDoc] = useState(false);
  const [announce, setAnnounce] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [draftBeforeEdit, setDraftBeforeEdit] = useState<{ body: string; mentions: MentionMap } | null>(null);
  const [loadedEditId, setLoadedEditId] = useState<string | null>(null);

  // Entering edit mode loads the message with mention tokens shown as "@Name".
  if (editing && editing._id !== loadedEditId) {
    const map: MentionMap = new Map();
    const text = editing.body.replace(/<@([a-z0-9]+)>/gi, (_, id: string) => {
      const label = id === "all" ? t("mentionAll") : displayName(personById(editing.people, id), locale);
      map.set(label, id);
      return `@${label}`;
    });
    setLoadedEditId(editing._id);
    if (loadedEditId === null) setDraftBeforeEdit({ body, mentions });
    setBody(text);
    setMentions(map);
  } else if (!editing && loadedEditId !== null) {
    // Leaving edit mode (saved, cancelled, or replaced by a reply) brings back the earlier draft.
    setLoadedEditId(null);
    setBody(draftBeforeEdit?.body ?? "");
    setMentions(draftBeforeEdit?.mentions ?? new Map());
    setDraftBeforeEdit(null);
  }

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  const candidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const people: (Person | "all")[] = (participants ?? []).filter((p) => matchesPerson(p, mentionQuery));
    if (channel.access.canMentionAll && (t("mentionAll").includes(mentionQuery) || "all".includes(mentionQuery.toLowerCase()))) {
      people.unshift("all");
    }
    return people.slice(0, 8);
  }, [mentionQuery, participants, channel.access.canMentionAll, t]);

  const uploading = uploads.some((u) => !u.attachmentId && !u.failed);
  const readyIds = uploads.flatMap((u) => (u.attachmentId ? [u.attachmentId] : []));
  const encoded = encodeMentions(body, mentions).trim();
  const tooLong = encoded.length > LIMITS.messageBody;
  const sendable =
    !uploading && !tooLong && (encoded.length > 0 || (!editing && (readyIds.length > 0 || sharedFiles.length > 0)));
  const announcing = announce && !editing && channel.access.canAnnounce;
  const assistant = channel.type === "assistant";
  const credits = useAiCredits();
  const sasaId = participants?.find((p) => p.isBot)?._id;
  const asking =
    !editing &&
    (assistant || (channel.aiEnabled && (SASA_TEXT.test(body) || (sasaId !== undefined && encoded.includes(mentionToken(sasaId))))));
  const noCredits = asking && credits !== undefined && !credits.unlimited && credits.balance === 0;
  const waiting = asking && credits?.inFlight === true;
  const aiBlocked = asking && (noCredits || waiting || credits?.configured === false);
  const canSend = sendable && !aiBlocked;
  const placeholder = assistant
    ? tAi("placeholder")
    : t(announcing ? "announcementPlaceholder" : "messagePlaceholder", { name });
  const hint = !asking
    ? null
    : credits?.configured === false
      ? tAi("notConfigured")
      : noCredits
        ? tAi("noCredits")
        : waiting
          ? tAi("waiting")
          : credits?.unlimited
            ? tAi("askHintUnlimited")
            : credits
              ? tAi("askHint", { balance: credits.balance })
              : null;

  const resetDraft = () => {
    setBody("");
    setMentions(new Map());
  };

  const submit = async () => {
    if (!canSend) return;
    if (editing) {
      const target = editing;
      try {
        await edit({ messageId: target._id, body: encoded });
        setEditing(null);
      } catch (error) {
        showError(error);
      }
      return;
    }
    const snapshot = { body, mentions, uploads, sharedFiles, sasaDocs, replyTo, announcing };
    const documentIds = asking && sasaDocs.length > 0 ? sasaDocs.map((d) => d._id) : undefined;
    resetDraft();
    setUploads([]);
    setSharedFiles([]);
    setSasaDocs([]);
    setReplyTo(null);
    setAnnounce(false);
    try {
      await send({
        channelId: channel._id,
        body: encoded,
        replyToId: snapshot.replyTo?._id,
        attachmentIds: readyIds.length ? readyIds : undefined,
        fileIds: snapshot.sharedFiles.length ? snapshot.sharedFiles.map((f) => f._id) : undefined,
        announcement: snapshot.announcing || undefined,
        documentIds,
      });
    } catch (error) {
      setBody(snapshot.body);
      setMentions(snapshot.mentions);
      setUploads(snapshot.uploads);
      setSharedFiles(snapshot.sharedFiles);
      setSasaDocs(snapshot.sasaDocs);
      setReplyTo(snapshot.replyTo);
      setAnnounce(snapshot.announcing);
      showError(error);
    }
  };

  const cancelEdit = () => setEditing(null);
  const enter = useEnterSubmit(() => void submit());

  const updateMentionQuery = (text: string, caret: number) => {
    const match = /(?:^|\s)@([^\s@]{0,20})$/.exec(text.slice(0, caret));
    setMentionQuery(match ? match[1] : null);
    setMentionIndex(0);
  };

  const pickMention = (choice: Person | "all") => {
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = body.slice(0, caret).replace(/@([^\s@]{0,20})$/, "");
    const label = choice === "all" ? t("mentionAll") : displayName(choice, locale);
    const id = choice === "all" ? "all" : choice._id;
    const next = `${before}@${label} ${body.slice(caret)}`;
    setBody(next);
    setMentions((m) => new Map(m).set(label, id));
    setMentionQuery(null);
    requestAnimationFrame(() => {
      const position = before.length + label.length + 2;
      el.focus();
      el.setSelectionRange(position, position);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && candidates.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setMentionIndex((i) => (i + delta + candidates.length) % candidates.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !isImeEnter(event.nativeEvent)) {
        event.preventDefault();
        pickMention(candidates[mentionIndex]);
        return;
      }
      if (event.key === "Escape") {
        setMentionQuery(null);
        return;
      }
    }
    if (event.key === "Escape") {
      if (editing) cancelEdit();
      else if (replyTo) setReplyTo(null);
      return;
    }
    enter.onKeyDown(event);
  };

  const addFiles = (files: File[]) => {
    for (const file of files) {
      if (uploads.length + files.length > LIMITS.attachmentsPerMessage) {
        toast.error(t("tooManyFiles", { max: LIMITS.attachmentsPerMessage }));
        return;
      }
      if (file.size > LIMITS.attachmentBytes) {
        toast.error(t("fileTooLarge", { name: file.name }), { duration: 8000 });
        continue;
      }
      const key = `${file.name}-${file.size}-${Math.random()}`;
      const isImage = THUMBNAIL_TYPES.has(file.type);
      setUploads((list) => [
        ...list,
        { key, name: file.name, size: file.size, previewUrl: isImage ? URL.createObjectURL(file) : undefined },
      ]);
      void (async () => {
        try {
          const storageId = await uploadBlob(await generateUploadUrl(), file);
          let thumbStorageId: string | undefined;
          if (isImage) {
            try {
              thumbStorageId = await uploadBlob(await generateUploadUrl(), await thumbnail(file));
            } catch {
              thumbStorageId = undefined;
            }
          }
          const attachmentId = await register({
            storageId: storageId as Id<"_storage">,
            thumbStorageId: thumbStorageId as Id<"_storage"> | undefined,
            name: file.name,
          });
          setUploads((list) => list.map((u) => (u.key === key ? { ...u, attachmentId } : u)));
        } catch (error) {
          setUploads((list) => list.map((u) => (u.key === key ? { ...u, failed: true } : u)));
          showError(error);
        }
      })();
    }
  };

  const removeUpload = (upload: Upload) => {
    setUploads((list) => list.filter((u) => u.key !== upload.key));
    if (upload.previewUrl) URL.revokeObjectURL(upload.previewUrl);
    if (upload.attachmentId) void discard({ attachmentId: upload.attachmentId }).catch(() => undefined);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (editing) return;
    const files = [...event.clipboardData.files];
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
    }
  };

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles([...(event.target.files ?? [])]);
    event.target.value = "";
  };

  return (
    <div className={cn("relative shrink-0 border-t p-3", announcing ? "border-warning/60 bg-warning/5" : "border-border")}>
      {mentionQuery !== null && candidates.length > 0 ? (
        <div className="absolute bottom-full left-3 z-20 mb-1 w-72 overflow-hidden rounded-md border border-border bg-popover p-1 shadow-md">
          {candidates.map((c, i) => (
            <button
              key={c === "all" ? "all" : c._id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(c);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm",
                i === mentionIndex ? "bg-accent" : "hover:bg-accent",
              )}
            >
              {c === "all" ? (
                <span className="flex size-6 items-center justify-center rounded-full bg-primary/20 text-xs text-primary">@</span>
              ) : (
                <PersonAvatar person={c} className="size-6" />
              )}
              <span className="truncate">{c === "all" ? t("mentionAllHint") : displayName(c, locale)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {announcing ? (
        <div className="mb-2 flex items-center gap-2 text-xs text-warning">
          <MegaphoneIcon className="size-3.5" />
          {t("announceOn")}
        </div>
      ) : null}

      {editing || replyTo ? (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-secondary/50 px-2.5 py-1.5 text-xs text-muted-foreground">
          {editing ? <PencilIcon className="size-3.5" /> : <ReplyIcon className="size-3.5" />}
          <span className="min-w-0 flex-1 truncate">
            {editing
              ? t("editingMessage")
              : t("replyingTo", {
                  name: displayName(personById(replyTo!.people, replyTo!.authorId), locale),
                  text: preview(replyTo!.body, replyTo!.people, 60) || t("attachmentOnly"),
                })}
          </span>
          <Button size="icon-xs" variant="ghost" aria-label={t("cancel")} onClick={editing ? cancelEdit : () => setReplyTo(null)}>
            <XIcon />
          </Button>
        </div>
      ) : null}

      {asking && credits?.configured !== false ? (
        <div className="mb-2">
          <SasaDocPicker channelId={channel._id} shared={!assistant} picked={sasaDocs} onChange={setSasaDocs} />
        </div>
      ) : null}

      {sharedFiles.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {sharedFiles.map((f) => (
            <div
              key={f._id}
              className="relative flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 py-1.5 pr-7 pl-2 text-xs"
            >
              <FolderIcon className="size-4 text-primary" />
              <span className="max-w-40 truncate">{f.name}</span>
              <button
                type="button"
                aria-label={t("removeFile")}
                onClick={() => setSharedFiles((list) => list.filter((x) => x._id !== f._id))}
                className="absolute top-1 right-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {uploads.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {uploads.map((u) => (
            <div key={u.key} className="relative flex items-center gap-2 rounded-md border border-border bg-secondary/40 py-1 pr-7 pl-1 text-xs">
              {u.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
                <img src={u.previewUrl} alt="" className="size-9 rounded object-cover" />
              ) : (
                <FileIcon className="m-2 size-5 text-muted-foreground" />
              )}
              <div className="min-w-0">
                <div className="max-w-36 truncate">{u.name}</div>
                <div className={cn("text-[11px]", u.failed ? "text-destructive" : "text-muted-foreground")}>
                  {u.failed ? t("uploadFailed") : u.attachmentId ? formatBytes(u.size) : t("uploading")}
                </div>
              </div>
              {!u.attachmentId && !u.failed ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
              <button
                type="button"
                aria-label={t("removeFile")}
                onClick={() => removeUpload(u)}
                className="absolute top-1 right-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        {!editing && !assistant ? (
          <>
            <input ref={fileRef} type="file" multiple hidden onChange={onFileInput} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-lg" variant="ghost" aria-label={t("attach")}>
                  <PaperclipIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top">
                <DropdownMenuItem onSelect={() => fileRef.current?.click()}>
                  <UploadIcon />
                  {t("attachUpload", { days: LIMITS.attachmentRetentionDays })}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPickingFiles(true)}>
                  <FolderIcon />
                  {t("attachFromFiles")}
                </DropdownMenuItem>
                {chatHasDocs(channel.type) ? (
                  <DropdownMenuItem onSelect={() => setNewDoc(true)}>
                    <FilePenLineIcon />
                    {t("newDocument")}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
            {chatHasDocs(channel.type) ? (
              <NewChatDocumentDialog channelId={channel._id} open={newDoc} onClose={() => setNewDoc(false)} />
            ) : null}
            <FilePickerDialog
              open={pickingFiles}
              max={LIMITS.sharedFilesPerMessage - sharedFiles.length}
              onClose={() => setPickingFiles(false)}
              onPick={(files) =>
                setSharedFiles((list) => [
                  ...list,
                  ...files.filter((f) => !list.some((x) => x._id === f._id)).map((f) => ({ _id: f._id, name: f.name })),
                ])
              }
            />
            {canCreateTask ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button asChild size="icon-lg" variant="ghost" aria-label={t("newTask")}>
                    <Link href={`/assignments/new/?c=${channel._id}`}>
                      <ClipboardListIcon />
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("newTask")}</TooltipContent>
              </Tooltip>
            ) : null}
            {channel.access.canAnnounce ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-lg"
                    variant="ghost"
                    aria-label={t("announce")}
                    aria-pressed={announce}
                    className={cn(announce && "bg-warning/15 text-warning hover:bg-warning/20 hover:text-warning")}
                    onClick={() => setAnnounce((on) => !on)}
                  >
                    <MegaphoneIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("announce")}</TooltipContent>
              </Tooltip>
            ) : null}
          </>
        ) : null}
        <Textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            updateMentionQuery(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={enter.onKeyUp}
          onPaste={onPaste}
          onBlur={() => setTimeout(() => setMentionQuery(null), 150)}
          placeholder={placeholder}
          aria-label={placeholder}
          rows={1}
          className="max-h-40 min-h-9 resize-none"
        />
        <Button size="icon-lg" onClick={() => void submit()} disabled={!canSend} aria-label={editing ? t("saveEdit") : t("send")}>
          <SendIcon />
        </Button>
      </div>
      {tooLong ? (
        <p className="mt-1 text-xs text-destructive">{t("tooLong", { max: LIMITS.messageBody })}</p>
      ) : hint ? (
        <p className={cn("mt-1 text-xs", aiBlocked ? "text-destructive" : "text-primary")}>{hint}</p>
      ) : (
        <p className="mt-1 hidden text-xs text-subtle-foreground md:block">{t("sendHint")}</p>
      )}
    </div>
  );
}