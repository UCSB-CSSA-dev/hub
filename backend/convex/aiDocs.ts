import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { createDraftFromDocument, taskChannelsFor } from "./assignments";
import type { ChatMessage } from "./lib/ai/client";
import { channelLabel, Names, nowLabel, pacificStamp, personLabel } from "./lib/ai/context";
import { settleDocRequest } from "./lib/ai/docs";
import { requireCredits, startDocSummary, startDocWrite } from "./lib/ai/flow";
import { filterMemory } from "./lib/ai/memory";
import { docSummaryPrompt, docWritePrompt, filterPrompt } from "./lib/ai/prompts";
import { aiConfigured, aiReadableChannel, ensureSasa } from "./lib/ai/sasa";
import { parseWhen } from "./lib/ai/suggestions";
import { channelAccess, channelAudience, requireChannelAccess, touchReadState, type ChannelAccess } from "./lib/channels";
import { AI_DOC_COST, LIMITS } from "./lib/constants";
import {
  chatSummary,
  docSharedIn,
  documentAccessFor,
  documentText,
  mentionableIds,
  tryDocumentAccess,
  type DocumentAccess,
} from "./lib/documents";
import { appError } from "./lib/errors";
import { previewText } from "./lib/messages";
import { chatLink, notifyMany } from "./lib/notify";
import { buildViewerContext, requireApproved, type ViewerContext } from "./lib/permissions";
import { canCreateTaskIn, taskAccess } from "./lib/tasks";
import { toSearchText } from "./lib/text";
import { getUserSummaries, type UserSummary } from "./lib/users";

// 小飒 on documents: a shared summary under each document (tasks, announcements and task changes it
// found), private writing drafts for editors, and the documents a chat question may attach.

async function summaryRow(ctx: QueryCtx, documentId: Id<"documents">) {
  return ctx.db
    .query("aiDocSummaries")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .unique();
}

async function pendingDocRequest(ctx: QueryCtx, requestId: Id<"aiRequests">) {
  const request = await ctx.db.get("aiRequests", requestId);
  if (!request || request.status !== "pending" || !request.documentId) return null;
  const user = await ctx.db.get("users", request.userId);
  if (!user || user.status !== "approved") return { request, access: null };
  return { request, access: await tryDocumentAccess(ctx, await buildViewerContext(ctx, user), request.documentId) };
}

async function failDocRequest(ctx: MutationCtx, request: Doc<"aiRequests">, error: string) {
  await ctx.db.patch("aiRequests", request._id, { status: "failed", cost: 0, error: error.slice(0, 500) });
  await settleDocRequest(ctx, request, { status: "failed" });
}

