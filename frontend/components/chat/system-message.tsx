"use client";

import { useLocale, useTranslations } from "next-intl";
import { clock, slotDay, slotMinutes } from "@/components/apps/slots";
import type { Locale } from "@/lib/locale-store";
import { displayName, localized } from "@/lib/names";
import type { Message } from "./types";

export function useSystemText() {
  const t = useTranslations("system");
  const tDays = useTranslations("weekdays");
  const tApps = useTranslations("apps");
  const locale = useLocale() as Locale;
  return (message: Message) => {
    const params = message.system?.params ?? {};
    const person = (key: string) =>
      displayName(
        message.people.find((p) => p._id === params[key]),
        locale,
      ) || t("someone");
    const people = (key: string) =>
      ((params[key] as string[] | undefined) ?? [])
        .map((id) => displayName(message.people.find((p) => p._id === id), locale))
        .filter(Boolean)
        .join(locale === "zh" ? "、" : ", ");
    const department = () => {
      const d = message.departments.find((d) => d._id === params.departmentId);
      return d ? localized(d.nameZh, d.nameEn, locale) : t("aDepartment");
    };
    const name = String(params.name ?? "");

    switch (message.system?.event) {
      case "group_created":
        return params.proposerId
          ? t("groupCreatedByProposal", { proposer: person("proposerId"), approver: person("approverId"), name })
          : t("groupCreated", { actor: person("actorId"), name });
      case "members_added":
        return t("membersAdded", { actor: person("actorId"), people: people("userIds") });
      case "member_removed":
        return t("memberRemoved", { actor: person("actorId"), person: person("userId") });
      case "member_left":
        return t("memberLeft", { person: person("userId") });
      case "renamed":
        return t("renamed", { actor: person("actorId"), name });
      case "department_added":
        return t("departmentAdded", { actor: person("actorId"), department: department() });
      case "department_removed":
        return t("departmentRemoved", { actor: person("actorId"), department: department() });
      case "takeover_started":
        return t("takeoverStarted", { department: department() });
      case "takeover_ended":
        return t("takeoverEnded");
      case "group_ended":
        return t("groupEnded", { actor: person("actorId") });
      case "retention_changed":
        return t("retentionChanged", { actor: person("actorId"), days: Number(params.to) });
      case "app_started":
        return t("appStarted", {
          actor: person("actorId"),
          kind: tApps(`kind.${String(params.kind)}` as "kind.poll"),
          title: String(params.title ?? ""),
        });
      case "ai_enabled":
        return t("aiEnabled", { actor: person("actorId") });
      case "ai_disabled":
        return t("aiDisabled", { actor: person("actorId") });
      case "meeting_confirmed": {
        const slot = Number(params.slot);
        const start = slotMinutes(slot);
        return t("meetingConfirmed", {
          title: String(params.title ?? ""),
          day: tDays(String(slotDay(slot)) as "0"),
          time: `${clock(start)}–${clock(start + Number(params.durationMinutes ?? 60))}`,
        });
      }
      default:
        return t("unknown");
    }
  };
}

export function SystemMessage({ message }: { message: Message }) {
  const text = useSystemText()(message);
  return (
    <div className="my-2 flex justify-center px-4">
      <span className="rounded-full bg-secondary/60 px-3 py-1 text-center text-xs text-muted-foreground">{text}</span>
    </div>
  );
}
