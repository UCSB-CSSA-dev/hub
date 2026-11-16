"use client";

import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  ArrowLeftIcon,
  CalendarDaysIcon,
  CheckCheckIcon,
  CheckIcon,
  ClipboardListIcon,
  ExternalLinkIcon,
  FolderIcon,
  LinkIcon,
  LockIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
  Trash2Icon,
  UserMinusIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Suspense, useRef, useState } from "react";
import { toast } from "sonner";
import { MarkdownView } from "@/components/docs/markdown-view";
import { TaskDocuments } from "@/components/docs/task-documents";
import { FileTypeIcon } from "@/components/files/file-icon";
import { FileViewer } from "@/components/files/file-viewer";
import { UploadPanel } from "@/components/files/upload-panel";
import { useFileUpload } from "@/components/files/use-file-upload";
import { PageHeader } from "@/components/layout/app-shell";
import { PersonAvatar } from "@/components/people/person-avatar";
import { PersonPicker } from "@/components/people/person-picker";
import {
  isOverdue,
  SubmissionBadge,
  TaskStatusBadge,
  useTaskChatName,
  useTaskWhen,
  type SubmissionStatus,
} from "@/components/tasks/task-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, LIMITS, type Id } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import type { FileSource } from "@/lib/file-cache";
import { formatBytes } from "@/lib/format";
import { docHref } from "@/lib/links";
import type { Locale } from "@/lib/locale-store";
import { displayName, localized } from "@/lib/names";
import { cn } from "@/lib/utils";

type Task = NonNullable<FunctionReturnType<typeof api.assignments.get>>;
type TaskFile = Task["files"][number];

export default function AssignmentViewPage() {
  return (
    <Suspense>
      <AssignmentView />
    </Suspense>
  );
}

function AssignmentView() {
  const t = useTranslations("tasks");
  const params = useSearchParams();
  const id = params.get("a") as Id<"assignments"> | null;
  const submissionId = params.get("s") as Id<"assignmentSubmissions"> | null;
  const task = useQuery(api.assignments.get, id ? { assignmentId: id } : "skip");

  if (!id || task === null) {
    return (
      <>
        <PageHeader title={t("title")} />
        <div className="m-auto flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-sm text-muted-foreground">{t("notFound")}</p>
          <Button asChild size="sm" variant="secondary">
            <Link href="/assignments/">{t("back")}</Link>
          </Button>
        </div>
      </>
    );
  }
  if (task === undefined) {
    return (
      <>
        <PageHeader title="" />
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-48" />
        </div>
      </>
    );
  }
  return <TaskDetail task={task} submissionId={submissionId} />;
}