function cleanString(value: unknown, max: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

// ---------------------------------------------------------------------------------------------
// What a summary may refer to

type Scope = {
  /** For the prompt: where the document lives. */
  where: string;
  /** The chat tasks from this document go to; null for Files documents (the creator picks one). */
  channel: Doc<"channels"> | null;
  /** A prep task of an event document is linked to that event. */
  eventId?: Id<"assignments">;
  memberIds: Id<"users">[];
  /** Open tasks the summary may propose changes to. */
  tasks: Doc<"assignments">[];
};

async function openTasks(
  ctx: QueryCtx,
  viewer: ViewerContext,
  channel: Doc<"channels">,
  focus: Doc<"assignments"> | null,
) {
  const rows = await ctx.db
    .query("assignments")
    .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
    .order("desc")
    .take(100);
  const visible: Doc<"assignments">[] = [];
  for (const row of rows) {
    if (row.status !== "open") continue;
    // A task's document is about that task (and an event's prep tasks), not the whole chat.
    if (focus && row._id !== focus._id && row.eventId !== focus._id) continue;
    if ((await taskAccess(ctx, viewer, row))?.view) visible.push(row);
  }
  return visible.slice(0, 40);
}

async function summaryScope(ctx: QueryCtx, access: DocumentAccess): Promise<Scope> {
  const { parent, viewer } = access;
  if (parent.kind === "chat") {
    return {
      where: `in the chat "${await channelLabel(ctx, parent.channel)}"`,
      channel: parent.channel,
      memberIds: await channelAudience(ctx, parent.channel),
      tasks: await openTasks(ctx, viewer, parent.channel, null),
    };
  }
  if (parent.kind === "task") {
    const { assignment } = parent;
    const channel = parent.access.channel;
    return {
      where: `attached to the ${assignment.kind} "${assignment.title}"`,
      channel,
      eventId: assignment.kind === "event" && assignment.status !== "draft" ? assignment._id : undefined,
      memberIds: channel ? await channelAudience(ctx, channel) : [],
      tasks: channel ? await openTasks(ctx, viewer, channel, assignment) : [],
    };
  }
  return { where: "in Files", channel: null, memberIds: await mentionableIds(ctx, parent), tasks: [] };
}

// ---------------------------------------------------------------------------------------------
// Announcements

/** Announcements go where the viewer may announce, or to an AI-mode group chat they manage (via 小飒). */
function canAnnounceIn(channel: Doc<"channels">, access: ChannelAccess) {
  if (access.via !== "member" || !access.canPost) return false;
  if (access.canAnnounce) return true;
  return channel.type === "group" && channel.aiEnabled === true && access.canManage;
}

/** 小飒 posts the announcement in chats with AI mode on; elsewhere it's the member's own. */
function sasaAnnounces(channel: Doc<"channels">) {
  return channel.type !== "assistant" && aiReadableChannel(channel);
}

async function announceTargets(ctx: QueryCtx, viewer: ViewerContext, related: Doc<"channels"> | null) {
  const candidates = new Map<Id<"channels">, Doc<"channels">>();
  const add = (channel: Doc<"channels"> | null) => {
    if (channel && channel.type !== "dm" && channel.type !== "assistant") candidates.set(channel._id, channel);
  };
  add(related);
  add(await ctx.db.query("channels").withIndex("by_type", (q) => q.eq("type", "org")).first());
  for (const channel of await ctx.db.query("channels").withIndex("by_type", (q) => q.eq("type", "department")).collect()) {
    add(channel);
  }
  const memberships = await ctx.db
    .query("channelMembers")
    .withIndex("by_user", (q) => q.eq("userId", viewer.user._id))
    .collect();
  for (const row of memberships) if (row.joinedAt !== undefined) add(await ctx.db.get("channels", row.channelId));

  const targets: Doc<"channels">[] = [];
  for (const channel of candidates.values()) {
    if (canAnnounceIn(channel, await channelAccess(ctx, viewer, channel))) targets.push(channel);
  }
  return targets;
}

// ---------------------------------------------------------------------------------------------
// The summary under a document

type ChatRef = Awaited<ReturnType<typeof chatSummary>>;

export type DocSummaryView = {
  configured: boolean;
  /** Being (re)generated; `generatingByMe` when the viewer asked. */
  generating: boolean;
  generatingByMe: boolean;
  generatedAt?: number;
  requestedBy: UserSummary | null;
  /** The document changed after the summary was made. */
  outdated: boolean;
  /** The last attempt failed or was refused (the previous summary, if any, is still shown). */
  lastFailed: boolean;
  summary: string;
  tasks: {
    index: number;
    kind: "task" | "event";
    title: string;
    description?: string;
    assignees: UserSummary[];
    dueAt?: number;
    startAt?: number;
    endAt?: number;
    location?: string;
    /** The draft created from this item (only linked when the viewer can open it). */
    created: boolean;
    assignmentId?: Id<"assignments">;
  }[];
  /** Where the viewer can create these tasks: the document's chat, or (Files) any chat they may pick. */
  taskTargets: ChatRef[];
  taskTargetFixed: boolean;
  announcements: {
    index: number;
    body: string;
    sent: { chat: ChatRef | null; at: number; by: UserSummary | null }[];
  }[];
  announceTargets: (ChatRef & { viaSasa: boolean })[];
  edits: {
    index: number;
    assignment: { _id: Id<"assignments">; title: string; kind: "task" | "event" };
    fields: Doc<"aiDocSummaries">["edits"][number]["fields"];
    assignees: UserSummary[];
    canApply: boolean;
    applied: boolean;
  }[];
};

export const summary = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args): Promise<DocSummaryView | null> => {
    const viewer = await requireApproved(ctx);
    const access = await tryDocumentAccess(ctx, viewer, args.documentId);
    if (!access) return null;
    const row = await summaryRow(ctx, access.doc._id);
    const me = viewer.user._id;
    const pending = row?.pendingRequestId ? await ctx.db.get("aiRequests", row.pendingRequestId) : null;
    const generating = pending?.status === "pending" && Date.now() - pending._creationTime < LIMITS.aiStaleRequestMs;
    const view: DocSummaryView = {
      configured: aiConfigured(),
      generating,
      generatingByMe: generating && pending?.userId === me,
      generatedAt: row?.generatedAt,
      requestedBy: null,
      outdated: row?.docUpdatedAt !== undefined && access.doc.updatedAt > row.docUpdatedAt,
      lastFailed: row?.error !== undefined,
      summary: row?.summary ?? "",
      tasks: [],
      taskTargets: [],
      taskTargetFixed: true,
      announcements: [],
      announceTargets: [],
      edits: [],
    };
    if (!row?.generatedAt) return view;

    const people = await getUserSummaries(ctx, [
      row.requestedBy,
      ...row.tasks.flatMap((t) => t.assigneeIds),
      ...row.edits.flatMap((e) => e.fields.assigneeIds ?? []),
      ...row.announcements.flatMap((a) => a.sent.map((s) => s.by)),
    ]);
    const person = (id: Id<"users">) => people.get(id) ?? null;
    view.requestedBy = person(row.requestedBy);

    for (const [index, item] of row.tasks.entries()) {
      const draft = item.assignmentId ? await ctx.db.get("assignments", item.assignmentId) : null;
      const canOpen = draft !== null && (await taskAccess(ctx, viewer, draft))?.view === true;
      view.tasks.push({
        index,
        kind: item.kind,
        title: item.title,
        description: item.description,
        assignees: item.assigneeIds.flatMap((id) => person(id) ?? []),
        dueAt: item.dueAt,
        startAt: item.startAt,
        endAt: item.endAt,
        location: item.location,
        created: item.assignmentId !== undefined,
        assignmentId: canOpen ? draft._id : undefined,
      });
    }
    if (row.tasks.some((t) => !t.assignmentId)) {
      const scope = await summaryScope(ctx, access);
      const channels = scope.channel
        ? (await canCreateTaskIn(ctx, viewer, scope.channel))
          ? [scope.channel]
          : []
        : await taskChannelsFor(ctx, viewer);
      view.taskTargetFixed = scope.channel !== null;
      for (const channel of channels) view.taskTargets.push(await chatSummary(ctx, channel, me));
    }

    for (const [index, item] of row.announcements.entries()) {
      const sent = [];
      for (const s of item.sent) {
        const channel = await ctx.db.get("channels", s.channelId);
        sent.push({ chat: channel ? await chatSummary(ctx, channel, me) : null, at: s.at, by: person(s.by) });
      }
      view.announcements.push({ index, body: item.body, sent });
    }
    if (row.announcements.length > 0) {
      const related = access.parent.kind === "chat" ? access.parent.channel : access.parent.kind === "task" ? access.parent.access.channel : null;
      for (const channel of await announceTargets(ctx, viewer, related)) {
        view.announceTargets.push({ ...(await chatSummary(ctx, channel, me)), viaSasa: sasaAnnounces(channel) });
      }
    }

    for (const [index, item] of row.edits.entries()) {
      const assignment = await ctx.db.get("assignments", item.assignmentId);
      const taskView = assignment ? await taskAccess(ctx, viewer, assignment) : null;
      if (!assignment || !taskView?.view) continue;
      const suggestion = item.suggestionId ? await ctx.db.get("aiSuggestions", item.suggestionId) : null;
      view.edits.push({
        index,
        assignment: { _id: assignment._id, title: assignment.title, kind: assignment.kind },
        fields: item.fields,
        assignees: (item.fields.assigneeIds ?? []).flatMap((id) => person(id) ?? []),
        canApply: taskView.review && assignment.status === "open" && suggestion?.status !== "applied",
        applied: suggestion?.status === "applied",
      });
    }
    return view;
  },
});

