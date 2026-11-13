"use client";

import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  ArrowLeftIcon,
  BrainIcon,
  CheckIcon,
  FileTextIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { SasaAvatar } from "@/components/ai/sasa-avatar";
import { useViewer } from "@/components/auth/account-state";
import { PageHeader } from "@/components/layout/app-shell";
import { PersonAvatar } from "@/components/people/person-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, LIMITS } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import type { Locale } from "@/lib/locale-store";
import { displayName } from "@/lib/names";

type Status = "pending" | "approved" | "denied";
type Appeal = FunctionReturnType<typeof api.ai.listAppeals>[number];

export default function SasaAdminPage() {
  const t = useTranslations("aiAdmin");
  const viewer = useViewer();

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Button asChild size="icon-sm" variant="ghost" aria-label={t("back")} className="hidden md:inline-flex">
              <Link href="/admin/">
                <ArrowLeftIcon />
              </Link>
            </Button>
            <SasaAvatar className="size-7" />
            {t("title")}
          </span>
        }
      />
      {!viewer.isSystemAdmin ? (
        <p className="m-auto text-sm text-muted-foreground">{t("forbidden")}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-4xl flex-col gap-8 p-4">
            <Appeals />
            <Memory />
            <Overview />
          </div>
        </div>
      )}
    </>
  );
}

function Appeals() {
  const t = useTranslations("aiAdmin");
  const [status, setStatus] = useState<Status>("pending");
  const appeals = useQuery(api.ai.listAppeals, { status });
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{t("appeals")}</h2>
          <p className="text-xs text-muted-foreground">{t("appealsHint")}</p>
        </div>
        <Segmented
          label={t("appeals")}
          value={status}
          onChange={setStatus}
          options={(["pending", "approved", "denied"] as const).map((value) => ({ value, label: t(`status.${value}`) }))}
        />
      </div>
      <div className="flex flex-col divide-y divide-border rounded-md border border-border">
        {appeals === undefined ? (
          [0, 1].map((i) => <Skeleton key={i} className="m-2 h-16" />)
        ) : appeals.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t(`empty.${status}`)}</p>
        ) : (
          appeals.map((appeal) => <AppealRow key={appeal._id} appeal={appeal} />)
        )}
      </div>
    </section>
  );
}