function TaskDetail({ task, submissionId }: { task: Task; submissionId: Id<"assignmentSubmissions"> | null }) {
  const t = useTranslations("tasks");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const when = useTaskWhen();
  const chatName = useTaskChatName();
  const { assignment: a, access } = task;
  const isEvent = a.kind === "event";
  const Icon = isEvent ? CalendarDaysIcon : ClipboardListIcon;
  const spaceName = localized(task.space.nameZh, task.space.nameEn, locale);
  const folderHref = task.folderId ? `/files/?s=${task.space.key}&f=${task.folderId}` : null;
  const openSubmission = (id: Id<"assignmentSubmissions"> | null) =>
    router.replace(id ? `/assignments/view/?a=${a._id}&s=${id}` : `/assignments/view/?a=${a._id}`);

  return (
    <>
      <PageHeader title={a.title}>
        <Button asChild size="sm" variant="ghost" className="hidden sm:inline-flex">
          <Link href="/assignments/">
            <ArrowLeftIcon />
            {t("back")}
          </Link>
        </Button>
        {access.canEdit ? <ManageMenu task={task} /> : null}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
          <Card>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="flex items-center gap-1.5 font-medium text-primary">
                  <Icon className="size-4" />
                  {isEvent ? t("kindEvent") : t("kindTask")}
                </span>
                {a.status === "draft" ? <Badge variant="outline">{t("taskStatus.draft")}</Badge> : null}
                <TaskStatusBadge status={a.status === "draft" ? "open" : a.status} ended={a.ended} />
                {!isEvent && !a.requiresSubmission ? <Badge variant="secondary">{t("checklistTask")}</Badge> : null}
              </div>
              <h2 className="text-lg font-semibold">{a.title}</h2>
              <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
                <dt className="text-muted-foreground">{isEvent ? t("time") : t("dueLabel")}</dt>
                <dd>{when(a)}</dd>
                {task.channel ? (
                  <>
                    <dt className="text-muted-foreground">{t("chat")}</dt>
                    <dd>
                      <Link href={`/chat/?c=${task.channel._id}`} className="inline-flex items-center gap-1 hover:text-primary">
                        <MessageSquareIcon className="size-3.5" />
                        {chatName(task.channel)}
                      </Link>
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">{t("createdBy")}</dt>
                <dd className="flex items-center gap-1.5">
                  {task.creator ? <PersonAvatar person={task.creator} className="size-5" /> : null}
                  {task.creator ? displayName(task.creator, locale) : "?"}
                </dd>
                {folderHref ? (
                  <>
                    <dt className="text-muted-foreground">{t("folder")}</dt>
                    <dd>
                      <Link href={folderHref} className="inline-flex items-center gap-1 hover:text-primary">
                        <FolderIcon className="size-3.5" />
                        {spaceName} / {t("tasksFolder")}
                      </Link>
                    </dd>
                  </>
                ) : null}
                {task.event ? (
                  <>
                    <dt className="text-muted-foreground">{t("partOfEvent")}</dt>
                    <dd>
                      <Link href={`/assignments/view/?a=${task.event._id}`} className="inline-flex items-center gap-1 hover:text-primary">
                        <CalendarDaysIcon className="size-3.5" />
                        {task.event.title}
                      </Link>
                    </dd>
                  </>
                ) : null}
              </dl>
              {a.description ? <MarkdownView source={a.description} breaks people={task.people} className="text-sm" /> : null}
              <FileList files={task.files} missing={task.missing} />
            </CardContent>
          </Card>

          <TaskDocuments assignmentId={a._id} />

          {isEvent ? <PrepTasks task={task} /> : null}
          {task.mySubmission ? <MyPart task={task} /> : null}
          {access.review ? <AssigneesCard task={task} onOpen={openSubmission} /> : null}
        </div>
      </div>
      {access.review && submissionId ? (
        <SubmissionSheet task={task} submissionId={submissionId} onClose={() => openSubmission(null)} />
      ) : null}
    </>
  );
}

function ManageMenu({ task }: { task: Task }) {
  const t = useTranslations("tasks");
  const router = useRouter();
  const publish = useMutation(api.assignments.publish);
  const close = useMutation(api.assignments.close);
  const reopen = useMutation(api.assignments.reopen);
  const remove = useMutation(api.assignments.remove);
  const showError = useErrorToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const a = task.assignment;
  return (
    <>
      {a.status === "draft" ? (
        <Button
          size="sm"
          onClick={() =>
            publish({ assignmentId: a._id })
              .then(() => toast.success(t("published")))
              .catch(showError)
          }
        >
          <SendIcon />
          {t("publish")}
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label={t("more")}>
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={`/assignments/new/?a=${a._id}`}>
              <PencilIcon />
              {t("edit")}
            </Link>
          </DropdownMenuItem>
          {a.kind === "event" && task.channel && a.status !== "draft" ? (
            <DropdownMenuItem asChild>
              <Link href={`/assignments/new/?c=${task.channel._id}&event=${a._id}`}>
                <PlusIcon />
                {t("addPrepTask")}
              </Link>
            </DropdownMenuItem>
          ) : null}
          {a.status === "open" ? (
            <DropdownMenuItem onSelect={() => close({ assignmentId: a._id }).then(() => toast.success(t("closedToast"))).catch(showError)}>
              <LockIcon />
              {t("close")}
            </DropdownMenuItem>
          ) : null}
          {a.status === "closed" ? (
            <DropdownMenuItem onSelect={() => reopen({ assignmentId: a._id }).catch(showError)}>
              <RotateCcwIcon />
              {t("reopen")}
            </DropdownMenuItem>
          ) : null}
          {a.status === "draft" && task.access.isCreator ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                <Trash2Icon />
                {t("deleteDraft")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteDraftTitle")}</DialogTitle>
            <DialogDescription>{t("deleteDraftBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                remove({ assignmentId: a._id })
                  .then(() => router.push("/assignments/?tab=created"))
                  .catch(showError)
              }
            >
              {t("deleteDraft")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function FileList({ files, missing }: { files: TaskFile[]; missing: number }) {
  const t = useTranslations("tasks");
  const tDocs = useTranslations("docs");
  const [viewing, setViewing] = useState<FileSource | null>(null);
  if (files.length === 0 && missing === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <FileViewer file={viewing} onClose={() => setViewing(null)} />
      {files.map((f) => {
        const className =
          "flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm hover:bg-secondary";
        const body = (
          <>
            <FileTypeIcon contentType={f.contentType} name={f.name} document={Boolean(f.documentId)} className="size-4" />
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <span className="text-xs text-muted-foreground">{f.documentId ? tDocs("document") : formatBytes(f.size)}</span>
          </>
        );
        return f.documentId ? (
          <Link key={f._id} href={docHref(f.documentId)} className={className}>
            {body}
          </Link>
        ) : !f.drive && f.url ? (
          <button
            key={f._id}
            type="button"
            onClick={() => setViewing({ url: f.url!, name: f.name, contentType: f.contentType, size: f.size })}
            className={cn(className, "text-left")}
          >
            {body}
          </button>
        ) : (
          <a key={f._id} href={f.openUrl ?? undefined} target="_blank" rel="noopener noreferrer" className={className}>
            {body}
          </a>
        );
      })}
      {missing > 0 ? <p className="text-xs text-muted-foreground">{t("filesMissing", { count: missing })}</p> : null}
    </div>
  );
}

function PrepTasks({ task }: { task: Task }) {
  const t = useTranslations("tasks");
  const format = useFormatter();
  if (task.prepTasks.length === 0 && !task.access.canEdit) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t("prepTasks")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {task.prepTasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noPrepTasks")}</p>
        ) : (
          task.prepTasks.map((p) => (
            <Link key={p._id} href={`/assignments/view/?a=${p._id}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
              <ClipboardListIcon className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{p.title}</span>
              {p.status === "draft" ? <Badge variant="outline">{t("taskStatus.draft")}</Badge> : null}
              {p.dueAt ? (
                <span className="text-xs text-muted-foreground">{format.dateTime(p.dueAt, { month: "short", day: "numeric" })}</span>
              ) : null}
              <span className="text-xs text-muted-foreground">{t("progress", { done: p.done, total: p.total })}</span>
            </Link>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function MyPart({ task }: { task: Task }) {
  const t = useTranslations("tasks");
  const a = task.assignment;
  const mine = task.mySubmission!;
  const markDone = useMutation(api.assignments.markDone);
  const showError = useErrorToast();
  const [now] = useState(() => Date.now());
  const open = a.status === "open";

  if (a.kind === "event") {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 text-sm">
          <CheckIcon className="size-4 text-primary" />
          {a.ended ? t("helperPast") : t("helperNote")}
        </CardContent>
      </Card>
    );
  }

  const overdue = isOverdue(a, mine.status, now);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm">{t("myPart")}</CardTitle>
        <SubmissionBadge status={mine.status} late={mine.late} />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {overdue ? <p className="text-sm text-destructive">{t("overdueNote")}</p> : null}
        {!open ? <p className="text-sm text-muted-foreground">{t("closedNote")}</p> : null}
        {a.requiresSubmission ? (
          <>
            {mine.submittedAt ? (
              <SubmissionContent text={mine.text} link={mine.link} files={mine.files} submittedAt={mine.submittedAt} />
            ) : mine.status === "approved" ? (
              <p className="text-sm text-muted-foreground">{t("completedWithoutSubmission")}</p>
            ) : null}
            {open && mine.status !== "approved" ? <SubmitForm task={task} /> : null}
          </>
        ) : mine.status === "assigned" || mine.status === "changes_requested" ? (
          <Button
            className="self-start"
            disabled={!open}
            onClick={() =>
              markDone({ assignmentId: a._id })
                .then(() => toast.success(t("markedDone")))
                .catch(showError)
            }
          >
            <CheckIcon />
            {t("markDone")}
          </Button>
        ) : null}
        <Comments submissionId={mine._id} />
      </CardContent>
    </Card>
  );
}

function SubmissionContent({
  text,
  link,
  files,
  submittedAt,
}: {
  text?: string;
  link?: string;
  files: TaskFile[];
  submittedAt?: number;
}) {
  const t = useTranslations("tasks");
  const format = useFormatter();
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      {submittedAt ? (
        <p className="text-xs text-muted-foreground">{t("submittedAt", { time: format.dateTime(submittedAt, { dateStyle: "medium", timeStyle: "short" }) })}</p>
      ) : null}
      {text ? <p className="text-sm whitespace-pre-wrap">{text}</p> : null}
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-sm break-all text-primary hover:underline">
          <ExternalLinkIcon className="size-3.5 shrink-0" />
          {link}
        </a>
      ) : null}
      <FileList files={files} missing={0} />
      {!text && !link && files.length === 0 ? <p className="text-sm text-muted-foreground">{t("markedDoneOnly")}</p> : null}
    </div>
  );
}

function SubmitForm({ task }: { task: Task }) {
  const t = useTranslations("tasks");
  const locale = useLocale() as Locale;
  const mine = task.mySubmission!;
  const submit = useMutation(api.assignments.submit);
  const showError = useErrorToast();
  const { upload, items, dismiss, clearDone, busy: uploading } = useFileUpload();
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(mine.text ?? "");
  const [link, setLink] = useState(mine.link ?? "");
  const [files, setFiles] = useState<{ _id: Id<"files">; name: string; size: number; contentType: string }[]>(mine.files);
  const [busy, setBusy] = useState(false);
  const empty = !text.trim() && !link.trim() && files.length === 0;
  const resubmit = mine.status !== "assigned";

  return (
    <div className="flex flex-col gap-3">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={LIMITS.submissionText}
        rows={3}
        placeholder={t("submissionTextPlaceholder")}
      />
      <div className="relative">
        <LinkIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          maxLength={LIMITS.submissionLink}
          placeholder={t("submissionLinkPlaceholder")}
          className="pl-9"
        />
      </div>
      {files.map((f) => (
        <div key={f._id} className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5 text-sm">
          <FileTypeIcon contentType={f.contentType} name={f.name} className="size-4" />
          <span className="min-w-0 flex-1 truncate">{f.name}</span>
          <span className="text-xs text-muted-foreground">{formatBytes(f.size)}</span>
          <button
            type="button"
            aria-label={t("remove")}
            onClick={() => setFiles((list) => list.filter((x) => x._id !== f._id))}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ))}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={async (e) => {
          const picked = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length + picked.length > LIMITS.taskFiles) {
            toast.error(t("tooManyFiles", { max: LIMITS.taskFiles }));
            return;
          }
          for (const file of picked) {
            const [id] = await upload([file], { assignmentId: task.assignment._id });
            if (id) setFiles((list) => [...list, { _id: id, name: file.name, size: file.size, contentType: file.type }]);
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
          <PaperclipIcon />
          {t("addFiles")}
        </Button>
        <Button
          size="sm"
          className="ml-auto"
          disabled={busy || uploading || empty}
          onClick={async () => {
            setBusy(true);
            try {
              await submit({
                assignmentId: task.assignment._id,
                text: text.trim() || undefined,
                link: link.trim() || undefined,
                fileIds: files.map((f) => f._id),
              });
              toast.success(t("submitted"));
            } catch (error) {
              showError(error);
            } finally {
              setBusy(false);
            }
          }}
        >
          <SendIcon />
          {resubmit ? t("resubmit") : t("submit")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("submitHint", { space: localized(task.space.nameZh, task.space.nameEn, locale) })}
      </p>
      <UploadPanel items={items} onDismiss={dismiss} onClear={clearDone} className="fixed right-4 bottom-20 z-30 w-72 md:bottom-4" />
    </div>
  );
}

function Comments({ submissionId }: { submissionId: Id<"assignmentSubmissions"> }) {
  const t = useTranslations("tasks");
  const locale = useLocale() as Locale;
  const format = useFormatter();
  const comments = useQuery(api.assignments.listComments, { submissionId });
  const addComment = useMutation(api.assignments.addComment);
  const showError = useErrorToast();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <h3 className="text-xs font-medium text-muted-foreground">{t("comments")}</h3>
      {comments?.map((c) => (
        <div key={c._id} className="flex gap-2">
          {c.author ? <PersonAvatar person={c.author} className="size-6" /> : null}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 text-xs">
              <span className="font-medium">{c.author ? displayName(c.author, locale) : "?"}</span>
              <span className="text-subtle-foreground">{format.dateTime(c._creationTime, { dateStyle: "short", timeStyle: "short" })}</span>
            </div>
            <p className="text-sm whitespace-pre-wrap">{c.body}</p>
          </div>
        </div>
      ))}
      {comments && comments.length === 0 ? <p className="text-xs text-subtle-foreground">{t("noComments")}</p> : null}
      <div className="flex items-end gap-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={LIMITS.taskComment}
          rows={1}
          placeholder={t("commentPlaceholder")}
          className="min-h-9 resize-none"
        />
        <Button
          size="icon-lg"
          aria-label={t("sendComment")}
          disabled={busy || !body.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await addComment({ submissionId, body: body.trim() });
              setBody("");
            } catch (error) {
              showError(error);
            } finally {
              setBusy(false);
            }
          }}
        >
          <SendIcon />
        </Button>
      </div>
    </div>
  );
}

const STATUS_ORDER: Record<SubmissionStatus, number> = { submitted: 0, changes_requested: 1, assigned: 2, approved: 3 };

function AssigneesCard({ task, onOpen }: { task: Task; onOpen: (id: Id<"assignmentSubmissions">) => void }) {
  const t = useTranslations("tasks");
  const locale = useLocale() as Locale;
  const format = useFormatter();
  const removeAssignee = useMutation(api.assignments.removeAssignee);
  const review = useMutation(api.assignments.review);
  const showError = useErrorToast();
  const [adding, setAdding] = useState(false);
  const a = task.assignment;
  const markComplete = (submissionId: Id<"assignmentSubmissions">) =>
    review({ submissionId, decision: "complete" })
      .then(() => toast.success(t("markedCompleteToast")))
      .catch(showError);
  const person = (id: string) => task.people.find((p) => p._id === id);

  if (a.status === "draft") {
    const draftPeople = a.draftAssigneeIds.flatMap((id) => person(id) ?? []);
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{a.kind === "event" ? t("helpers") : t("assignees")}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {a.draftEveryone ? (
            t("draftEveryone")
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {draftPeople.map((p) => (
                <span key={p._id} className="flex items-center gap-1.5 rounded-full bg-secondary py-0.5 pr-2 pl-0.5 text-xs text-foreground">
                  <PersonAvatar person={p} className="size-5" />
                  {displayName(p, locale)}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  const rows = [...task.assignees].sort((x, y) => STATUS_ORDER[x.status] - STATUS_ORDER[y.status]);
  const done = rows.filter((r) => r.status === "submitted" || r.status === "approved").length;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm">
          {a.kind === "event" ? t("helpers") : t("assignees")}{" "}
          <span className="font-normal text-muted-foreground">
            {a.kind === "event" ? rows.length : t("progress", { done, total: rows.length })}
          </span>
        </CardTitle>
        {a.status === "open" ? (
          <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
            <PlusIcon />
            {t("addPeople")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-border">
        {rows.map((row) => {
          const p = person(row.userId);
          const clickable = a.kind === "task";
          const content = (
            <>
              {p ? <PersonAvatar person={p} className="size-7" /> : null}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{p ? displayName(p, locale) : "?"}</span>
                {row.submittedAt ? (
                  <span className="block text-xs text-muted-foreground">
                    {format.dateTime(row.submittedAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </span>
                ) : null}
              </span>
              {a.kind === "task" ? <SubmissionBadge status={row.status} late={row.late} /> : null}
            </>
          );
          return (
            <div key={row.submissionId} className="flex items-center gap-2 py-1.5">
              {clickable ? (
                <button type="button" onClick={() => onOpen(row.submissionId)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-accent">
                  {content}
                </button>
              ) : (
                <div className="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5">{content}</div>
              )}
              {a.kind === "task" && (row.status === "assigned" || row.status === "changes_requested") ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("markComplete")}
                      onClick={() => void markComplete(row.submissionId)}
                    >
                      <CheckCheckIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("markComplete")}</TooltipContent>
                </Tooltip>
              ) : null}
              {row.status === "assigned" && a.status === "open" ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("removeAssignee")}
                  onClick={() => removeAssignee({ assignmentId: a._id, userId: row.userId }).catch(showError)}
                >
                  <UserMinusIcon />
                </Button>
              ) : null}
            </div>
          );
        })}
        {rows.length === 0 ? <p className="py-3 text-sm text-muted-foreground">{t("noAssignees")}</p> : null}
      </CardContent>
      {adding && task.channel ? <AddPeopleDialog task={task} onClose={() => setAdding(false)} /> : null}
    </Card>
  );
}

function AddPeopleDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const t = useTranslations("tasks");
  const audience = useQuery(api.assignments.audience, { channelId: task.channel!._id });
  const addAssignees = useMutation(api.assignments.addAssignees);
  const showError = useErrorToast();
  const existing = new Set(task.assignees.map((r) => r.userId as string));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("addPeople")}</DialogTitle>
        </DialogHeader>
        <PersonPicker
          people={audience?.people.filter((p) => !existing.has(p._id))}
          onPick={(p) =>
            addAssignees({ assignmentId: task.assignment._id, userIds: [p._id as Id<"users">] })
              .then(() => toast.success(t("added")))
              .catch(showError)
          }
        />
      </DialogContent>
    </Dialog>
  );
}

function SubmissionSheet({
  task,
  submissionId,
  onClose,
}: {
  task: Task;
  submissionId: Id<"assignmentSubmissions">;
  onClose: () => void;
}) {
  const t = useTranslations("tasks");
  const locale = useLocale() as Locale;
  const submission = useQuery(api.assignments.getSubmission, { submissionId });
  const review = useMutation(api.assignments.review);
  const showError = useErrorToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const decide = async (decision: "approve" | "request_changes" | "complete") => {
    setBusy(true);
    try {
      await review({ submissionId, decision, comment: note.trim() || undefined });
      setNote("");
      toast.success(
        t(decision === "approve" ? "approvedToast" : decision === "complete" ? "markedCompleteToast" : "changesToast"),
      );
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{submission?.assignee ? displayName(submission.assignee, locale) : t("submission")}</SheetTitle>
          <SheetDescription>{task.assignment.title}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {submission === undefined ? (
            <Skeleton className="h-32" />
          ) : submission === null ? (
            <p className="text-sm text-muted-foreground">{t("notFound")}</p>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <SubmissionBadge status={submission.status} late={submission.late} />
                {submission.reviewer && submission.reviewedAt ? (
                  <span className="text-xs text-muted-foreground">{t("reviewedBy", { name: displayName(submission.reviewer, locale) })}</span>
                ) : null}
              </div>
              {submission.submittedAt ? (
                <SubmissionContent text={submission.text} link={submission.link} files={submission.files} submittedAt={submission.submittedAt} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {submission.status === "approved" ? t("completedWithoutSubmission") : t("notSubmittedYet")}
                </p>
              )}
              {submission.status === "submitted" || submission.status === "approved" ? (
                <ReviewBox
                  note={note}
                  setNote={setNote}
                  busy={busy}
                  canApprove={submission.status === "submitted"}
                  onApprove={() => void decide("approve")}
                  onRequestChanges={() => void decide("request_changes")}
                />
              ) : (
                <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                  <Textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={LIMITS.taskComment}
                    rows={2}
                    placeholder={t("reviewNotePlaceholder")}
                  />
                  <Button size="sm" className="self-end" disabled={busy} onClick={() => void decide("complete")}>
                    <CheckCheckIcon />
                    {t("markComplete")}
                  </Button>
                  <p className="text-xs text-muted-foreground">{t("markCompleteHint")}</p>
                </div>
              )}
              <Comments submissionId={submissionId} />
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ReviewBox({
  note,
  setNote,
  busy,
  canApprove,
  onApprove,
  onRequestChanges,
}: {
  note: string;
  setNote: (v: string) => void;
  busy: boolean;
  canApprove: boolean;
  onApprove: () => void;
  onRequestChanges: () => void;
}) {
  const t = useTranslations("tasks");
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={LIMITS.taskComment} rows={2} placeholder={t("reviewNotePlaceholder")} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="outline" disabled={busy || !note.trim()} onClick={onRequestChanges}>
          {t("requestChanges")}
        </Button>
        {canApprove ? (
          <Button size="sm" disabled={busy} onClick={onApprove}>
            <CheckIcon />
            {t("approve")}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t("reviewHint")}</p>
    </div>
  );
}