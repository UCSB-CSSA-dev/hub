"use client";

import { useMutation } from "convex/react";
import {
  CalendarDaysIcon,
  ClipboardListIcon,
  FileTextIcon,
  PencilLineIcon,
  ShieldQuestionIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { useViewer } from "@/components/auth/account-state";
import { useChat } from "@/components/chat/chat-context";
import { Markdown } from "@/components/chat/markdown";
import { personById, type Message } from "@/components/chat/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api, LIMITS } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import type { Locale } from "@/lib/locale-store";
import { displayName } from "@/lib/names";

type Ai = NonNullable<Message["ai"]>;
type Suggestion = NonNullable<Ai["suggestion"]>;

/** Whether 小飒 is still working on this message (think.gif). */
export function aiBusy(message: Message) {
  return message.ai?.status === "thinking" || message.ai?.status === "streaming";
}

/** Plain finished answers behave like normal messages; everything else is a card. */
export function aiIsCard(message: Message) {
  const ai = message.ai;
  return ai !== undefined && (ai.status !== "done" || ai.notice !== undefined || ai.suggestion !== undefined);
}

export function AiMessageContent({ message }: { message: Message }) {
  const t = useTranslations("ai");
  const ai = message.ai;
  if (!ai) return null;

  if (ai.notice === "welcome") {
    return (
      <div className="text-sm">
        <p>{t("welcome")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("welcomeHint")}</p>
      </div>
    );
  }
  if (ai.notice === "appeal_denied") {
    return (
      <div className="mt-0.5 rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm">
        <p className="font-medium">{t("appealDeniedNotice")}</p>
        {message.body ? <p className="mt-1 text-muted-foreground">{t("adminNote", { note: message.body })}</p> : null}
      </div>
    );
  }
  if (ai.suggestion !== undefined) return <SuggestionCard message={message} suggestion={ai.suggestion} />;

  switch (ai.status) {
    case "thinking":
      return (
        <p className="flex items-center gap-1 text-sm text-muted-foreground italic">
          {t("thinking")}
          <Dots />
        </p>
      );
    case "streaming":
      return (
        <div className="relative">
          <Markdown body={message.body} people={message.people} />
          <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-primary/60 align-middle motion-reduce:animate-none" />
        </div>
      );
    case "done":
      return (
        <>
          {message.body ? <Markdown body={message.body} people={message.people} /> : null}
          {ai.actorId ? <OnBehalfOf message={message} actorId={ai.actorId} /> : null}
        </>
      );
    case "refused":
      return <Refusal message={message} ai={ai} />;
    case "failed":
      return <p className="text-sm text-destructive">{t("failed")}</p>;
  }
}

function OnBehalfOf({ message, actorId }: { message: Message; actorId: string }) {
  const t = useTranslations("ai");
  const locale = useLocale() as Locale;
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {t("onBehalfOf", { name: displayName(personById(message.people, actorId), locale) })}
    </p>
  );
}

/** Documents attached to a question for 小飒, as links. */
export function AiDocumentChips({ message }: { message: Message }) {
  const t = useTranslations("ai");
  if (!message.aiDocuments?.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {message.aiDocuments.map((doc) => (
        <Link
          key={doc._id}
          href={`/docs/?d=${doc._id}`}
          title={t("attachedDoc")}
          className="inline-flex max-w-56 items-center gap-1 rounded-md border border-border bg-background/60 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-primary"
        >
          <FileTextIcon className="size-3 shrink-0" />
          <span className="truncate">{doc.title}</span>
        </Link>
      ))}
    </div>
  );
}

