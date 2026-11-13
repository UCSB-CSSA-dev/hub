"use client";

import { usePaginatedQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useViewer } from "@/components/auth/account-state";
import { PageHeader } from "@/components/layout/app-shell";
import { PersonAvatar } from "@/components/people/person-avatar";
import { usePeople } from "@/components/people/use-people";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type Id } from "@/lib/api";
import type { Locale } from "@/lib/locale-store";
import { displayName } from "@/lib/names";

const ACTIONS = [
  "user.approve",
  "user.reject",
  "user.deactivate",
  "user.reactivate",
  "user.deactivation_request",
  "user.deactivation_decline",
  "user.system_admin_grant",
  "user.system_admin_revoke",
  "user.system_admin_bootstrap",
  "membership.add",
  "membership.role_change",
  "membership.remove",
  "presidium.promote",
  "presidium.retire",
  "presidium.transfer_chair",
  "preapproval.create",
  "preapproval.update",
  "preapproval.revoke",
  "preapproval.claim",
  "department.create",
  "department.update",
  "department.archive",
  "department.unarchive",
  "group.create",
  "group.end",
  "channel.retention_change",
  "channel.ai_mode",
  "ai.appeal_review",
  "ai.memory_change",
  "message.moderate_remove",
  "oversight.channel.open",
] as const;

const ALL = "all";
const PAGE_SIZE = 50;

/** next-intl treats dots as nesting, so action keys use underscores. */
const actionKey = (action: string) => action.replaceAll(".", "_");

function dayStart(value: string) {
  return value ? new Date(`${value}T00:00:00`).getTime() : undefined;
}

function dayEnd(value: string) {
  return value ? new Date(`${value}T23:59:59.999`).getTime() : undefined;
}

export default function AuditPage() {
  const t = useTranslations("admin");
  const viewer = useViewer();
  const locale = useLocale() as Locale;
  const people = usePeople();
  const [action, setAction] = useState<string>(ALL);
  const [personId, setPersonId] = useState<string>(ALL);
  const [role, setRole] = useState<"actor" | "subject">("actor");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const person = personId === ALL ? undefined : (personId as Id<"users">);
  const { results, status, loadMore } = usePaginatedQuery(
    api.admin.auditLog,
    viewer.isAdmin
      ? {
          action: action === ALL ? undefined : action,
          actorId: role === "actor" ? person : undefined,
          subjectUserId: role === "subject" ? person : undefined,
          from: dayStart(from),
          to: dayEnd(to),
        }
      : "skip",
    { initialNumItems: PAGE_SIZE },
  );

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Button asChild size="icon-sm" variant="ghost" aria-label={t("title")} className="hidden md:inline-flex">
              <Link href="/admin/">
                <ArrowLeftIcon />
              </Link>
            </Button>
            {t("auditLog")}
          </span>
        }
      />
      {!viewer.isAdmin ? (
        <p className="m-auto text-sm text-muted-foreground">{t("forbidden")}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
            <div className="flex flex-wrap items-end gap-2">
              <Select value={action} onValueChange={setAction}>
                <SelectTrigger size="sm" className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("allActions")}</SelectItem>
                  {ACTIONS.map((a) => (
                    <SelectItem key={a} value={a}>
                      {t(`actions.${actionKey(a)}` as "actions.user_approve")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={personId} onValueChange={setPersonId}>
                <SelectTrigger size="sm" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("anyone")}</SelectItem>
                  {(people ?? []).map((p) => (
                    <SelectItem key={p._id} value={p._id}>
                      {displayName(p, locale)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {person ? (
                <Select value={role} onValueChange={(v) => setRole(v as "actor" | "subject")}>
                  <SelectTrigger size="sm" className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="actor">{t("asActor")}</SelectItem>
                    <SelectItem value="subject">{t("asSubject")}</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {t("from")}
                <Input type="date" className="h-8 w-36" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {t("to")}
                <Input type="date" className="h-8 w-36" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </div>

            <div className="flex flex-col divide-y divide-border rounded-md border border-border">
              {status === "LoadingFirstPage" ? (
                [0, 1, 2].map((i) => <Skeleton key={i} className="m-2 h-10" />)
              ) : results.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">{t("noEntries")}</p>
              ) : (
                results.map((entry) => <AuditRow key={entry._id} entry={entry} />)
              )}
            </div>
            {status === "CanLoadMore" ? (
              <Button variant="ghost" size="sm" className="self-center" onClick={() => loadMore(PAGE_SIZE)}>
                {t("loadMore")}
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

type Entry = FunctionReturnType<typeof api.admin.auditLog>["page"][number];

function AuditRow({ entry }: { entry: Entry }) {
  const t = useTranslations("admin");
  const locale = useLocale() as Locale;
  const format = useFormatter();
  const actor = entry.people.find((p) => p._id === entry.actorId);
  const subject = entry.people.find((p) => p._id === entry.subjectUserId);
  const key = `actions.${actionKey(entry.action)}`;
  const label = t.has(key) ? t(key as "actions.user_approve") : entry.action;

  return (
    <div className="flex items-start gap-3 px-3 py-2.5 text-sm">
      <PersonAvatar person={actor} className="mt-0.5 size-7" />
      <div className="min-w-0 flex-1">
        <div>
          <span className="font-medium">{actor ? displayName(actor, locale) : t("system")}</span>{" "}
          <span className="text-muted-foreground">{label}</span>
          {subject ? <span> · {displayName(subject, locale)}</span> : null}
        </div>
        {entry.metadata && Object.keys(entry.metadata).length > 0 ? (
          <code className="mt-0.5 block truncate text-xs text-subtle-foreground">{JSON.stringify(entry.metadata)}</code>
        ) : null}
      </div>
      <span className="shrink-0 text-xs text-subtle-foreground">
        {format.dateTime(entry._creationTime, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
      </span>
    </div>
  );
}
