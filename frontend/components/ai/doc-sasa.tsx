"use client";

import type { Editor } from "@tiptap/core";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  CalendarDaysIcon,
  CheckIcon,
  ClipboardListIcon,
  MegaphoneIcon,
  PencilLineIcon,
  RefreshCwIcon,
  ShieldQuestionIcon,
  SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { MarkdownView } from "@/components/docs/markdown-view";
import { useTaskChatName, useTaskWhen } from "@/components/tasks/task-format";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AI_DOC_COST, api, LIMITS, type Id } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import type { Locale } from "@/lib/locale-store";
import { displayName } from "@/lib/names";
import { cn } from "@/lib/utils";
import { useAiCredits } from "./ai-chat";
import { AppealDialog, Dots } from "./ai-message";
import { SasaAvatar } from "./sasa-avatar";

type Summary = NonNullable<FunctionReturnType<typeof api.aiDocs.summary>>;

/** "剩余 3 点" for the cost lines; unlimited accounts see nothing. */
function useBalanceNote() {
  const t = useTranslations("ai");
  const credits = useAiCredits();
  if (!credits || credits.unlimited) return "";
  return t("docBalance", { balance: credits.balance });
}

// ---------------------------------------------------------------------------------------------
// Writing

const PRESETS = ["notes", "brainstorm", "polish", "outline"] as const;