/** Anyone who can read the document can (re)generate its summary for AI_DOC_COST.summary credits. */
export const summarize = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const access = await documentAccessFor(ctx, viewer, args.documentId);
    const row = await summaryRow(ctx, access.doc._id);
    const pending = row?.pendingRequestId ? await ctx.db.get("aiRequests", row.pendingRequestId) : null;
    if (pending?.status === "pending" && Date.now() - pending._creationTime < LIMITS.aiStaleRequestMs) {
      throw appError("AI_BUSY");
    }
    const { weekKey } = await requireCredits(ctx, viewer, AI_DOC_COST.summary);
    return startDocSummary(ctx, {
      userId: viewer.user._id,
      documentId: access.doc._id,
      weekKey,
      cost: AI_DOC_COST.summary,
    });
  },
});

export const summaryJob = internalQuery({
  args: { requestId: v.id("aiRequests") },
  handler: async (ctx, args): Promise<ChatMessage[] | null> => {
    const job = await pendingDocRequest(ctx, args.requestId);
    if (!job?.access) return null;
    const scope = await summaryScope(ctx, job.access);
    const names = new Names(ctx);
    const members = await Promise.all(scope.memberIds.slice(0, 200).map(async (id) => `${id}: ${await names.of(id)}`));
    const tasks = scope.tasks.map((task) => {
      const details = [
        task.dueAt ? `due ${pacificStamp(task.dueAt)}` : "",
        task.startAt ? `starts ${pacificStamp(task.startAt)}` : "",
        task.location ? `at ${task.location}` : "",
      ].filter(Boolean);
      return `${task._id} | ${task.kind} | ${task.title} | ${details.join(", ")}`;
    });
    const text = await documentText(ctx, job.access.doc);
    return docSummaryPrompt({
      now: nowLabel(),
      title: job.access.doc.title,
      where: scope.where,
      members: members.join("\n"),
      tasks: tasks.join("\n"),
      text: text.slice(0, LIMITS.aiDocContextChars),
    });
  },
});

