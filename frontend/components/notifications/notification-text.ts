import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import type { api } from "@/lib/api";
import type { Locale } from "@/lib/locale-store";
import { displayName, localized } from "@/lib/names";

export type Notification = FunctionReturnType<typeof api.notifications.listMine>["page"][number];

const REVIEW_TITLE: Record<string, "submissionApproved" | "submissionChanges" | "submissionCompleted"> = {
  approve: "submissionApproved",
  request_changes: "submissionChanges",
  complete: "submissionCompleted",
};

/** Title and optional detail line for a notification, built from its type and params. */
export function useNotificationText() {
  const t = useTranslations("notifications");
  const tApps = useTranslations("apps");
  const tRoles = useTranslations("roles");
  const locale = useLocale() as Locale;
  return (n: Notification): { title: string; detail?: string } => {
    const params = n.params;
    const person = (key: string) =>
      displayName(
        n.people.find((p) => p._id === params[key]),
        locale,
      ) || t("someone");
    const department = () => {
      const d = n.departments[0];
      return d ? localized(d.nameZh, d.nameEn, locale) : t("aDepartment");
    };
    const name = String(params.name ?? "");
    const title = String(params.title ?? "");
    const kind = () => tApps(`kind.${String(params.kind)}` as "kind.poll");
    const taskKind = () => t(params.kind === "event" ? "kindEvent" : "kindTask");
    const preview = typeof params.preview === "string" && params.preview ? params.preview : undefined;
    const note = typeof params.note === "string" && params.note ? params.note : undefined;

    switch (n.type) {
      case "mention":
        return { title: params.all ? t("mentionAll", { actor: person("actorId") }) : t("mention", { actor: person("actorId") }), detail: preview };
      case "reply":
        return { title: t("reply", { actor: person("actorId") }), detail: preview };
      case "announcement":
        return { title: t("announcement", { actor: person("actorId") }), detail: preview };
      case "added_to_group":
        return { title: t("addedToGroup", { actor: person("actorId"), name }) };
      case "added_to_department":
        return {
          title: t("addedToDepartment", {
            actor: person("actorId"),
            department: department(),
            role: tRoles(params.role === "lead" ? "lead" : "member"),
          }),
        };
      case "deactivation_reviewed":
        return { title: t("deactivationDeclined"), detail: note };
      case "group_proposed":
        return { title: t("groupProposed", { proposer: person("proposerId"), name }) };
      case "group_approved":
        return { title: t("groupApproved", { reviewer: person("reviewerId"), name }) };
      case "group_rejected":
        return { title: t("groupRejected", { reviewer: person("reviewerId"), name }), detail: note };
      case "group_expired":
        return { title: t("groupExpired", { name }) };
      case "group_takeover":
        return {
          title: t("groupTakeover", { department: department(), count: Number(params.count ?? 0) }),
          detail: Array.isArray(params.groupNames) ? params.groupNames.join(locale === "zh" ? "、" : ", ") : undefined,
        };
      case "app_proposed":
        return { title: t("appProposed", { actor: person("actorId"), kind: kind(), title }) };
      case "app_approved":
        return { title: t("appApproved", { reviewer: person("reviewerId"), kind: kind(), title }) };
      case "app_rejected":
        return { title: t("appRejected", { reviewer: person("reviewerId"), kind: kind(), title }), detail: note };
      case "app_due_soon":
        return { title: t("appDueSoon", { kind: kind(), title }) };
      case "assignment_new":
        return { title: t("assignmentNew", { actor: person("actorId"), kind: taskKind(), title }) };
      case "assignment_updated":
        return { title: t("assignmentUpdated", { kind: taskKind(), title }) };
      case "assignment_due_soon":
        return { title: t("assignmentDueSoon", { title }) };
      case "assignment_overdue":
        return { title: t("assignmentOverdue", { title }) };
      case "event_soon":
        return { title: t("eventSoon", { title }) };
      case "submission_received":
        return { title: t("submissionReceived", { actor: person("actorId"), title }) };
      case "submission_reviewed":
        return {
          title: t(REVIEW_TITLE[String(params.decision)] ?? "submissionChanges", { actor: person("actorId"), title }),
          detail: note,
        };
      case "assignment_comment":
        return { title: t("assignmentComment", { actor: person("actorId"), title }), detail: preview };
      case "doc_mention":
        return { title: t("docMention", { actor: person("actorId"), title }) };
      case "task_mention":
        return { title: t("taskMention", { actor: person("actorId"), kind: taskKind(), title }) };
    }
  };
}
