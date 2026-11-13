"use client";

import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowLeftIcon, CalendarDaysIcon, ClipboardListIcon, PaperclipIcon, PlusIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Suspense, useRef, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { SasaAvatar } from "@/components/ai/sasa-avatar";
import { FileTypeIcon } from "@/components/files/file-icon";
import { UploadPanel } from "@/components/files/upload-panel";
import { useFileUpload } from "@/components/files/use-file-upload";
import { PageHeader } from "@/components/layout/app-shell";
import { MentionTextarea } from "@/components/docs/mention-textarea";
import { PersonAvatar } from "@/components/people/person-avatar";
import { PersonPicker } from "@/components/people/person-picker";
import { fromLocalInput, toLocalInput, useTaskChatName } from "@/components/tasks/task-format";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, LIMITS, type Id } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import type { Locale } from "@/lib/locale-store";
import { displayName, localized } from "@/lib/names";
import { cn } from "@/lib/utils";

const PUBLIC = "public";

export default function NewAssignmentPage() {
  return (
    <Suspense>
      <NewAssignment />
    </Suspense>
  );
}

function NewAssignment() {
  const params = useSearchParams();
  const editId = params.get("a") as Id<"assignments"> | null;
  const existing = useQuery(api.assignments.get, editId ? { assignmentId: editId } : "skip");
  const creatable = useQuery(api.assignments.creatableChannels);
  const suggestionId = params.get("s") as Id<"aiSuggestions"> | null;
  const suggestion = useQuery(api.ai.getSuggestion, suggestionId ? { suggestionId } : "skip");
  if (creatable === undefined || (editId && existing === undefined) || (suggestionId && suggestion === undefined)) {
    return (
      <>
        <PageHeader title="" />
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      </>
    );
  }
  // A card already used, or meant for another task, opens the plain form.
  const usable =
    suggestion &&
    suggestion.status === "pending" &&
    suggestion.canAct &&
    (editId ? suggestion.action === "edit" && suggestion.assignmentId === editId : suggestion.action !== "edit")
      ? suggestion
      : null;
  return (
    <TaskForm
      key={`${editId ?? "new"}:${usable?._id ?? ""}`}
      creatable={creatable}
      existing={existing ?? null}
      suggestion={usable}
      initialChannel={(params.get("c") as Id<"channels"> | null) ?? undefined}
      initialEvent={(params.get("event") as Id<"assignments"> | null) ?? undefined}
      initialKind={params.get("kind") === "event" ? "event" : "task"}
    />
  );
}

type Creatable = FunctionReturnType<typeof api.assignments.creatableChannels>;
type Existing = NonNullable<FunctionReturnType<typeof api.assignments.get>>;
type Suggestion = NonNullable<FunctionReturnType<typeof api.ai.getSuggestion>>;