/** Validates the model's report and stores it as the document's summary. */
export const finishSummary = internalMutation({
  args: { requestId: v.id("aiRequests"), result: v.any(), model: v.string() },
  handler: async (ctx, args) => {
    const job = await pendingDocRequest(ctx, args.requestId);
    if (!job) return;
    const { request, access } = job;
    const row = access ? await summaryRow(ctx, access.doc._id) : null;
    const result = (args.result ?? null) as Record<string, unknown> | null;
    if (!access || !row || row.pendingRequestId !== request._id || !result) {
      await failDocRequest(ctx, request, !result ? "unreadable reply" : "no access");
      return;
    }
    const scope = await summaryScope(ctx, access);
    const members = new Set<string>(scope.memberIds);
    const openTaskMap = new Map(scope.tasks.map((t) => [t._id as string, t]));
    const now = Date.now();
    const ids = (value: unknown) =>
      Array.isArray(value)
        ? [
            ...new Set(
              value.flatMap((raw) => {
                const id = typeof raw === "string" ? ctx.db.normalizeId("users", raw) : null;
                return id && members.has(id) ? [id] : [];
              }),
            ),
          ].slice(0, LIMITS.taskAssignees)
        : [];
    const list = (value: unknown) =>
      (Array.isArray(value) ? value : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");

    const tasks: Doc<"aiDocSummaries">["tasks"] = [];
    for (const item of list(result.tasks).slice(0, LIMITS.aiDocTasks)) {
      const title = cleanString(item.title, LIMITS.taskTitle);
      if (!title) continue;
      const startAt = parseWhen(item.startAt, now, false);
      const isEvent = item.kind === "event" && startAt !== undefined;
      let endAt = isEvent ? parseWhen(item.endAt, now, false) : undefined;
      if (startAt && endAt && endAt <= startAt) endAt = undefined;
      // Keep the link to a draft made from the same item before regenerating.
      const earlier = row.tasks.find((t) => t.title === title && t.assignmentId);
      tasks.push({
        kind: isEvent ? "event" : "task",
        title,
        description: cleanString(item.description, 1000),
        assigneeIds: ids(item.assigneeIds),
        dueAt: isEvent ? undefined : parseWhen(item.dueAt, now, true),
        startAt: isEvent ? startAt : undefined,
        endAt,
        location: isEvent ? cleanString(item.location, LIMITS.taskLocation) : undefined,
        assignmentId: earlier?.assignmentId,
      });
    }

    const announcements: Doc<"aiDocSummaries">["announcements"] = [];
    for (const item of list(result.announcements).slice(0, LIMITS.aiDocAnnouncements)) {
      const body = cleanString(item.body, LIMITS.messageBody);
      if (!body) continue;
      announcements.push({ body, sent: row.announcements.find((a) => a.body === body)?.sent ?? [] });
    }

    const edits: Doc<"aiDocSummaries">["edits"] = [];
    for (const item of list(result.edits).slice(0, LIMITS.aiDocEdits)) {
      const assignment = typeof item.assignmentId === "string" ? openTaskMap.get(item.assignmentId) : undefined;
      if (!assignment) continue;
      const fields: Doc<"aiDocSummaries">["edits"][number]["fields"] = {
        title: cleanString(item.title, LIMITS.taskTitle),
        description: cleanString(item.description, 1000),
        assigneeIds: Array.isArray(item.assigneeIds) ? ids(item.assigneeIds) : undefined,
        dueAt: parseWhen(item.dueAt, now, true),
        startAt: parseWhen(item.startAt, now, false),
        endAt: parseWhen(item.endAt, now, false),
        location: cleanString(item.location, LIMITS.taskLocation),
      };
      if (fields.title === assignment.title) fields.title = undefined;
      if (fields.description === assignment.description) fields.description = undefined;
      if (fields.location === assignment.location) fields.location = undefined;
      if (fields.dueAt === assignment.dueAt) fields.dueAt = undefined;
      if (fields.startAt === assignment.startAt) fields.startAt = undefined;
      if (fields.endAt === assignment.endAt) fields.endAt = undefined;
      if (fields.assigneeIds?.length === 0) fields.assigneeIds = undefined;
      if (Object.values(fields).every((value) => value === undefined)) continue;
      edits.push({ assignmentId: assignment._id, fields });
    }

    const text = cleanString(result.summary, LIMITS.aiDocSummaryChars);
    if (!text) {
      await failDocRequest(ctx, request, "empty summary");
      return;
    }
    await ctx.db.patch("aiRequests", request._id, { status: "done", model: args.model });
    await ctx.db.patch("aiDocSummaries", row._id, {
      requestedBy: request.userId,
      pendingRequestId: undefined,
      generatedAt: now,
      docUpdatedAt: access.doc.updatedAt,
      summary: text,
      tasks,
      announcements,
      edits,
      error: undefined,
    });
  },
});

async function requireSummary(ctx: QueryCtx, viewer: ViewerContext, documentId: Id<"documents">) {
  const access = await documentAccessFor(ctx, viewer, documentId);
  const row = await summaryRow(ctx, access.doc._id);
  if (!row?.generatedAt) throw appError("NOT_FOUND");
  return { access, row };
}

/** Creates drafts from the summary's tasks; the creator reviews and publishes them (assignees hear nothing until then). */
export const createTaskDrafts = mutation({
  args: {
    documentId: v.id("documents"),
    indexes: v.array(v.number()),
    /** Required for Files documents; other documents use their own chat. */
    channelId: v.optional(v.id("channels")),
  },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { access, row } = await requireSummary(ctx, viewer, args.documentId);
    const scope = await summaryScope(ctx, access);
    const channel = scope.channel ?? (args.channelId ? await ctx.db.get("channels", args.channelId) : null);
    if (!channel) throw appError("INVALID", "channelId");
    if (!(await canCreateTaskIn(ctx, viewer, channel))) throw appError("FORBIDDEN");

    const tasks = [...row.tasks];
    const created: Id<"assignments">[] = [];
    for (const index of [...new Set(args.indexes)]) {
      const item = tasks[index];
      if (!item || item.assignmentId) continue;
      const assignmentId = await createDraftFromDocument(ctx, viewer, channel, { ...item, eventId: scope.eventId });
      tasks[index] = { ...item, assignmentId };
      created.push(assignmentId);
    }
    if (created.length > 0) await ctx.db.patch("aiDocSummaries", row._id, { tasks });
    return created;
  },
});