/** Editors describe what 小飒 should write; the result streams into their private draft. */
export function SasaWriteDialog({
  documentId,
  open,
  onClose,
}: {
  documentId: Id<"documents">;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("ai");
  const write = useMutation(api.aiDocs.write);
  const showError = useErrorToast();
  const balance = useBalanceNote();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await write({ documentId, prompt: prompt.trim() });
      setPrompt("");
      onClose();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SasaAvatar state="idle" className="size-6" />
            {t("writeTitle")}
          </DialogTitle>
          <DialogDescription>{t("writeBody")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <Button key={preset} size="xs" variant="outline" onClick={() => setPrompt(t(`writePreset.${preset}`))}>
              {t(`writePresetLabel.${preset}`)}
            </Button>
          ))}
        </div>
        <Textarea
          autoFocus
          value={prompt}
          maxLength={LIMITS.aiDocPrompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("writePlaceholder")}
          rows={4}
        />
        <p className="text-xs text-muted-foreground">
          {t("writeCost", { cost: AI_DOC_COST.write })} {balance}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button disabled={busy || !prompt.trim()} onClick={() => void submit()}>
            <SparklesIcon />
            {t("writeSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The viewer's latest 小飒 draft for this document. Applying goes through their editor, so it syncs
 * like any other edit and can be undone.
 */
export function SasaDraftPanel({ documentId, editor }: { documentId: Id<"documents">; editor: Editor | null }) {
  const t = useTranslations("ai");
  const draft = useQuery(api.aiDocs.myDraft, { documentId });
  const close = useMutation(api.aiDocs.closeDraft);
  const showError = useErrorToast();
  const [appealing, setAppealing] = useState(false);
  if (!draft) return null;
  const busy = draft.status === "thinking" || draft.status === "streaming";
  const dismiss = () => close({ draftId: draft._id }).catch(showError);
  const apply = (mode: "replace" | "insert" | "append") => {
    if (!editor || !editor.isEditable) return;
    if (mode === "replace") editor.chain().focus().setContent(draft.text, { contentType: "markdown" }).run();
    else if (mode === "insert") editor.chain().focus().insertContent(draft.text, { contentType: "markdown" }).run();
    else editor.chain().focus("end").insertContent(draft.text, { contentType: "markdown" }).run();
    toast.success(t("draftApplied"));
    void dismiss();
  };

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm print:hidden">
      <div className="flex items-start gap-2">
        <SasaAvatar state={busy ? "think" : "idle"} className="size-8 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t("draftTitle")}</p>
          <p className="line-clamp-2 text-xs text-muted-foreground">{draft.prompt}</p>
        </div>
      </div>

      {draft.status === "thinking" ? (
        <p className="mt-2 flex items-center gap-1 text-muted-foreground italic">
          {t("thinking")}
          <Dots />
        </p>
      ) : draft.status === "streaming" || draft.status === "done" ? (
        <div className="mt-2 max-h-80 overflow-y-auto rounded-md border border-border bg-background p-3">
          <MarkdownView source={draft.text} className="doc-content text-sm" />
          {draft.status === "streaming" ? (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-primary/60 align-middle motion-reduce:animate-none" />
          ) : null}
        </div>
      ) : draft.status === "refused" ? (
        <div className="mt-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
          <p className="font-medium">{draft.appealDenied ? t("appealDeniedNotice") : t("refusedTitle")}</p>
          {draft.reason ? (
            <p className="mt-0.5 text-muted-foreground">
              {draft.appealDenied ? t("adminNote", { note: draft.reason }) : draft.reason}
            </p>
          ) : null}
          {!draft.appealDenied ? (
            <p className="mt-1 text-xs text-muted-foreground">{t("refusedCost", { cost: AI_DOC_COST.write })}</p>
          ) : null}
          {draft.appeal !== "none" && !draft.appealDenied ? (
            <p className="mt-1.5 text-xs font-medium text-primary">{t(`appealStatus.${draft.appeal}`)}</p>
          ) : draft.canAppeal ? (
            <>
              <Button size="xs" variant="outline" className="mt-2" onClick={() => setAppealing(true)}>
                <ShieldQuestionIcon />
                {t("appeal")}
              </Button>
              <AppealDialog requestId={draft.requestId} open={appealing} onOpenChange={setAppealing} />
            </>
          ) : null}
        </div>
      ) : (
        <p className="mt-2 text-destructive">{t("failed")}</p>
      )}

      {busy ? null : (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {draft.status === "done" ? (
            <>
              <Button size="xs" disabled={!editor?.isEditable} onClick={() => apply("append")}>
                {t("draftAppend")}
              </Button>
              <Button size="xs" variant="outline" disabled={!editor?.isEditable} onClick={() => apply("insert")}>
                {t("draftInsert")}
              </Button>
              <Button size="xs" variant="outline" disabled={!editor?.isEditable} onClick={() => apply("replace")}>
                {t("draftReplace")}
              </Button>
            </>
          ) : null}
          <Button size="xs" variant="ghost" onClick={() => void dismiss()}>
            {draft.status === "done" ? t("draftDiscard") : t("close")}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Summary

/** 小飒's shared summary under a document: what it says, plus tasks, announcements and task changes it found. */
export function DocSummaryPanel({ documentId }: { documentId: Id<"documents"> }) {
  const t = useTranslations("ai");
  const locale = useLocale() as Locale;
  const format = useFormatter();
  const summary = useQuery(api.aiDocs.summary, { documentId });
  const summarize = useMutation(api.aiDocs.summarize);
  const credits = useAiCredits();
  const balance = useBalanceNote();
  const showError = useErrorToast();
  if (!summary || (!summary.configured && !summary.generatedAt)) return null;

  const has = summary.generatedAt !== undefined;
  const blocked = credits?.inFlight === true || (!!credits && !credits.unlimited && credits.balance < AI_DOC_COST.summary);
  return (
    <section className="mt-6 flex flex-col gap-4 rounded-xl border border-primary/25 bg-primary/5 p-4 print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        <SasaAvatar state={summary.generating ? "think" : "idle"} className="size-8" />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{t("summaryTitle")}</h3>
          {has ? (
            <p className="text-xs text-muted-foreground">
              {t("summaryBy", {
                name: summary.requestedBy ? displayName(summary.requestedBy, locale) : "?",
                time: format.relativeTime(summary.generatedAt!),
              })}
            </p>
          ) : null}
        </div>
        {summary.configured ? (
          <Button
            size="sm"
            variant={has ? "outline" : "default"}
            disabled={summary.generating || blocked}
            onClick={() => summarize({ documentId }).catch(showError)}
          >
            {has ? <RefreshCwIcon /> : <SparklesIcon />}
            {has ? t("summaryRegenerate") : t("summaryGenerate")}
          </Button>
        ) : null}
      </div>
      {summary.configured && !summary.generating ? (
        <p className="-mt-2 text-xs text-muted-foreground">
          {t("summaryCost", { cost: AI_DOC_COST.summary })} {balance}
        </p>
      ) : null}

      {summary.generating ? (
        <p className="flex items-center gap-1 text-sm text-muted-foreground italic">
          {summary.generatingByMe ? t("summaryWorking") : t("summaryWorkingOther")}
          <Dots />
        </p>
      ) : summary.lastFailed ? (
        <p className="text-xs text-destructive">{t("summaryFailed")}</p>
      ) : null}
      {summary.outdated ? (
        <Badge variant="outline" className="w-fit border-warning/40 bg-warning/10 text-warning">
          {t("summaryOutdated")}
        </Badge>
      ) : null}

      {has ? (
        <>
          <MarkdownView source={summary.summary} className="doc-content text-sm" />
          {summary.tasks.length > 0 ? <FoundTasks documentId={documentId} summary={summary} /> : null}
          {summary.announcements.length > 0 ? <FoundAnnouncements documentId={documentId} summary={summary} /> : null}
          {summary.edits.length > 0 ? <FoundEdits documentId={documentId} summary={summary} /> : null}
          <p className="text-[11px] text-subtle-foreground">{t("summaryShared")}</p>
        </>
      ) : !summary.generating ? (
        <p className="text-sm text-muted-foreground">{t("summaryEmpty")}</p>
      ) : null}
    </section>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{children}</h4>;
}

function FoundTasks({ documentId, summary }: { documentId: Id<"documents">; summary: Summary }) {
  const t = useTranslations("ai");
  const locale = useLocale() as Locale;
  const when = useTaskWhen();
  const chatName = useTaskChatName();
  const create = useMutation(api.aiDocs.createTaskDrafts);
  const showError = useErrorToast();
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const targets = summary.taskTargets;
  const channelId = (summary.taskTargetFixed ? targets[0]?._id : target || undefined) as Id<"channels"> | undefined;
  const canCreate = targets.length > 0;
  const pending = summary.tasks.filter((task) => !task.created);

  const run = async (indexes: number[]) => {
    if (!channelId) return;
    setBusy(true);
    try {
      const created = await create({ documentId, indexes, channelId: summary.taskTargetFixed ? undefined : channelId });
      toast.success(t("draftsCreated", { count: created.length }));
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>{t("foundTasks", { count: summary.tasks.length })}</SectionTitle>
      {canCreate && pending.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {!summary.taskTargetFixed ? (
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger size="sm" className="w-48">
                <SelectValue placeholder={t("pickChat")} />
              </SelectTrigger>
              <SelectContent>
                {targets.map((chat) => (
                  <SelectItem key={chat._id} value={chat._id}>
                    {chatName(chat)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button size="xs" disabled={busy || !channelId} onClick={() => void run(pending.map((task) => task.index))}>
            {t("createAllDrafts", { count: pending.length })}
          </Button>
          <span className="text-[11px] text-muted-foreground">{t("draftsHint")}</span>
        </div>
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {summary.tasks.map((task) => {
          const Icon = task.kind === "event" ? CalendarDaysIcon : ClipboardListIcon;
          const details = [
            when(task),
            task.assignees.map((p) => displayName(p, locale)).join(locale === "zh" ? "、" : ", "),
          ].filter(Boolean);
          return (
            <li key={task.index} className="flex items-start gap-2 rounded-md border border-border bg-background p-2 text-sm">
              <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{task.title}</p>
                {details.length > 0 ? <p className="text-xs text-muted-foreground">{details.join(" · ")}</p> : null}
                {task.description ? <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{task.description}</p> : null}
              </div>
              {task.created ? (
                task.assignmentId ? (
                  <Button asChild size="xs" variant="ghost" className="text-success">
                    <Link href={`/assignments/view/?a=${task.assignmentId}`}>
                      <CheckIcon />
                      {t("draftCreated")}
                    </Link>
                  </Button>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-success">
                    <CheckIcon className="size-3.5" />
                    {t("draftCreated")}
                  </span>
                )
              ) : canCreate ? (
                <Button size="xs" variant="outline" disabled={busy || !channelId} onClick={() => void run([task.index])}>
                  {t("createDraft")}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {!canCreate && pending.length > 0 ? <p className="text-[11px] text-muted-foreground">{t("tasksWho")}</p> : null}
    </div>
  );
}

function FoundAnnouncements({ documentId, summary }: { documentId: Id<"documents">; summary: Summary }) {
  const t = useTranslations("ai");
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>{t("foundAnnouncements", { count: summary.announcements.length })}</SectionTitle>
      {summary.announcements.map((item) => (
        <AnnouncementItem key={`${item.index}-${item.body}`} documentId={documentId} summary={summary} item={item} />
      ))}
      {summary.announceTargets.length === 0 ? <p className="text-[11px] text-muted-foreground">{t("announceWho")}</p> : null}
    </div>
  );
}

function AnnouncementItem({
  documentId,
  summary,
  item,
}: {
  documentId: Id<"documents">;
  summary: Summary;
  item: Summary["announcements"][number];
}) {
  const t = useTranslations("ai");
  const locale = useLocale() as Locale;
  const format = useFormatter();
  const chatName = useTaskChatName();
  const send = useMutation(api.aiDocs.sendAnnouncement);
  const showError = useErrorToast();
  const [body, setBody] = useState(item.body);
  const [target, setTarget] = useState<string>(summary.announceTargets[0]?._id ?? "");
  const [busy, setBusy] = useState(false);
  const chosen = summary.announceTargets.find((c) => c._id === target);
  const canSend = summary.announceTargets.length > 0;

  const submit = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      await send({ documentId, index: item.index, channelId: chosen._id, body: body.trim() });
      toast.success(t("announcementSent", { chat: chatName(chosen) }));
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-background p-2.5 text-sm">
      <div className="flex items-start gap-2">
        <MegaphoneIcon className="mt-0.5 size-4 shrink-0 text-warning" />
        {canSend ? (
          <Textarea
            value={body}
            maxLength={LIMITS.messageBody}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            className="min-h-16 text-sm"
          />
        ) : (
          <p className="whitespace-pre-wrap">{item.body}</p>
        )}
      </div>
      {canSend ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger size="sm" className="w-48">
              <SelectValue placeholder={t("pickChat")} />
            </SelectTrigger>
            <SelectContent>
              {summary.announceTargets.map((chat) => (
                <SelectItem key={chat._id} value={chat._id}>
                  {chatName(chat)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="xs" disabled={busy || !chosen || !body.trim()} onClick={() => void submit()}>
            {t("announcementSend")}
          </Button>
          {chosen?.viaSasa ? <span className="text-[11px] text-muted-foreground">{t("announceViaSasa")}</span> : null}
        </div>
      ) : null}
      {item.sent.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs text-success">
          {item.sent.map((s, i) => (
            <li key={i} className="flex items-center gap-1">
              <CheckIcon className="size-3.5" />
              {t("announcementSentTo", {
                chat: s.chat ? chatName(s.chat) : "?",
                name: s.by ? displayName(s.by, locale) : "?",
                time: format.relativeTime(s.at),
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function FoundEdits({ documentId, summary }: { documentId: Id<"documents">; summary: Summary }) {
  const t = useTranslations("ai");
  const locale = useLocale() as Locale;
  const format = useFormatter();
  const router = useRouter();
  const open = useMutation(api.aiDocs.editSuggestion);
  const showError = useErrorToast();
  const when = (ms: number | undefined) =>
    ms === undefined ? null : format.dateTime(ms, { month: "short", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit" });
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>{t("foundEdits", { count: summary.edits.length })}</SectionTitle>
      {summary.edits.map((edit) => {
        const rows: [string, string | null][] = [
          [t("field.title"), edit.fields.title ?? null],
          [t("field.assignees"), edit.assignees.map((p) => displayName(p, locale)).join(locale === "zh" ? "、" : ", ") || null],
          [t("field.due"), when(edit.fields.dueAt)],
          [t("field.start"), when(edit.fields.startAt)],
          [t("field.end"), when(edit.fields.endAt)],
          [t("field.location"), edit.fields.location ?? null],
          [t("field.description"), edit.fields.description ?? null],
        ];
        return (
          <div key={edit.index} className="rounded-md border border-border bg-background p-2.5 text-sm">
            <div className="flex items-center gap-2 font-medium">
              <PencilLineIcon className="size-4 shrink-0 text-primary" />
              <Link href={`/assignments/view/?a=${edit.assignment._id}`} className="min-w-0 truncate hover:text-primary">
                {t("suggestEdit", { title: edit.assignment.title })}
              </Link>
            </div>
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              {rows
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="line-clamp-2 min-w-0 break-words">{value}</dd>
                  </div>
                ))}
            </dl>
            <div className={cn("mt-2", edit.applied && "text-xs text-success")}>
              {edit.applied ? (
                t("suggestionApplied")
              ) : edit.canApply ? (
                <Button
                  size="xs"
                  onClick={() =>
                    open({ documentId, index: edit.index })
                      .then(({ suggestionId, assignmentId }) =>
                        router.push(`/assignments/new/?a=${assignmentId}&s=${suggestionId}`),
                      )
                      .catch(showError)
                  }
                >
                  {t("actionEdit")}
                </Button>
              ) : (
                <span className="text-[11px] text-muted-foreground">{t("editsWho")}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
