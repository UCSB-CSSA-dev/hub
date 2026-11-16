import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { channelMemberRow, myChannels, readBaseline, unseenAnnouncements } from "./channels";
import { LIMITS } from "./constants";
import { isLiveUserContent, previewText } from "./messages";
import { buildViewerContext } from "./permissions";
import { eventEnd, taskLink } from "./tasks";
import { endOfPacificDay, startOfPacificDay } from "./time";

export type DigestItem = {
  title: string;
  kind: "task" | "event";
  /** The task's chat: 全体, a department, or a group name. */
  chatZh: string;
  chatEn: string;
  dueAt?: number;
  startAt?: number;
  endAt?: number;
  location?: string;
  overdue?: boolean;
  /** In-app path, made absolute with SITE_URL when rendering. */
  link: string;
};

export type DigestMessage = { author: string; text: string; at: number };

export type DigestChat = {
  name: string;
  /** In-app path, made absolute with SITE_URL when rendering. */
  link: string;
  unread: number;
  /** Muted chats show only the count. */
  muted: boolean;
  /** The newest unread messages, oldest first. */
  messages: DigestMessage[];
};

export type DigestAnnouncement = DigestMessage & { chat: string; link: string };

export type Digest = {
  today: DigestItem[];
  /** Events and tasks due in the next 7 days, after today. */
  week: DigestItem[];
  /** Tasks due later or with no due date. */
  todos: DigestItem[];
  announcements: DigestAnnouncement[];
  chats: DigestChat[];
};

export type DigestLocale = "zh" | "en";

export function isEmptyDigest(digest: Digest) {
  return (
    digest.today.length + digest.week.length + digest.todos.length + digest.announcements.length + digest.chats.length === 0
  );
}

function personName(user: Doc<"users"> | null, locale: DigestLocale) {
  if (!user) return "";
  const names = locale === "en" ? [user.nameEn, user.nameZh] : [user.nameZh, user.nameEn];
  return names.find(Boolean) || user.name || user.email || "";
}

const LABELS = {
  zh: { general: "全体", forward: "[聊天记录]", task: "[任务]", doc: "[文档]", attachment: "[附件]", all: "@所有人" },
  en: { general: "General", forward: "[Chat history]", task: "[Task]", doc: "[Doc]", attachment: "[Attachment]", all: "@everyone" },
} as const;

async function messageText(ctx: QueryCtx, message: Doc<"messages">, locale: DigestLocale) {
  const labels = LABELS[locale];
  const names = new Map<string, string>();
  for (const id of message.mentionUserIds ?? []) names.set(id, personName(await ctx.db.get("users", id), locale));
  const body = previewText(message.body.replace(/<@all>/gi, labels.all), names, LIMITS.digestMessageChars);
  const kind = message.kind ?? "user";
  if (kind === "forward" || kind === "task" || kind === "doc") return body ? `${labels[kind]} ${body}` : labels[kind];
  return body || labels.attachment;
}

async function toDigestMessage(ctx: QueryCtx, message: Doc<"messages">, locale: DigestLocale): Promise<DigestMessage> {
  return {
    author: personName(await ctx.db.get("users", message.authorId), locale),
    text: await messageText(ctx, message, locale),
    at: message._creationTime,
  };
}

async function digestChatName(ctx: QueryCtx, channel: Doc<"channels">, userId: Id<"users">, locale: DigestLocale) {
  if (channel.type === "org") return LABELS[locale].general;
  if (channel.type === "group") return channel.name ?? "";
  if (channel.departmentId) {
    const department = await ctx.db.get("departments", channel.departmentId);
    return department ? (locale === "en" ? department.nameEn || department.nameZh : department.nameZh) : "";
  }
  const other = (
    await ctx.db
      .query("channelMembers")
      .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
      .collect()
  ).find((row) => row.userId !== userId);
  return personName(other ? await ctx.db.get("users", other.userId) : null, locale);
}

/**
 * Unread messages in each of the user's chats (the same chats as their chat list) and announcements
 * they haven't acknowledged. Announcements are listed once, in their own section.
 */