/** Turns a proposed task change into a suggestion the reviewer opens in the task form. */
export const editSuggestion = mutation({
  args: { documentId: v.id("documents"), index: v.number() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { access, row } = await requireSummary(ctx, viewer, args.documentId);
    const item = row.edits[args.index];
    if (!item) throw appError("NOT_FOUND");
    const assignment = await ctx.db.get("assignments", item.assignmentId);
    if (!assignment || assignment.status !== "open") throw appError("INVALID", "status");
    if (!(await taskAccess(ctx, viewer, assignment))?.review) throw appError("FORBIDDEN");
    const existing = item.suggestionId ? await ctx.db.get("aiSuggestions", item.suggestionId) : null;
    if (existing?.status === "pending") return { suggestionId: existing._id, assignmentId: assignment._id };
    const suggestionId = await ctx.db.insert("aiSuggestions", {
      channelId: assignment.channelId,
      documentId: access.doc._id,
      action: "edit",
      assignmentId: assignment._id,
      fields: item.fields,
      status: "pending",
    });
    const edits = [...row.edits];
    edits[args.index] = { ...item, suggestionId };
    await ctx.db.patch("aiDocSummaries", row._id, { edits });
    return { suggestionId, assignmentId: assignment._id };
  },
});

/**
 * Sends an announcement the summary found (as edited by the member). In chats with AI mode on 小飒
 * posts it on the member's behalf; elsewhere it's the member's own announcement.
 */
