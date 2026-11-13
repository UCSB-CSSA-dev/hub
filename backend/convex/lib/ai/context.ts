import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { channelAccess } from "../channels";
import { LIMITS, SASA, TIME_ZONE } from "../constants";
import { isLiveUserContent } from "../messages";
import type { ViewerContext } from "../permissions";
import { eventEnd, taskAccess } from "../tasks";
import { MENTION_PATTERN, searchTerms } from "../text";
import type { ChatMessage } from "./client";
import { isAiChannelType } from "./sasa";

// Everything 小飒 is shown comes from here. It only ever includes:
// - messages flagged aiReadable (sent while AI mode was on), live, from chats the asker reads as a participant;
// - tasks and events the asker can see under taskAccess;
// - 集会 meetings in those chats.

const stamp = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  weekday: "short",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function pacificStamp(ms: number) {
  return stamp.format(new Date(ms));
}

const nowFormat = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, dateStyle: "full", timeStyle: "short" });

/** "Friday, November 13, 2026 at 3:04 PM", Pacific, for prompts. */
export function nowLabel() {
  return nowFormat.format(new Date());
}

export function personLabel(user: Pick<Doc<"users">, "nameZh" | "nameEn" | "name" | "email" | "isBot"> | null) {
  if (!user) return "?";
  if (user.isBot) return `${SASA.nameZh} (${SASA.nameEn})`;
  if (user.nameZh && user.nameEn && user.nameZh !== user.nameEn) return `${user.nameZh} (${user.nameEn})`;
  return user.nameZh || user.nameEn || user.name || user.email || "?";
}

/** Caches user names; renders `<@id>` tokens as "@name". */
export class Names {
  private cache = new Map<string, string>();
  constructor(private ctx: QueryCtx) {}

  async of(id: string) {
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const userId = this.ctx.db.normalizeId("users", id);
    const label = personLabel(userId ? await this.ctx.db.get("users", userId) : null);
    this.cache.set(id, label);
    return label;
  }

  async text(body: string) {
    let out = body;
    for (const match of body.matchAll(MENTION_PATTERN)) {
      const label = match[1].toLowerCase() === "all" ? "所有人" : await this.of(match[1]);
      out = out.split(match[0]).join(`@${label}`);
    }
    return out;
  }
}

export async function channelLabel(ctx: QueryCtx, channel: Doc<"channels">) {
  if (channel.type === "org") return "全体 (General)";
  if (channel.departmentId) {
    const department = await ctx.db.get("departments", channel.departmentId);
    return department ? `${department.nameZh} (${department.nameEn})` : "?";
  }
  if (channel.type === "group") return channel.name ?? "?";
  if (channel.type === "assistant") return "小飒 (Sasa)";
  return "DM";
}

export function roleLabel(viewer: ViewerContext) {
  if (viewer.isSystemAdmin) return viewer.isPresidium ? "主席团 / Presidium and system admin" : "system admin (not in 主席团)";
  if (viewer.isPresidium) return "主席团 / Presidium";
  if (viewer.ledDepartmentIds.length > 0) return "部长 / department lead";
  return "部员 / member";
}

function readable(message: Doc<"messages">) {
  if (!message.aiReadable || !isLiveUserContent(message)) return false;
  if (message.kind === "ai") return message.ai?.status === "done" && !message.ai.notice && !message.ai.suggestionId;
  return message.kind === "user" || message.kind === "task" || message.kind === undefined;
}

async function messageLine(ctx: QueryCtx, names: Names, message: Doc<"messages">) {
  const who = await names.of(message.authorId);
  if (message.kind === "task" && message.assignmentId) {
    const task = await ctx.db.get("assignments", message.assignmentId);
    return task ? `[${pacificStamp(message._creationTime)}] ${who} published ${task.kind} "${task.title}"` : null;
  }
  const body = (await names.text(message.body)).replace(/\s+/g, " ").trim();
  if (!body) return null;
  return `[${pacificStamp(message._creationTime)}] ${who}: ${body.slice(0, 1500)}`;
}