function TaskForm({
  creatable,
  existing,
  suggestion,
  initialChannel,
  initialEvent,
  initialKind,
}: {
  creatable: Creatable;
  existing: Existing | null;
  /** 小飒's suggestion card the form was opened from; its fields prefill the form. */
  suggestion: Suggestion | null;
  initialChannel?: Id<"channels">;
  initialEvent?: Id<"assignments">;
  initialKind: "task" | "event";
}) {
  const t = useTranslations("tasks");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const chatName = useTaskChatName();
  const create = useMutation(api.assignments.create);
  const update = useMutation(api.assignments.update);
  const addAssignees = useMutation(api.assignments.addAssignees);
  const publish = useMutation(api.assignments.publish);
  const showError = useErrorToast();
  const { upload, items, dismiss, clearDone, busy: uploading } = useFileUpload();
  const fileInput = useRef<HTMLInputElement>(null);

  const a = existing?.assignment;
  const isDraft = !a || a.status === "draft";
  const s = suggestion?.fields;
  const suggestedChannel = suggestion?.channelId ?? initialChannel;
  const [channelId, setChannelId] = useState<string>(
    existing?.channel?._id ??
      (creatable.some((c) => c._id === suggestedChannel) ? suggestedChannel! : (creatable[0]?._id ?? "")),
  );
  const [kind, setKind] = useState<"task" | "event">(
    a?.kind ?? (suggestion ? (suggestion.action === "create_event" ? "event" : "task") : initialKind),
  );
  const [title, setTitle] = useState(s?.title ?? a?.title ?? "");
  const [description, setDescription] = useState(s?.description ?? a?.description ?? "");
  const [due, setDue] = useState(toLocalInput(s?.dueAt ?? a?.dueAt));
  const [start, setStart] = useState(toLocalInput(s?.startAt ?? a?.startAt));
  const [end, setEnd] = useState(toLocalInput(s?.endAt ?? a?.endAt));
  const [location, setLocation] = useState(s?.location ?? a?.location ?? "");
  const [requiresSubmission, setRequiresSubmission] = useState(a?.requiresSubmission ?? true);
  const [autoApprove, setAutoApprove] = useState(a?.autoApprove ?? false);
  const [eventId, setEventId] = useState<string>(a?.eventId ?? initialEvent ?? "");
  const [space, setSpace] = useState<string>(a ? (a.departmentId ?? PUBLIC) : "");
  const suggestedPeople = s?.assigneeIds ?? [];
  const [everyone, setEveryone] = useState(a ? a.draftEveryone : suggestedPeople.length === 0);
  const [assigneeIds, setAssigneeIds] = useState<string[]>(a?.draftAssigneeIds ?? suggestedPeople);
  // Open tasks manage assignees on the task page; a suggestion's new people are added on save.
  const [addingIds, setAddingIds] = useState<string[]>(
    a && !isDraft ? suggestedPeople.filter((id) => !existing.assignees.some((x) => x.userId === id)) : [],
  );
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState<File[]>([]);
  const [fileIds, setFileIds] = useState<Id<"files">[]>(existing?.files.map((f) => f._id) ?? []);
  const [busy, setBusy] = useState(false);

  const channel = creatable.find((c) => c._id === channelId);
  const chatOptions =
    a && existing?.channel
      ? [{ _id: existing.channel._id, label: chatName(existing.channel) }]
      : creatable.map((c) => ({ _id: c._id, label: chatName(c) }));
  const audience = useQuery(api.assignments.audience, channelId ? { channelId: channelId as Id<"channels"> } : "skip");
  const spaces = channel?.spaces ?? [];
  const spaceValue = space || (spaces[0] ? (spaces[0].departmentId ?? PUBLIC) : "");
  const people = audience?.people ?? [];
  const picked = assigneeIds.flatMap((id) => people.find((p) => p._id === id) ?? []);
  const adding = addingIds.flatMap((id) => people.find((p) => p._id === id) ?? []);
  const existingFiles = existing?.files.filter((f) => fileIds.includes(f._id)) ?? [];

  const startMs = fromLocalInput(start);
  const endMs = fromLocalInput(end);
  const descriptionTooLong = description.length > LIMITS.taskDescription;
  const nobodyInChat = everyone && audience !== undefined && people.length === 0;
  const invalidEnd = kind === "event" && startMs !== undefined && endMs !== undefined && endMs <= startMs;
  const canSave =
    !busy &&
    !uploading &&
    title.trim().length > 0 &&
    (channel !== undefined || Boolean(a)) &&
    (kind === "task" || startMs !== undefined) &&
    !invalidEnd &&
    !descriptionTooLong &&
    (!isDraft || everyone || assigneeIds.length > 0);

  const fields = () => ({
    title: title.trim(),
    description: description.trim(),
    location: kind === "event" ? location.trim() : undefined,
    requiresSubmission: kind === "task" ? requiresSubmission : false,
    autoApprove: kind === "task" && !requiresSubmission ? autoApprove : false,
  });
  const departmentId = spaceValue && spaceValue !== PUBLIC ? (spaceValue as Id<"departments">) : undefined;

  const submit = async (andPublish: boolean) => {
    if (!canSave) return;
    setBusy(true);
    try {
      let id: Id<"assignments">;
      if (!a) {
        if (!channel) return;
        id = await create({
          channelId: channel._id,
          kind,
          ...fields(),
          dueAt: kind === "task" ? fromLocalInput(due) : undefined,
          startAt: kind === "event" ? startMs : undefined,
          endAt: kind === "event" ? endMs : undefined,
          eventId: kind === "task" && eventId ? (eventId as Id<"assignments">) : undefined,
          departmentId,
          assigneeIds: everyone ? [] : (assigneeIds as Id<"users">[]),
          everyone,
          publish: andPublish && pending.length === 0,
          suggestionId: suggestion?._id,
        });
        if (pending.length > 0) {
          const uploaded = await upload(pending, { assignmentId: id });
          if (uploaded.length > 0) await update({ assignmentId: id, fileIds: uploaded });
          if (andPublish) await publish({ assignmentId: id });
        }
      } else {
        id = a._id;
        await update({
          assignmentId: id,
          ...fields(),
          dueAt: kind === "task" ? (fromLocalInput(due) ?? null) : undefined,
          startAt: kind === "event" ? startMs : undefined,
          endAt: kind === "event" ? (endMs ?? null) : undefined,
          eventId: kind === "task" ? (eventId ? (eventId as Id<"assignments">) : null) : undefined,
          departmentId: isDraft ? (departmentId ?? null) : undefined,
          fileIds,
          ...(isDraft ? { assigneeIds: everyone ? [] : (assigneeIds as Id<"users">[]), everyone } : {}),
          suggestionId: suggestion?._id,
        });
        if (!isDraft && adding.length > 0) await addAssignees({ assignmentId: id, userIds: adding.map((p) => p._id) });
        if (andPublish && isDraft) await publish({ assignmentId: id });
      }
      toast.success(andPublish ? t("published") : t("saved"));
      router.push(`/assignments/view/?a=${id}`);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    if (pending.length + fileIds.length + files.length > LIMITS.taskFiles) {
      toast.error(t("tooManyFiles", { max: LIMITS.taskFiles }));
      return;
    }
    if (a) {
      const uploaded = await upload(files, { assignmentId: a._id });
      setFileIds((list) => [...list, ...uploaded]);
    } else {
      setPending((list) => [...list, ...files]);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit(!isDraft);
  };

  if (creatable.length === 0 && !a) {
    return (
      <>
        <PageHeader title={t("new")} />
        <p className="m-auto p-6 text-center text-sm text-muted-foreground">{t("cannotCreate")}</p>
      </>
    );
  }

  return (
    <>
      <PageHeader title={a ? t("editTitle") : kind === "event" ? t("newEvent") : t("newTask")}>
        <Button asChild size="sm" variant="ghost">
          <Link href={a ? `/assignments/view/?a=${a._id}` : "/assignments/"}>
            <ArrowLeftIcon />
            {t("back")}
          </Link>
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <form onSubmit={onSubmit} className="mx-auto flex max-w-2xl flex-col gap-5 p-4">
          {suggestion ? (
            <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
              <SasaAvatar className="size-10" />
              <p>{t("fromSasa")}</p>
            </div>
          ) : null}
          {!a ? (
            <div className="grid grid-cols-2 gap-2">
              <KindButton active={kind === "task"} onClick={() => setKind("task")} icon={<ClipboardListIcon />} label={t("kindTask")} hint={t("kindTaskHint")} />
              <KindButton active={kind === "event"} onClick={() => setKind("event")} icon={<CalendarDaysIcon />} label={t("kindEvent")} hint={t("kindEventHint")} />
            </div>
          ) : null}

          <Field label={t("chat")} hint={t("chatHint")}>
            <Select
              value={channelId}
              disabled={Boolean(a)}
              onValueChange={(v) => {
                setChannelId(v);
                setSpace("");
                setAssigneeIds([]);
                setEventId("");
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("pickChat")} />
              </SelectTrigger>
              <SelectContent>
                {chatOptions.map((c) => (
                  <SelectItem key={c._id} value={c._id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label={t("titleLabel")}>
            <Input value={title} maxLength={LIMITS.taskTitle} onChange={(e) => setTitle(e.target.value)} required />
          </Field>
          <Field label={t("descriptionLabel")}>
            <MentionTextarea
              defaultValue={description}
              onChange={setDescription}
              people={people}
              known={existing?.people}
              rows={4}
              aria-invalid={descriptionTooLong || undefined}
              placeholder={kind === "event" ? t("eventDescriptionPlaceholder") : t("descriptionPlaceholder")}
            />
            {descriptionTooLong ? (
              <p className="text-xs text-destructive">{t("descriptionTooLong", { max: LIMITS.taskDescription })}</p>
            ) : null}
          </Field>

          {kind === "task" ? (
            <>
              <Field label={t("dueLabel")} hint={t("dueHint")}>
                <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
              </Field>
              <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                <label className={cn("flex items-start gap-2 text-sm", !isDraft && "opacity-60")}>
                  <Checkbox
                    checked={requiresSubmission}
                    disabled={!isDraft}
                    onCheckedChange={(v) => setRequiresSubmission(v === true)}
                    className="mt-0.5"
                  />
                  <span>
                    {t("requiresSubmission")}
                    <span className="block text-xs text-muted-foreground">{t("requiresSubmissionHint")}</span>
                  </span>
                </label>
                {!requiresSubmission ? (
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox checked={autoApprove} onCheckedChange={(v) => setAutoApprove(v === true)} className="mt-0.5" />
                    <span>
                      {t("autoApprove")}
                      <span className="block text-xs text-muted-foreground">{t("autoApproveHint")}</span>
                    </span>
                  </label>
                ) : null}
              </div>
              {audience && audience.events.length > 0 ? (
                <Field label={t("partOfEvent")} hint={t("partOfEventHint")}>
                  <Select value={eventId || "none"} onValueChange={(v) => setEventId(v === "none" ? "" : v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t("noEvent")}</SelectItem>
                      {audience.events.map((e) => (
                        <SelectItem key={e._id} value={e._id}>
                          {e.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
            </>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("startLabel")}>
                  <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required />
                </Field>
                <Field label={t("endLabel")} error={invalidEnd ? t("endBeforeStart") : undefined}>
                  <Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
                </Field>
              </div>
              <Field label={t("locationLabel")}>
                <Input value={location} maxLength={LIMITS.taskLocation} onChange={(e) => setLocation(e.target.value)} />
              </Field>
            </>
          )}

          <Field label={kind === "event" ? t("helpers") : t("assignees")}>
            {isDraft ? (
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={everyone} onCheckedChange={(v) => setEveryone(v === true)} />
                  {t("everyoneInChat", { count: people.length })}
                </label>
                {nobodyInChat ? <p className="text-xs text-destructive">{t("nobodyInChat")}</p> : null}
                {!everyone ? (
                  <div className="flex flex-wrap gap-1.5">
                    {picked.map((p) => (
                      <span key={p._id} className="flex items-center gap-1.5 rounded-full bg-secondary py-0.5 pr-1 pl-0.5 text-xs">
                        <PersonAvatar person={p} className="size-5" />
                        {displayName(p, locale)}
                        <button
                          type="button"
                          aria-label={t("remove")}
                          onClick={() => setAssigneeIds((ids) => ids.filter((id) => id !== p._id))}
                          className="rounded-full p-0.5 hover:bg-accent"
                        >
                          <XIcon className="size-3" />
                        </button>
                      </span>
                    ))}
                    <Button type="button" size="xs" variant="outline" onClick={() => setPicking(true)}>
                      <PlusIcon />
                      {t("addPeople")}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {adding.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">{t("sasaAdds")}</span>
                    {adding.map((p) => (
                      <span key={p._id} className="flex items-center gap-1.5 rounded-full bg-primary/10 py-0.5 pr-1 pl-0.5">
                        <PersonAvatar person={p} className="size-5" />
                        {displayName(p, locale)}
                        <button
                          type="button"
                          aria-label={t("remove")}
                          onClick={() => setAddingIds((ids) => ids.filter((id) => id !== p._id))}
                          className="rounded-full p-0.5 hover:bg-accent"
                        >
                          <XIcon className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <p className="text-sm text-muted-foreground">{t("assigneesOnTaskPage")}</p>
              </div>
            )}
          </Field>

          <Field label={t("attachments")} hint={t("attachmentsHint", { max: formatBytes(LIMITS.fileBytes), driveMax: formatBytes(LIMITS.driveFileBytes) })}>
            <div className="flex flex-col gap-2">
              {existingFiles.map((f) => (
                <FileChip key={f._id} name={f.name} size={f.size} contentType={f.contentType} onRemove={() => setFileIds((ids) => ids.filter((id) => id !== f._id))} />
              ))}
              {fileIds
                .filter((id) => !existingFiles.some((f) => f._id === id))
                .map((id) => {
                  const item = items.find((i) => i.fileId === id);
                  return item ? (
                    <FileChip key={id} name={item.name} size={item.size} contentType="" onRemove={() => setFileIds((ids) => ids.filter((x) => x !== id))} />
                  ) : null;
                })}
              {pending.map((file, i) => (
                <FileChip
                  key={`${file.name}-${i}`}
                  name={file.name}
                  size={file.size}
                  contentType={file.type}
                  onRemove={() => setPending((list) => list.filter((_, j) => j !== i))}
                />
              ))}
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void addFiles([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
              <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => fileInput.current?.click()}>
                <PaperclipIcon />
                {t("addFiles")}
              </Button>
            </div>
          </Field>

          {spaces.length > 1 && isDraft ? (
            <Field label={t("fileSpace")} hint={t("fileSpaceHint")}>
              <Select value={spaceValue} onValueChange={setSpace}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {spaces.map((s) => (
                    <SelectItem key={s.departmentId ?? PUBLIC} value={s.departmentId ?? PUBLIC}>
                      {localized(s.nameZh, s.nameEn, locale)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
            {isDraft ? (
              <>
                <Button type="button" variant="outline" disabled={!canSave} onClick={() => void submit(false)}>
                  {t("saveDraft")}
                </Button>
                <Button type="button" disabled={!canSave || nobodyInChat} onClick={() => void submit(true)}>
                  {t("publish")}
                </Button>
              </>
            ) : (
              <Button type="submit" disabled={!canSave}>
                {t("saveChanges")}
              </Button>
            )}
          </div>
          {isDraft ? <p className="text-right text-xs text-muted-foreground">{t("publishHint")}</p> : null}
        </form>
      </div>
      <UploadPanel items={items} onDismiss={dismiss} onClear={clearDone} className="fixed right-4 bottom-20 z-30 w-72 md:bottom-4" />
      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("addPeople")}</DialogTitle>
          </DialogHeader>
          <PersonPicker
            people={people.filter((p) => !assigneeIds.includes(p._id))}
            onPick={(p) => setAssigneeIds((ids) => (ids.includes(p._id) ? ids : [...ids, p._id]))}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function KindButton({ active, onClick, icon, label, hint }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; hint: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3 text-left text-sm transition-colors [&_svg]:size-5 [&_svg]:shrink-0",
        active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {icon}
      <span>
        <span className="block font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function FileChip({ name, size, contentType, onRemove }: { name: string; size: number; contentType: string; onRemove: () => void }) {
  const t = useTranslations("tasks");
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5 text-sm">
      <FileTypeIcon contentType={contentType} name={name} className="size-4" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="text-xs text-muted-foreground">{formatBytes(size)}</span>
      <button type="button" aria-label={t("remove")} onClick={onRemove} className="rounded p-0.5 text-muted-foreground hover:bg-accent">
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