export const sendAnnouncement = mutation({
  args: { documentId: v.id("documents"), index: v.number(), channelId: v.id("channels"), body: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { row } = await requireSummary(ctx, viewer, args.documentId);
    const item = row.announcements[args.index];
    if (!item) throw appError("NOT_FOUND");
    const { channel, access } = await requireChannelAccess(ctx, viewer, args.channelId);
    if (!canAnnounceIn(channel, access)) throw appError("FORBIDDEN");
    const body = args.body.trim();
    if (!body || body.length > LIMITS.messageBody) throw appError("INVALID", "body");

    const now = Date.now();
    const viaSasa = sasaAnnounces(channel);
    const messageId = viaSasa
      ? await ctx.db.insert("messages", {
          channelId: channel._id,
          authorId: await ensureSasa(ctx),
          body,
          kind: "ai",
          aiReadable: true,
          announcement: true,
          ai: { status: "done", actorId: viewer.user._id },
          searchText: toSearchText(body),
        })
      : await ctx.db.insert("messages", {
          channelId: channel._id,
          authorId: viewer.user._id,
          body,
          kind: "user",
          aiReadable: aiReadableChannel(channel) || undefined,
          announcement: true,
          searchText: toSearchText(body),
        });
    await ctx.db.patch("channels", channel._id, { lastMessageAt: now });
    await touchReadState(ctx, channel._id, viewer.user._id, now);
    const audience = (await channelAudience(ctx, channel)).filter((id) => id !== viewer.user._id);
    await notifyMany(ctx, audience, {
      type: "announcement",
      params: { actorId: viewer.user._id, channelId: channel._id, preview: previewText(body, new Map()) },
      link: chatLink(channel._id, messageId),
      messageId,
    });

    const announcements = [...row.announcements];
    announcements[args.index] = {
      ...item,
      sent: [...item.sent, { channelId: channel._id, messageId, by: viewer.user._id, at: now }],
    };
    await ctx.db.patch("aiDocSummaries", row._id, { announcements });
    return messageId;
  },
});