/** AI-readable history of one chat, newest messages plus keyword hits, trimmed to `budget` characters. */
export async function chatLog(
  ctx: QueryCtx,
  names: Names,
  channel: Doc<"channels">,
  opts: { keywords: string[]; exclude: Set<Id<"messages">>; budget: number },
) {
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
    .order("desc")
    .take(LIMITS.aiRecentMessages);
  const terms = [...new Set(opts.keywords.flatMap((k) => searchTerms(k)))].slice(0, LIMITS.searchTerms);
  const hits =
    terms.length > 0
      ? await ctx.db
          .query("messages")
          .withSearchIndex("search_text", (q) => q.search("searchText", terms.join(" ")).eq("channelId", channel._id))
          .take(LIMITS.aiKeywordHits)
      : [];
  const hitIds = new Set(hits.map((m) => m._id));
  const byId = new Map<Id<"messages">, Doc<"messages">>();
  for (const message of [...recent, ...hits]) {
    if (!opts.exclude.has(message._id) && readable(message)) byId.set(message._id, message);
  }
  const ordered = [...byId.values()].sort((a, b) => a._creationTime - b._creationTime);
  const lines: { text: string; hit: boolean }[] = [];
  for (const message of ordered) {
    const text = await messageLine(ctx, names, message);
    if (text) lines.push({ text, hit: hitIds.has(message._id) });
  }
  let total = lines.reduce((sum, l) => sum + l.text.length + 1, 0);
  // Drop the oldest lines first, keeping keyword hits as long as possible.
  for (const keepHits of [true, false]) {
    for (let i = 0; i < lines.length && total > opts.budget; ) {
      if (keepHits && lines[i].hit) {
        i++;
        continue;
      }
      total -= lines[i].text.length + 1;
      lines.splice(i, 1);
    }
  }
  return lines.map((l) => l.text).join("\n");
}

/** Chats whose AI-readable history the viewer's private 小飒 chat can draw on. */
export async function readableAiChannels(ctx: QueryCtx, viewer: ViewerContext) {
  const channels = await ctx.db
    .query("channels")
    .withIndex("by_aiEnabled", (q) => q.eq("aiEnabled", true))
    .collect();
  const result: Doc<"channels">[] = [];
  for (const channel of channels) {
    if (!isAiChannelType(channel.type)) continue;
    if ((await channelAccess(ctx, viewer, channel)).via === "member") result.push(channel);
  }
  return result;
}

async function taskLine(ctx: QueryCtx, names: Names, viewer: ViewerContext, assignment: Doc<"assignments">) {
  const channel = await ctx.db.get("channels", assignment.channelId);
  const parts = [`${assignment.kind === "event" ? "活动 event" : "任务 task"} "${assignment.title}"`];
  if (channel) parts.push(`chat: ${await channelLabel(ctx, channel)}`);
  if (assignment.dueAt) parts.push(`due: ${pacificStamp(assignment.dueAt)}`);
  if (assignment.startAt) parts.push(`starts: ${pacificStamp(assignment.startAt)}`);
  if (assignment.endAt) parts.push(`ends: ${pacificStamp(assignment.endAt)}`);
  if (assignment.location) parts.push(`place: ${assignment.location}`);
  const rows = await ctx.db
    .query("assignmentSubmissions")
    .withIndex("by_assignment", (q) => q.eq("assignmentId", assignment._id))
    .collect();
  if (rows.length > 0) {
    const shown = await Promise.all(rows.slice(0, 15).map((r) => names.of(r.assigneeId)));
    parts.push(`${assignment.kind === "event" ? "helpers" : "assignees"}: ${shown.join(", ")}${rows.length > 15 ? ` +${rows.length - 15}` : ""}`);
  }
  const mine = rows.find((r) => r.assigneeId === viewer.user._id);
  if (mine) parts.push(`asker's status: ${mine.status}`);
  if (assignment.createdBy === viewer.user._id) parts.push("created by the asker");
  if (assignment.description) {
    parts.push(`details: ${(await names.text(assignment.description)).replace(/\s+/g, " ").slice(0, 300)}`);
  }
  return `- ${parts.join(" | ")}`;
}

function stillRelevant(assignment: Doc<"assignments">, now: number) {
  if (assignment.status !== "open") return false;
  if (assignment.kind === "event") return eventEnd(assignment) > now - 24 * 60 * 60 * 1000;
  return true;
}