function AppealRow({ appeal }: { appeal: Appeal }) {
  const t = useTranslations("aiAdmin");
  const locale = useLocale() as Locale;
  const format = useFormatter();
  const review = useMutation(api.ai.reviewAppeal);
  const showError = useErrorToast();
  const [note, setNote] = useState("");
  const [remember, setRemember] = useState(true);
  const [rule, setRule] = useState(() => appeal.question.replace(/\s+/g, " ").trim().slice(0, LIMITS.aiMemoryRule));
  const [busy, setBusy] = useState(false);
  const when = (ms: number) => format.dateTime(ms, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      await review({
        appealId: appeal._id,
        approve,
        note: note.trim() || undefined,
        remember: remember ? rule.trim() : undefined,
      });
      toast.success(approve ? t("approved") : t("denied"));
    } catch (error) {
      showError(error);
      setBusy(false);
    }
  };

  return (
    <div className="flex gap-3 p-3 text-sm">
      <PersonAvatar person={appeal.user ?? undefined} className="mt-0.5 size-8" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          <span className="text-sm font-medium text-foreground">{displayName(appeal.user ?? undefined, locale)}</span>
          {appeal.chat ? (
            appeal.chat.private ? (
              <span className="flex items-center gap-1">
                <LockIcon className="size-3" />
                {t("privateChat")}
              </span>
            ) : (
              <span>{appeal.chat.label}</span>
            )
          ) : appeal.document ? (
            <span className="flex items-center gap-1">
              <FileTextIcon className="size-3" />
              {t("documentPrompt", { title: appeal.document.title })}
            </span>
          ) : null}
          <span>{when(appeal._creationTime)}</span>
        </div>
        <blockquote className="border-l-2 border-primary/50 pl-2 break-words whitespace-pre-wrap">{appeal.question}</blockquote>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">{t("reason")}</dt>
          <dd>{appeal.reason || "—"}</dd>
          <dt className="text-muted-foreground">{t("note")}</dt>
          <dd className="break-words whitespace-pre-wrap">{appeal.note || "—"}</dd>
          {appeal.status !== "pending" ? (
            <>
              <dt className="text-muted-foreground">{t("reviewedBy")}</dt>
              <dd>
                {displayName(appeal.reviewer ?? undefined, locale)}
                {appeal.reviewedAt ? ` · ${when(appeal.reviewedAt)}` : ""}
              </dd>
              {appeal.reviewNote ? (
                <>
                  <dt className="text-muted-foreground">{t("reviewNote")}</dt>
                  <dd className="break-words whitespace-pre-wrap">{appeal.reviewNote}</dd>
                </>
              ) : null}
            </>
          ) : null}
        </dl>
        {appeal.status === "pending" ? (
          <div className="flex flex-col gap-2">
            <Textarea
              value={note}
              maxLength={LIMITS.aiAppealNote}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("notePlaceholder")}
              rows={2}
            />
            <div className="flex flex-col gap-1.5 rounded-md border border-border bg-secondary/30 p-2">
              <Label className="flex items-start gap-2 text-xs font-normal">
                <Checkbox
                  checked={remember}
                  onCheckedChange={(checked) => setRemember(checked === true)}
                  className="mt-px"
                />
                <span className="flex items-center gap-1">
                  <BrainIcon className="size-3.5 text-primary" />
                  {t("remember")}
                </span>
              </Label>
              {remember ? (
                <>
                  <Textarea
                    value={rule}
                    maxLength={LIMITS.aiMemoryRule}
                    onChange={(e) => setRule(e.target.value)}
                    placeholder={t("rulePlaceholder")}
                    aria-label={t("rule")}
                    rows={2}
                    className="bg-background"
                  />
                  <p className="text-xs text-muted-foreground">{t("rememberHint")}</p>
                </>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy || (remember && !rule.trim())} onClick={() => void decide(true)}>
                <CheckIcon />
                {t("approve")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || (remember && !rule.trim())}
                onClick={() => void decide(false)}
              >
                <XIcon />
                {t("deny")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("decisionHint")}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type Verdict = "allow" | "refuse";
type Rule = FunctionReturnType<typeof api.aiMemory.list>["rules"][number];

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const t = useTranslations("aiAdmin");
  return (
    <Badge variant={verdict === "allow" ? "secondary" : "destructive"} className="shrink-0">
      {t(`verdict.${verdict}`)}
    </Badge>
  );
}

function Memory() {
  const t = useTranslations("aiAdmin");
  const data = useQuery(api.aiMemory.list);
  const add = useMutation(api.aiMemory.add);
  const showError = useErrorToast();
  const [verdict, setVerdict] = useState<Verdict>("allow");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const full = data !== undefined && data.rules.length >= data.max;

  const submit = async () => {
    setBusy(true);
    try {
      await add({ verdict, text: text.trim() });
      setText("");
      toast.success(t("ruleAdded"));
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <BrainIcon className="size-4 text-primary" />
          {t("memory")}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t("memoryHint", { count: data?.rules.length ?? 0, max: data?.max ?? LIMITS.aiMemoryRules })}
        </p>
      </div>
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-center"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Segmented
          label={t("rule")}
          value={verdict}
          onChange={setVerdict}
          options={(["allow", "refuse"] as const).map((value) => ({ value, label: t(`verdict.${value}`) }))}
          className="shrink-0 self-start sm:self-auto"
        />
        <Input
          value={text}
          maxLength={LIMITS.aiMemoryRule}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("rulePlaceholder")}
          aria-label={t("rule")}
          disabled={full}
          className="min-w-0 flex-1"
        />
        <Button type="submit" size="sm" disabled={busy || full || !text.trim()}>
          <PlusIcon />
          {t("addRule")}
        </Button>
      </form>
      {full ? <p className="text-xs text-warning">{t("memoryFull")}</p> : null}
      <div className="flex flex-col divide-y divide-border rounded-md border border-border">
        {data === undefined ? (
          <Skeleton className="m-2 h-10" />
        ) : data.rules.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("noRules")}</p>
        ) : (
          data.rules.map((rule) => <RuleRow key={rule._id} rule={rule} />)
        )}
      </div>
    </section>
  );
}