// ---------------------------------------------------------------------------------------------
// Writing with a prompt

/** Editors ask 小飒 to write; the result streams into a private draft they apply in the editor. */
export const write = mutation({
  args: { documentId: v.id("documents"), prompt: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const access = await documentAccessFor(ctx, viewer, args.documentId);
    if (!access.canEdit) throw appError("FORBIDDEN");
    const prompt = args.prompt.trim();
    if (!prompt || prompt.length > LIMITS.aiDocPrompt) throw appError("INVALID", "prompt");
    const { weekKey } = await requireCredits(ctx, viewer, AI_DOC_COST.write);
    return startDocWrite(ctx, {
      userId: viewer.user._id,
      documentId: access.doc._id,
      prompt,
      weekKey,
      cost: AI_DOC_COST.write,
      source: "doc_write",
    });
  },
});

export type DocDraftView = {
  _id: Id<"aiDocDrafts">;
  requestId: Id<"aiRequests">;
  prompt: string;
  status: Doc<"aiDocDrafts">["status"];
  text: string;
  reason?: string;
  appealDenied: boolean;
  appeal: "none" | "pending" | "approved" | "denied";
  canAppeal: boolean;
};

/** The viewer's latest open writing draft for this document. */
export const myDraft = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args): Promise<DocDraftView | null> => {
    const viewer = await requireApproved(ctx);
    const rows = await ctx.db
      .query("aiDocDrafts")
      .withIndex("by_document_user", (q) => q.eq("documentId", args.documentId).eq("userId", viewer.user._id))
      .collect();
    const draft = rows.filter((r) => r.status !== "closed").at(-1);
    if (!draft) return null;
    const appeal = await ctx.db
      .query("aiAppeals")
      .withIndex("by_request", (q) => q.eq("requestId", draft.requestId))
      .first();
    return {
      _id: draft._id,
      requestId: draft.requestId,
      prompt: draft.prompt,
      status: draft.status,
      text: draft.text,
      reason: draft.reason,
      appealDenied: draft.appealDenied === true,
      appeal: appeal?.status ?? "none",
      canAppeal:
        draft.status === "refused" && !appeal && Date.now() - draft._creationTime <= LIMITS.aiAppealWindowMs,
    };
  },
});

/** Hides the draft once applied or discarded (it stays appealable until cleanup). */
export const closeDraft = mutation({
  args: { draftId: v.id("aiDocDrafts") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const draft = await ctx.db.get("aiDocDrafts", args.draftId);
    if (!draft || draft.userId !== viewer.user._id) throw appError("NOT_FOUND");
    if (draft.status === "closed") return;
    if (draft.status === "thinking" || draft.status === "streaming") throw appError("INVALID", "status");
    await ctx.db.patch("aiDocDrafts", draft._id, { status: "closed" });
  },
});

async function draftOf(ctx: QueryCtx, requestId: Id<"aiRequests">) {
  return ctx.db
    .query("aiDocDrafts")
    .withIndex("by_request", (q) => q.eq("requestId", requestId))
    .unique();
}

export const writeJob = internalQuery({
  args: { requestId: v.id("aiRequests") },
  handler: async (ctx, args) => {
    const job = await pendingDocRequest(ctx, args.requestId);
    if (!job) return null;
    const draft = await draftOf(ctx, args.requestId);
    if (!job.access?.canEdit || !draft || draft.status === "closed") return { gone: true as const };
    return {
      gone: false as const,
      skipFilter: job.request.skipFilter === true,
      filter: filterPrompt(draft.prompt, "document", {
        extra: `Document title: "${job.access.doc.title}"`,
        memory: await filterMemory(ctx),
      }),
    };
  },
});