/** Open tasks and upcoming events in these chats, plus (private chat) everything assigned to or created by the viewer. */
export async function taskList(
  ctx: QueryCtx,
  names: Names,
  viewer: ViewerContext,
  channels: Doc<"channels">[],
  includeOwn: boolean,
) {
  const now = Date.now();
  const found = new Map<Id<"assignments">, Doc<"assignments">>();
  for (const channel of channels) {
    const rows = await ctx.db
      .query("assignments")
      .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
      .order("desc")
      .take(100);
    for (const row of rows) if (stillRelevant(row, now)) found.set(row._id, row);
  }
  if (includeOwn) {
    const submissions = await ctx.db
      .query("assignmentSubmissions")
      .withIndex("by_assignee", (q) => q.eq("assigneeId", viewer.user._id))
      .collect();
    for (const submission of submissions) {
      const assignment = await ctx.db.get("assignments", submission.assignmentId);
      if (assignment && stillRelevant(assignment, now)) found.set(assignment._id, assignment);
    }
    const created = await ctx.db
      .query("assignments")
      .withIndex("by_creator", (q) => q.eq("createdBy", viewer.user._id))
      .collect();
    for (const assignment of created) if (stillRelevant(assignment, now)) found.set(assignment._id, assignment);
  }
  const visible: Doc<"assignments">[] = [];
  for (const assignment of found.values()) {
    if ((await taskAccess(ctx, viewer, assignment))?.view) visible.push(assignment);
  }
  const when = (a: Doc<"assignments">) => a.startAt ?? a.dueAt ?? Number.MAX_SAFE_INTEGER;
  visible.sort((a, b) => when(a) - when(b));
  const lines: string[] = [];
  for (const assignment of visible.slice(0, 60)) lines.push(await taskLine(ctx, names, viewer, assignment));
  return lines.join("\n");
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SLOTS_PER_DAY = (24 * 60) / LIMITS.meetingSlotMinutes;

function slotText(slot: number, minutes: number) {
  const day = Math.floor(slot / SLOTS_PER_DAY);
  const start = (slot % SLOTS_PER_DAY) * LIMITS.meetingSlotMinutes;
  const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `every ${WEEKDAYS[day]} ${clock(start)}-${clock(start + minutes)}`;
}

/** 集会 (weekly meeting finders) in these chats: running ones and confirmed times. */
export async function meetingList(ctx: QueryCtx, channels: Doc<"channels">[]) {
  const lines: string[] = [];
  for (const channel of channels) {
    for (const status of ["active", "closed"] as const) {
      const apps = await ctx.db
        .query("chatApps")
        .withIndex("by_channel_status", (q) => q.eq("channelId", channel._id).eq("status", status))
        .collect();
      for (const app of apps) {
        if (app.kind !== "meeting") continue;
        const minutes = Number((app.config as { durationMinutes?: number }).durationMinutes ?? 60);
        const time =
          app.confirmedSlot !== undefined
            ? `confirmed: ${slotText(app.confirmedSlot, minutes)}`
            : status === "active"
              ? "still collecting availability"
              : "closed without a confirmed time";
        lines.push(`- 集会 meeting "${app.title}" | chat: ${await channelLabel(ctx, channel)} | ${time}`);
      }
    }
  }
  return lines.join("\n");
}

/** Earlier turns of the private 小飒 chat, oldest first. */
export async function privateHistory(
  ctx: QueryCtx,
  names: Names,
  channelId: Id<"channels">,
  before: number,
): Promise<ChatMessage[]> {
  const rows = await ctx.db
    .query("messages")
    .withIndex("by_channel", (q) => q.eq("channelId", channelId).lt("_creationTime", before))
    .order("desc")
    .take(LIMITS.aiPrivateTurns * 2);
  const turns: ChatMessage[] = [];
  for (const message of rows.reverse()) {
    if (!isLiveUserContent(message) || !message.body) continue;
    if (message.kind === "ai") {
      if (message.ai?.status === "done" && !message.ai.notice) turns.push({ role: "assistant", content: message.body });
    } else if (message.kind === "user" || message.kind === undefined) {
      turns.push({ role: "user", content: await names.text(message.body) });
    }
  }
  return turns;
}
