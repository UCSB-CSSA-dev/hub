import type { NotificationType } from "./constants";

export type PushLocale = "zh" | "en";
export type PushInput = {
  type: NotificationType | "dm" | "chat" | "test";
  params: Record<string, unknown>;
  link?: string;
  /** Replaces an earlier notification with the same tag on the device. */
  tag?: string;
};
type Named = { name?: string; nameZh?: string; nameEn?: string; email?: string };
export type PushLookup = {
  people: Record<string, Named>;
  departments: Record<string, { nameZh: string; nameEn: string }>;
};

// Mirrors the "notifications" strings in frontend/messages/{zh,en}.json; the service worker can't run next-intl.
const TEXT = {
  zh: {
    someone: "某人",
    aDepartment: "某部门",
    general: "全体",
    chatBody: "{actor}：{preview}",
    mention: "{actor} 提到了你",
    mentionAll: "{actor} @了所有人",
    reply: "{actor} 回复了你",
    announcement: "{actor} 发布了公告",
    addedToGroup: "{actor} 将你加入了群聊「{name}」",
    addedToDepartment: "{actor} 将你加入了{department}（{role}）",
    deactivationDeclined: "主席团未批准你的停用申请",
    groupProposed: "{proposer} 申请创建群聊「{name}」，等待你审核",
    groupApproved: "{reviewer} 批准了你的群聊申请「{name}」",
    groupRejected: "{reviewer} 拒绝了你的群聊申请「{name}」",
    groupExpired: "群聊申请「{name}」超过 14 天未处理，已过期",
    groupTakeover: "{department}没有部长，主席团已接管 {count} 个群聊",
    appProposed: "{actor} 申请发起{kind}「{title}」",
    appApproved: "{reviewer} 批准了你的{kind}「{title}」",
    appRejected: "{reviewer} 拒绝了你的{kind}「{title}」",
    appDueSoon: "{kind}「{title}」即将截止，别忘了参与",
    assignmentNew: "{actor} 给你安排了{kind}「{title}」",
    assignmentUpdated: "{kind}「{title}」的时间或地点有变动",
    assignmentDueSoon: "任务「{title}」将在 24 小时内截止",
    assignmentOverdue: "任务「{title}」已逾期",
    eventSoon: "活动「{title}」将在 24 小时内开始",
    submissionReceived: "{actor} 提交了「{title}」",
    submissionApproved: "{actor} 通过了你的「{title}」",
    submissionChanges: "{actor} 请你修改「{title}」",
    submissionCompleted: "{actor} 把你的「{title}」标记为已完成",
    assignmentComment: "{actor} 评论了「{title}」",
    docMention: "{actor} 在文档「{title}」中提到了你",
    taskMention: "{actor} 在{kind}「{title}」中提到了你",
    aiAppeal: "{actor} 对小飒的拒绝提出了申诉",
    aiAppealApproved: "你的申诉已通过，小飒会回答你的问题",
    aiAppealDenied: "你的申诉未通过",
    task: "任务",
    event: "活动",
    signup: "接龙",
    poll: "投票",
    meeting: "集会",
    lead: "部长",
    member: "部员",
    attachment: "[文件]",
    testTitle: "CSSA Hub 通知已开启",
    testBody: "有新消息时会这样提醒你。",
  },
  en: {
    someone: "Someone",
    aDepartment: "a department",
    general: "General",
    chatBody: "{actor}: {preview}",
    mention: "{actor} mentioned you",
    mentionAll: "{actor} mentioned everyone",
    reply: "{actor} replied to you",
    announcement: "{actor} posted an announcement",
    addedToGroup: '{actor} added you to "{name}"',
    addedToDepartment: "{actor} added you to {department} ({role})",
    deactivationDeclined: "The Presidium declined your deactivation request",
    groupProposed: '{proposer} requested the group "{name}" and needs your review',
    groupApproved: '{reviewer} approved your group "{name}"',
    groupRejected: '{reviewer} declined your group request "{name}"',
    groupExpired: 'Your group request "{name}" expired after 14 days without review',
    groupTakeover: "{department} has no lead; the Presidium now manages {count} group(s)",
    appProposed: '{actor} proposed a {kind}: "{title}"',
    appApproved: '{reviewer} approved your {kind} "{title}"',
    appRejected: '{reviewer} declined your {kind} "{title}"',
    appDueSoon: 'The {kind} "{title}" closes soon',
    assignmentNew: '{actor} assigned you a {kind}: "{title}"',
    assignmentUpdated: 'The time or place of the {kind} "{title}" changed',
    assignmentDueSoon: 'The task "{title}" is due within 24 hours',
    assignmentOverdue: 'The task "{title}" is overdue',
    eventSoon: 'The event "{title}" starts within 24 hours',
    submissionReceived: '{actor} submitted "{title}"',
    submissionApproved: '{actor} approved your "{title}"',
    submissionChanges: '{actor} requested changes on "{title}"',
    submissionCompleted: '{actor} marked your "{title}" as complete',
    assignmentComment: '{actor} commented on "{title}"',
    docMention: '{actor} mentioned you in "{title}"',
    taskMention: '{actor} mentioned you in the {kind} "{title}"',
    aiAppeal: "{actor} appealed a refusal by Sasa",
    aiAppealApproved: "Your appeal was approved; Sasa will answer your question",
    aiAppealDenied: "Your appeal was declined",
    task: "task",
    event: "event",
    signup: "Sign-up",
    poll: "Poll",
    meeting: "Meeting",
    lead: "Lead",
    member: "Member",
    attachment: "[File]",
    testTitle: "CSSA Hub notifications are on",
    testBody: "This is how new activity will reach you.",
  },
} as const;