export const writeContext = internalQuery({
  args: { requestId: v.id("aiRequests") },
  handler: async (ctx, args): Promise<ChatMessage[] | null> => {
    const job = await pendingDocRequest(ctx, args.requestId);
    const draft = await draftOf(ctx, args.requestId);
    if (!job?.access?.canEdit || !draft) return null;
    const text = await documentText(ctx, job.access.doc);
    return docWritePrompt({
      now: nowLabel(),
      title: job.access.doc.title,
      asker: personLabel(job.access.viewer.user),
      prompt: draft.prompt,
      text: text.slice(0, LIMITS.aiDocContextChars),
    });
  },
});

export const streamDraft = internalMutation({
  args: { requestId: v.id("aiRequests"), text: v.string() },
  handler: async (ctx, args) => {
    const request = await ctx.db.get("aiRequests", args.requestId);
    const draft = await draftOf(ctx, args.requestId);
    if (request?.status !== "pending" || !draft) return;
    if (draft.status !== "thinking" && draft.status !== "streaming") return;
    await ctx.db.patch("aiDocDrafts", draft._id, { status: "streaming", text: args.text.slice(0, LIMITS.aiDocDraftChars) });
  },
});

export const finishDraft = internalMutation({
  args: { requestId: v.id("aiRequests"), text: v.string(), model: v.string() },
  handler: async (ctx, args) => {
    const request = await ctx.db.get("aiRequests", args.requestId);
    if (request?.status !== "pending") return;
    const draft = await draftOf(ctx, args.requestId);
    const text = args.text.trim().slice(0, LIMITS.aiDocDraftChars);
    if (!draft || !text) {
      await failDocRequest(ctx, request, "empty answer");
      return;
    }
    await ctx.db.patch("aiRequests", request._id, { status: "done", model: args.model });
    if (draft.status !== "closed") await ctx.db.patch("aiDocDrafts", draft._id, { status: "done", text });
  },
});

// ---------------------------------------------------------------------------------------------
// Documents a chat question can attach

export type DocChoice = {
  _id: Id<"documents">;
  title: string;
  where: "chat" | "task" | "file";
  updatedAt: number;
};

/**
 * Documents the viewer may attach to a question for 小飒 in this chat: in their private 小飒 chat any
 * document they can open; elsewhere only ones everyone in the chat can open (`docSharedIn`).
 */
export const documentChoices = query({
  args: { channelId: v.id("channels"), search: v.optional(v.string()) },
  handler: async (ctx, args): Promise<DocChoice[]> => {
    const viewer = await requireApproved(ctx);
    const { channel, access } = await requireChannelAccess(ctx, viewer, args.channelId);
    if (access.via !== "member" || !aiReadableChannel(channel)) return [];
    const search = (args.search ?? "").trim().toLowerCase();
    const candidates = new Map<Id<"documents">, Doc<"documents">>();
    if (channel.type !== "assistant") {
      const own = await ctx.db
        .query("documents")
        .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
        .collect();
      for (const doc of own) candidates.set(doc._id, doc);
    }
    for (const doc of await ctx.db.query("documents").withIndex("by_updatedAt").order("desc").take(300)) {
      candidates.set(doc._id, doc);
    }
    const choices: DocChoice[] = [];
    for (const doc of [...candidates.values()].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (choices.length >= LIMITS.aiDocChoices) break;
      if (search && !doc.title.toLowerCase().includes(search)) continue;
      if (!(await tryDocumentAccess(ctx, viewer, doc._id))) continue;
      if (channel.type !== "assistant" && !(await docSharedIn(ctx, doc, channel))) continue;
      choices.push({
        _id: doc._id,
        title: doc.title,
        where: doc.channelId ? "chat" : doc.assignmentId ? "task" : "file",
        updatedAt: doc.updatedAt,
      });
    }
    return choices;
  },
});