async function buildUnread(ctx: QueryCtx, user: Doc<"users">, locale: DigestLocale) {
  const viewer = await buildViewerContext(ctx, user);
  const { org, departments, groups, dms } = await myChannels(ctx, viewer);
  const announcements: DigestAnnouncement[] = [];
  const chats: { chat: DigestChat; latest: number }[] = [];

  for (const channel of [...org, ...departments, ...groups, ...dms]) {
    const row = await channelMemberRow(ctx, channel._id, user._id);
    const link = `/chat/?c=${channel._id}`;
    let name: string | null = null;
    const chatName = async () => (name ??= await digestChatName(ctx, channel, user._id, locale));

    if (channel.type === "org" || channel.type === "department") {
      for (const message of await unseenAnnouncements(ctx, channel._id, user, row, LIMITS.digestItems)) {
        announcements.push({ ...(await toDigestMessage(ctx, message, locale)), chat: await chatName(), link });
      }
    }

    const unread = (
      await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) =>
          q.eq("channelId", channel._id).gt("_creationTime", row?.lastReadAt ?? readBaseline(user)),
        )
        .order("desc")
        .take(LIMITS.unreadCountCap + 20)
    ).filter((m) => m.authorId !== user._id && isLiveUserContent(m) && m.announcement !== true);
    if (unread.length === 0) continue;
    const muted = row?.muted === true;
    const shown = muted ? [] : unread.slice(0, LIMITS.digestChatMessages).reverse();
    chats.push({
      chat: {
        name: await chatName(),
        link,
        unread: unread.length,
        muted,
        messages: await Promise.all(shown.map((m) => toDigestMessage(ctx, m, locale))),
      },
      latest: unread[0]._creationTime,
    });
  }

  announcements.sort((a, b) => b.at - a.at);
  chats.sort((a, b) => Number(a.chat.muted) - Number(b.chat.muted) || b.latest - a.latest);
  return {
    announcements: announcements.slice(0, LIMITS.digestItems),
    chats: chats.slice(0, LIMITS.digestChats).map(({ chat }) => chat),
  };
}

async function chatNames(ctx: QueryCtx, channelId: Id<"channels">, cache: Map<string, [string, string]>) {
  const cached = cache.get(channelId);
  if (cached) return cached;
  const channel = await ctx.db.get("channels", channelId);
  let names: [string, string] = ["", ""];
  if (channel?.type === "org") names = ["全体", "General"];
  else if (channel?.type === "group") names = [channel.name ?? "", channel.name ?? ""];
  else if (channel?.departmentId) {
    const department = await ctx.db.get("departments", channel.departmentId);
    if (department) names = [department.nameZh, department.nameEn];
  }
  cache.set(channelId, names);
  return names;
}

/**
 * The morning email: today (overdue, due today, events today), events and tasks in the next 7 days,
 * every other to-do, unread announcements, and unread messages in each chat.
 */
export async function buildDigest(
  ctx: QueryCtx,
  userId: Id<"users">,
  now: number,
  locale: DigestLocale = "zh",
): Promise<Digest> {
  const todayEnd = endOfPacificDay(now);
  const weekEnd = startOfPacificDay(todayEnd + LIMITS.digestEventDays * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000);
  const rows = await ctx.db
    .query("assignmentSubmissions")
    .withIndex("by_assignee", (q) => q.eq("assigneeId", userId))
    .collect();
  const cache = new Map<string, [string, string]>();
  const digest = { today: [] as DigestItem[], week: [] as DigestItem[], todos: [] as DigestItem[] };

  for (const row of rows) {
    const assignment = await ctx.db.get("assignments", row.assignmentId);
    if (!assignment || assignment.status !== "open") continue;
    const [chatZh, chatEn] = await chatNames(ctx, assignment.channelId, cache);
    const base = { title: assignment.title, kind: assignment.kind, chatZh, chatEn, link: taskLink(assignment._id) };

    if (assignment.kind === "event") {
      if (!assignment.startAt || eventEnd(assignment) <= now) continue;
      const item: DigestItem = { ...base, startAt: assignment.startAt, endAt: assignment.endAt, location: assignment.location };
      if (assignment.startAt < todayEnd) digest.today.push(item);
      else if (assignment.startAt < weekEnd) digest.week.push(item);
      continue;
    }

    if (row.status !== "assigned" && row.status !== "changes_requested") continue;
    const item: DigestItem = { ...base, dueAt: assignment.dueAt };
    if (assignment.dueAt !== undefined && assignment.dueAt < now) digest.today.push({ ...item, overdue: true });
    else if (assignment.dueAt !== undefined && assignment.dueAt < todayEnd) digest.today.push(item);
    else if (assignment.dueAt !== undefined && assignment.dueAt < weekEnd) digest.week.push(item);
    else digest.todos.push(item);
  }

  const time = (item: DigestItem) => item.startAt ?? item.dueAt ?? Number.MAX_SAFE_INTEGER;
  digest.today.sort((a, b) => Number(b.overdue === true) - Number(a.overdue === true) || time(a) - time(b));
  digest.week.sort((a, b) => time(a) - time(b));
  digest.todos.sort((a, b) => time(a) - time(b));
  const user = await ctx.db.get("users", userId);
  return {
    today: digest.today.slice(0, LIMITS.digestItems),
    week: digest.week.slice(0, LIMITS.digestItems),
    todos: digest.todos.slice(0, LIMITS.digestItems),
    ...(user ? await buildUnread(ctx, user, locale) : { announcements: [], chats: [] }),
  };
}

export type DigestRecipient = Pick<
  Doc<"users">,
  "email" | "digestEmail" | "digestLocale" | "locale" | "nameZh" | "nameEn" | "name"
>;

export function digestLocale(user: DigestRecipient): DigestLocale {
  return user.digestLocale ?? user.locale ?? "zh";
}

export function digestAddress(user: DigestRecipient) {
  return user.digestEmail || user.email || null;
}