export function Dots() {
  return (
    <span className="inline-flex gap-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1 animate-bounce rounded-full bg-current motion-reduce:animate-none"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

function Refusal({ message, ai }: { message: Message; ai: Ai }) {
  const t = useTranslations("ai");
  const viewer = useViewer();
  const [appealing, setAppealing] = useState(false);
  const mine = ai.askerId === viewer._id;
  const appeal = ai.appeal;
  return (
    <div className="mt-0.5 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
      <p className="font-medium">{t("refusedTitle")}</p>
      {message.body ? <p className="mt-0.5 text-muted-foreground">{message.body}</p> : null}
      {mine ? <p className="mt-1 text-xs text-muted-foreground">{t("refusedCost", { cost: 2 })}</p> : null}
      {appeal && appeal.status !== "none" ? (
        <p className="mt-1.5 text-xs font-medium text-primary">{t(`appealStatus.${appeal.status}`)}</p>
      ) : appeal?.canAppeal ? (
        <>
          <Button size="xs" variant="outline" className="mt-2" onClick={() => setAppealing(true)}>
            <ShieldQuestionIcon />
            {t("appeal")}
          </Button>
          {ai.requestId ? (
            <AppealDialog requestId={ai.requestId} open={appealing} onOpenChange={setAppealing} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function AppealDialog({
  requestId,
  open,
  onOpenChange,
}: {
  requestId: NonNullable<Ai["requestId"]>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("ai");
  const appeal = useMutation(api.ai.appeal);
  const showError = useErrorToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await appeal({ requestId, note: note.trim() || undefined });
      toast.success(t("appealSent"));
      onOpenChange(false);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("appealTitle")}</DialogTitle>
          <DialogDescription>{t("appealBody")}</DialogDescription>
        </DialogHeader>
        <Textarea
          value={note}
          maxLength={LIMITS.aiAppealNote}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("appealPlaceholder")}
          rows={3}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {t("appealSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SuggestionCard({ message, suggestion }: { message: Message; suggestion: Suggestion | null }) {
  const t = useTranslations("ai");
  const locale = useLocale() as Locale;
  const format = useFormatter();
  const { channel } = useChat();
  const dismiss = useMutation(api.ai.dismissSuggestion);
  const showError = useErrorToast();

  if (!suggestion) return <p className="text-sm text-muted-foreground italic">{t("suggestionGone")}</p>;
  const { fields, action } = suggestion;
  const Icon = action === "create_event" ? CalendarDaysIcon : action === "edit" ? PencilLineIcon : ClipboardListIcon;
  const when = (ms: number | undefined) =>
    ms === undefined ? null : format.dateTime(ms, { month: "short", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit" });
  const assignees = (fields.assigneeIds ?? [])
    .map((id) => displayName(personById(message.people, id), locale))
    .filter(Boolean)
    .join(locale === "zh" ? "、" : ", ");
  const rows: [string, string | null][] = [
    [t("field.title"), fields.title ?? null],
    [action === "create_event" ? t("field.helpers") : t("field.assignees"), assignees || null],
    [t("field.due"), when(fields.dueAt)],
    [t("field.start"), when(fields.startAt)],
    [t("field.end"), when(fields.endAt)],
    [t("field.location"), fields.location ?? null],
    [t("field.description"), fields.description ?? null],
  ];
  const href =
    action === "edit" && suggestion.assignmentId
      ? `/assignments/new/?a=${suggestion.assignmentId}&s=${suggestion._id}`
      : `/assignments/new/?c=${channel._id}&s=${suggestion._id}${action === "create_event" ? "&kind=event" : ""}`;

  return (
    <div className="mt-0.5 max-w-md rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-primary">
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 truncate">
          {action === "edit"
            ? t("suggestEdit", { title: suggestion.assignmentTitle ?? "" })
            : action === "create_event"
              ? t("suggestEvent")
              : t("suggestTask")}
        </span>
      </div>
      {message.body ? <Markdown body={message.body} people={message.people} className="mt-1" /> : null}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="line-clamp-2 min-w-0 break-words">{value}</dd>
            </div>
          ))}
      </dl>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {suggestion.status === "applied" ? (
          <span className="text-xs font-medium text-success">{t("suggestionApplied")}</span>
        ) : suggestion.status === "dismissed" ? (
          <span className="text-xs text-muted-foreground">{t("suggestionDismissed")}</span>
        ) : suggestion.canAct ? (
          <>
            <Button asChild size="xs">
              <Link href={href}>
                {action === "edit" ? t("actionEdit") : action === "create_event" ? t("actionEvent") : t("actionTask")}
              </Link>
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => dismiss({ suggestionId: suggestion._id }).catch(showError)}
            >
              <XIcon />
              {t("dismiss")}
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">{t("suggestionWho")}</span>
        )}
      </div>
    </div>
  );
}