function RuleRow({ rule }: { rule: Rule }) {
  const t = useTranslations("aiAdmin");
  const locale = useLocale() as Locale;
  const format = useFormatter();
  const update = useMutation(api.aiMemory.update);
  const remove = useMutation(api.aiMemory.remove);
  const showError = useErrorToast();
  const [editing, setEditing] = useState(false);
  const [verdict, setVerdict] = useState<Verdict>(rule.verdict);
  const [text, setText] = useState(rule.text);
  const [busy, setBusy] = useState(false);

  const startEdit = () => {
    setVerdict(rule.verdict);
    setText(rule.text);
    setEditing(true);
  };

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await action();
      setEditing(false);
      toast.success(done);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <Segmented
          label={t("rule")}
          value={verdict}
          onChange={setVerdict}
          options={(["allow", "refuse"] as const).map((value) => ({ value, label: t(`verdict.${value}`) }))}
          className="self-start"
        />
        <Textarea
          value={text}
          maxLength={LIMITS.aiMemoryRule}
          onChange={(e) => setText(e.target.value)}
          aria-label={t("rule")}
          rows={2}
          autoFocus
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={busy || !text.trim()}
            onClick={() => void run(() => update({ ruleId: rule._id, verdict, text: text.trim() }), t("ruleSaved"))}
          >
            <CheckIcon />
            {t("save")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
            {t("cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 p-3 text-sm">
      <VerdictBadge verdict={rule.verdict} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="break-words whitespace-pre-wrap">{rule.text}</p>
        <p className="text-xs text-muted-foreground">
          {t(rule.fromAppeal ? "ruleFromAppeal" : "ruleManual", {
            name: displayName(rule.updatedBy ?? undefined, locale),
            time: format.dateTime(rule.updatedAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
          })}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button size="icon-sm" variant="ghost" aria-label={t("editRule")} disabled={busy} onClick={startEdit}>
          <PencilIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("removeRule")}
          disabled={busy}
          onClick={() => void run(() => remove({ ruleId: rule._id }), t("ruleRemoved"))}
        >
          <Trash2Icon />
        </Button>
      </div>
    </div>
  );
}

function Overview() {
  const t = useTranslations("aiAdmin");
  const locale = useLocale() as Locale;
  const format = useFormatter();
  const data = useQuery(api.ai.overview);
  if (!data) return <Skeleton className="h-40" />;
  return (
    <>
      {!data.configured ? (
        <p className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-warning">
          {t("notConfigured")}
        </p>
      ) : null}
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t("usage")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("usageHint", {
              reset: format.dateTime(data.nextResetAt, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
            })}
          </p>
        </div>
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-secondary/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">{t("person")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("questions")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("refused")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("credits")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.usage.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-muted-foreground">
                    {t("noUsage")}
                  </td>
                </tr>
              ) : (
                data.usage.map((row) => (
                  <tr key={row.user._id}>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <PersonAvatar person={row.user} className="size-6" />
                        {displayName(row.user, locale)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.questions}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.refused}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.used}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t("chats")}</h2>
          <p className="text-xs text-muted-foreground">{t("chatsHint")}</p>
        </div>
        <div className="flex flex-col divide-y divide-border rounded-md border border-border">
          {data.chats.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("noChats")}</p>
          ) : (
            data.chats.map((chat) => (
              <div key={chat._id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{chat.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {chat.enabledBy ? displayName(chat.enabledBy, locale) : null}
                  {chat.enabledAt ? ` · ${format.dateTime(chat.enabledAt, { year: "numeric", month: "short", day: "numeric" })}` : null}
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </>
  );
}