type Key = keyof (typeof TEXT)["zh"];

const REVIEW_TITLE: Record<string, Key> = {
  approve: "submissionApproved",
  request_changes: "submissionChanges",
  complete: "submissionCompleted",
};

function fill(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

export function pushText(input: PushInput, locale: PushLocale, lookup: PushLookup): { title: string; body?: string } {
  const text = TEXT[locale];
  const t = (key: Key, values: Record<string, string | number> = {}) => fill(text[key], values);
  const params = input.params;
  const person = (key: string) => {
    const p = lookup.people[String(params[key])];
    const primary = locale === "zh" ? p?.nameZh : p?.nameEn;
    const secondary = locale === "zh" ? p?.nameEn : p?.nameZh;
    return primary || secondary || p?.name || p?.email || text.someone;
  };
  const department = () => {
    const d = lookup.departments[String(params.departmentId)];
    return d ? (locale === "zh" ? d.nameZh : d.nameEn || d.nameZh) : text.aDepartment;
  };
  const name = String(params.name ?? "");
  const title = String(params.title ?? "");
  const kind = () => (params.kind === "signup" || params.kind === "poll" || params.kind === "meeting" ? text[params.kind] : "");
  const taskKind = () => (params.kind === "event" ? text.event : text.task);
  const preview = typeof params.preview === "string" && params.preview ? params.preview : undefined;
  const note = typeof params.note === "string" && params.note ? params.note : undefined;

  switch (input.type) {
    case "test":
      return { title: text.testTitle, body: text.testBody };
    case "dm":
      return { title: person("actorId"), body: preview ?? text.attachment };
    case "chat":
      return {
        title: name || (params.departmentId ? department() : text.general),
        body: t("chatBody", { actor: person("actorId"), preview: preview ?? text.attachment }),
      };
    case "mention":
      return { title: t(params.all ? "mentionAll" : "mention", { actor: person("actorId") }), body: preview };
    case "reply":
      return { title: t("reply", { actor: person("actorId") }), body: preview };
    case "announcement":
      return { title: t("announcement", { actor: person("actorId") }), body: preview };
    case "added_to_group":
      return { title: t("addedToGroup", { actor: person("actorId"), name }) };
    case "added_to_department":
      return {
        title: t("addedToDepartment", {
          actor: person("actorId"),
          department: department(),
          role: params.role === "lead" ? text.lead : text.member,
        }),
      };
    case "deactivation_reviewed":
      return { title: t("deactivationDeclined"), body: note };
    case "group_proposed":
      return { title: t("groupProposed", { proposer: person("proposerId"), name }) };
    case "group_approved":
      return { title: t("groupApproved", { reviewer: person("reviewerId"), name }) };
    case "group_rejected":
      return { title: t("groupRejected", { reviewer: person("reviewerId"), name }), body: note };
    case "group_expired":
      return { title: t("groupExpired", { name }) };
    case "group_takeover":
      return {
        title: t("groupTakeover", { department: department(), count: Number(params.count ?? 0) }),
        body: Array.isArray(params.groupNames) ? params.groupNames.join(locale === "zh" ? "、" : ", ") : undefined,
      };
    case "app_proposed":
      return { title: t("appProposed", { actor: person("actorId"), kind: kind(), title }) };
    case "app_approved":
      return { title: t("appApproved", { reviewer: person("reviewerId"), kind: kind(), title }) };
    case "app_rejected":
      return { title: t("appRejected", { reviewer: person("reviewerId"), kind: kind(), title }), body: note };
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
        body: note,
      };
    case "assignment_comment":
      return { title: t("assignmentComment", { actor: person("actorId"), title }), body: preview };
    case "doc_mention":
      return { title: t("docMention", { actor: person("actorId"), title }) };
    case "task_mention":
      return { title: t("taskMention", { actor: person("actorId"), kind: taskKind(), title }) };
    case "ai_appeal":
      return { title: t("aiAppeal", { actor: person("actorId") }), body: preview };
    case "ai_appeal_reviewed":
      return { title: t(params.approved ? "aiAppealApproved" : "aiAppealDenied"), body: note };
  }
}
