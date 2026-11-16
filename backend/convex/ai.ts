import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { logAudit } from "./lib/audit";
import { channelAccess, channelAudience, requireChannelAccess } from "./lib/channels";
import type { ChatMessage } from "./lib/ai/client";
import {
  channelLabel,
  chatLog,
  meetingList,
  Names,
  nowLabel,
  pacificStamp,
  personLabel,
  privateHistory,
  readableAiChannels,
  roleLabel,
  taskList,
} from "./lib/ai/context";
import { creditState, creditWeek, inFlightRequest } from "./lib/ai/credits";
import { settleDocRequest } from "./lib/ai/docs";
import { startAnswer, startDocWrite } from "./lib/ai/flow";
import { addRule, filterMemory } from "./lib/ai/memory";
import { answerPrompt, filterPrompt, scanPrompt } from "./lib/ai/prompts";
import { aiConfigured, assistantKey, ensureSasa, isAiChannelType } from "./lib/ai/sasa";
import { canActOnSuggestion, parseWhen } from "./lib/ai/suggestions";
import { AI_IRRELEVANT_COST, LIMITS } from "./lib/constants";
import { canReadDocument, docLink, docSharedIn, documentText, tryDocumentAccess } from "./lib/documents";
import { appError } from "./lib/errors";
import { isLiveUserContent, postSystemMessage } from "./lib/messages";
import { chatLink, notify, notifyMany } from "./lib/notify";
import { buildViewerContext, requireApproved, requireSystemAdmin, type ViewerContext } from "./lib/permissions";
import { mentionToken, toSearchText } from "./lib/text";
import { getUserSummaries, type UserSummary } from "./lib/users";

const DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN_LINK = "/admin/ai/";

async function viewerOf(ctx: QueryCtx, userId: Id<"users">): Promise<ViewerContext | null> {
  const user = await ctx.db.get("users", userId);
  return user && user.status === "approved" ? buildViewerContext(ctx, user) : null;
}

// ---------------------------------------------------------------------------------------------
// Credits and AI mode

export type CreditsView = {
  configured: boolean;
  unlimited: boolean;
  allowance: number;
  used: number;
  /** 0 when unlimited. */
  balance: number;
  nextResetAt: number;
  /** A question of the viewer's is still being answered. */
  inFlight: boolean;
};

export const myCredits = query({
  args: {},
  handler: async (ctx): Promise<CreditsView> => {
    const viewer = await requireApproved(ctx);
    const now = Date.now();
    const state = await creditState(ctx, viewer, now);
    return {
      configured: aiConfigured(),
      unlimited: state.unlimited,
      allowance: state.allowance,
      used: Math.max(0, state.used - state.refunded),
      balance: state.unlimited ? 0 : state.balance,
      nextResetAt: state.nextResetAt,
      inFlight: (await inFlightRequest(ctx, viewer.user._id, now)) !== null,
    };
  },
});

/** 主席团 and system admins switch AI mode in org, department and group chats they take part in. */
export const setAiMode = mutation({
  args: { channelId: v.id("channels"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel, access } = await requireChannelAccess(ctx, viewer, args.channelId);
    if (!viewer.isAdmin || access.via !== "member" || !isAiChannelType(channel.type)) throw appError("FORBIDDEN");
    if (access.readOnly) throw appError("READ_ONLY");
    if (args.enabled && !aiConfigured()) throw appError("AI_NOT_CONFIGURED");
    if ((channel.aiEnabled === true) === args.enabled) return;
    if (args.enabled) await ensureSasa(ctx);
    await ctx.db.patch("channels", channel._id, {
      aiEnabled: args.enabled || undefined,
      aiEnabledAt: args.enabled ? Date.now() : undefined,
      aiEnabledBy: args.enabled ? viewer.user._id : undefined,
    });
    await postSystemMessage(ctx, {
      channelId: channel._id,
      actorId: viewer.user._id,
      event: args.enabled ? "ai_enabled" : "ai_disabled",
      params: { actorId: viewer.user._id },
    });
    await logAudit(ctx, {
      actorId: viewer.user._id,
      action: "channel.ai_mode",
      targetType: "channel",
      targetId: channel._id,
      metadata: { enabled: args.enabled, type: channel.type },
    });
  },
});

/** The viewer's private 小飒 chat, created on first open. */
export const ensureAssistantChannel = mutation({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireApproved(ctx);
    const dmKey = assistantKey(viewer.user._id);
    const existing = await ctx.db
      .query("channels")
      .withIndex("by_dmKey", (q) => q.eq("dmKey", dmKey))
      .unique();
    if (existing) return existing._id;
    if (!aiConfigured()) throw appError("AI_NOT_CONFIGURED");
    const sasaId = await ensureSasa(ctx);
    const now = Date.now();
    const channelId = await ctx.db.insert("channels", {
      type: "assistant",
      dmKey,
      createdBy: viewer.user._id,
      lastMessageAt: now,
    });
    await ctx.db.insert("channelMembers", { channelId, userId: viewer.user._id, lastReadAt: now, joinedAt: now });
    await ctx.db.insert("messages", {
      channelId,
      authorId: sasaId,
      body: "",
      kind: "ai",
      ai: { status: "done", notice: "welcome" },
    });
    return channelId;
  },
});

// ---------------------------------------------------------------------------------------------
// Answering (steps called by aiActions.answer)

async function pendingRequest(ctx: QueryCtx, requestId: Id<"aiRequests">) {
  const request = await ctx.db.get("aiRequests", requestId);
  if (!request || request.status !== "pending") return null;
  const reply = request.replyMessageId ? await ctx.db.get("messages", request.replyMessageId) : null;
  return { request, reply };
}

export const answerJob = internalQuery({
  args: { requestId: v.id("aiRequests") },
  handler: async (ctx, args) => {
    const job = await pendingRequest(ctx, args.requestId);
    if (!job) return null;
    const { channelId, questionMessageId } = job.request;
    const question = questionMessageId ? await ctx.db.get("messages", questionMessageId) : null;
    const channel = channelId ? await ctx.db.get("channels", channelId) : null;
    if (!question || !isLiveUserContent(question) || !channel || !job.reply) return { gone: true as const };
    const names = new Names(ctx);
    const titles: string[] = [];
    for (const id of question.aiDocumentIds ?? []) {
      const doc = await ctx.db.get("documents", id);
      if (doc) titles.push(`"${doc.title}"`);
    }
    return {
      gone: false as const,
      skipFilter: job.request.skipFilter === true,
      filter: filterPrompt(await names.text(question.body), channel.type === "assistant" ? "private" : "chat", {
        extra: titles.length > 0 ? `Attached CSSA documents: ${titles.join(", ")}` : undefined,
        memory: await filterMemory(ctx),
      }),
    };
  },
});

/** The full prompt, built from what the asker may see right now. Null when they lost access. */
export const answerContext = internalQuery({
  args: { requestId: v.id("aiRequests"), keywords: v.array(v.string()) },
  handler: async (ctx, args): Promise<ChatMessage[] | null> => {
    const job = await pendingRequest(ctx, args.requestId);
    if (!job) return null;
    const { request } = job;
    const viewer = await viewerOf(ctx, request.userId);
    const channel = request.channelId ? await ctx.db.get("channels", request.channelId) : null;
    const question = request.questionMessageId ? await ctx.db.get("messages", request.questionMessageId) : null;
    if (!viewer || !channel || !question || !isLiveUserContent(question)) return null;
    if ((await channelAccess(ctx, viewer, channel)).via !== "member") return null;

    const names = new Names(ctx);
    const keywords = args.keywords.slice(0, 6);
    const exclude = new Set<Id<"messages">>([question._id]);
    if (request.replyMessageId) exclude.add(request.replyMessageId);
    const sections: string[] = [];
    let history: ChatMessage[] = [];
    let chatName: string | undefined;
    const isPrivate = channel.type === "assistant";

    const documents = await questionDocuments(ctx, viewer, channel, question.aiDocumentIds ?? []);
    const perDocument = Math.floor(LIMITS.aiDocContextChars / Math.max(1, documents.length));
    for (const doc of documents) {
      const text = (await documentText(ctx, doc)).slice(0, perDocument);
      sections.push(`<document title="${doc.title.replace(/"/g, "'")}">\n${text || "(empty)"}\n</document>`);
    }

    if (isPrivate) {
      const channels = await readableAiChannels(ctx, viewer);
      const tasks = await taskList(ctx, names, viewer, channels, true);
      const meetings = await meetingList(ctx, channels);
      if (tasks) sections.push(`<tasks_and_events>\n${tasks}\n</tasks_and_events>`);
      if (meetings) sections.push(`<meetings>\n${meetings}\n</meetings>`);
      const used = sections.join("\n").length;
      const budget = Math.max(2000, Math.floor((LIMITS.aiContextChars - used) / Math.max(1, channels.length)));
      for (const aiChannel of channels) {
        const log = await chatLog(ctx, names, aiChannel, { keywords, exclude, budget });
        if (log) sections.push(`<chat_log chat="${await channelLabel(ctx, aiChannel)}">\n${log}\n</chat_log>`);
      }
      if (channels.length === 0) sections.push("(The asker takes part in no chats with AI mode on.)");
      history = await privateHistory(ctx, names, channel._id, question._creationTime);
    } else {
      chatName = await channelLabel(ctx, channel);
      const tasks = await taskList(ctx, names, viewer, [channel], false);
      const meetings = await meetingList(ctx, [channel]);
      if (tasks) sections.push(`<tasks_and_events>\n${tasks}\n</tasks_and_events>`);
      if (meetings) sections.push(`<meetings>\n${meetings}\n</meetings>`);
      const budget = LIMITS.aiContextChars - sections.join("\n").length;
      const log = await chatLog(ctx, names, channel, { keywords, exclude, budget });
      sections.push(`<chat_log chat="${chatName}">\n${log || "(no messages since AI mode was turned on)"}\n</chat_log>`);
    }

    return answerPrompt({
      now: nowLabel(),
      asker: personLabel(viewer.user),
      role: roleLabel(viewer),
      where: isPrivate ? "private" : "chat",
      chatName,
      context: sections.join("\n\n"),
      history,
      question: await names.text(question.body),
      documents: documents.length > 0,
    });
  },
});

/**
 * Documents attached to a question that the asker can still open; in shared chats also only those
 * everyone there can open (`docSharedIn`), so an answer never reveals a document to the wrong people.
 */
async function questionDocuments(
  ctx: QueryCtx,
  viewer: ViewerContext,
  channel: Doc<"channels">,
  ids: Id<"documents">[],
): Promise<Doc<"documents">[]> {
  const docs: Doc<"documents">[] = [];
  for (const id of ids.slice(0, LIMITS.aiDocsPerQuestion)) {
    const doc = await ctx.db.get("documents", id);
    if (!doc || !(await canReadDocument(ctx, viewer, doc._id))) continue;
    if (channel.type !== "assistant" && !(await docSharedIn(ctx, doc, channel))) continue;
    docs.push(doc);
  }
  return docs;
}

export const streamText = internalMutation({
  args: { requestId: v.id("aiRequests"), text: v.string() },
  handler: async (ctx, args) => {
    const job = await pendingRequest(ctx, args.requestId);
    if (!job?.reply?.ai || (job.reply.ai.status !== "thinking" && job.reply.ai.status !== "streaming")) return;
    await ctx.db.patch("messages", job.reply._id, {
      body: args.text.slice(0, LIMITS.messageBody),
      ai: { ...job.reply.ai, status: "streaming" },
    });
  },
});

export const finish = internalMutation({
  args: { requestId: v.id("aiRequests"), text: v.string(), model: v.string() },
  handler: async (ctx, args) => {
    const job = await pendingRequest(ctx, args.requestId);
    if (!job) return;
    const { request, reply } = job;
    const text = args.text.trim().slice(0, LIMITS.messageBody);
    if (!reply?.ai || !text) {
      await failRequest(ctx, request, reply, "empty answer");
      return;
    }
    await ctx.db.patch("aiRequests", request._id, { status: "done", model: args.model });
    await ctx.db.patch("messages", reply._id, {
      body: text,
      ai: { ...reply.ai, status: "done" },
      searchText: toSearchText(text),
    });
    const channel = request.channelId ? await ctx.db.get("channels", request.channelId) : null;
    if (channel && channel.type !== "assistant") {
      await notify(ctx, request.userId, {
        type: "reply",
        params: { actorId: reply.authorId, channelId: channel._id, preview: text.slice(0, 80) },
        link: chatLink(channel._id, reply._id),
        messageId: reply._id,
      });
    }
  },
});

/** Failed calls cost nothing: the request's cost drops to 0. */
async function failRequest(
  ctx: MutationCtx,
  request: Doc<"aiRequests">,
  reply: Doc<"messages"> | null,
  error: string,
) {
  await ctx.db.patch("aiRequests", request._id, { status: "failed", cost: 0, error: error.slice(0, 500) });
  if (reply?.ai) await ctx.db.patch("messages", reply._id, { body: "", ai: { ...reply.ai, status: "failed" } });
  if (request.documentId) await settleDocRequest(ctx, request, { status: "failed" });
}

export const fail = internalMutation({
  args: { requestId: v.id("aiRequests"), error: v.string() },
  handler: async (ctx, args) => {
    const job = await pendingRequest(ctx, args.requestId);
    if (job) await failRequest(ctx, job.request, job.reply, args.error);
  },
});

/** Off-topic: the question costs AI_IRRELEVANT_COST in total, without going below 0. */
export const refuse = internalMutation({
  args: { requestId: v.id("aiRequests"), reason: v.string() },
  handler: async (ctx, args) => {
    const job = await pendingRequest(ctx, args.requestId);
    if (!job) return;
    const { request, reply } = job;
    let extra = Math.max(0, AI_IRRELEVANT_COST - request.cost);
    const viewer = await viewerOf(ctx, request.userId);
    if (viewer) {
      const state = await creditState(ctx, viewer);
      if (!state.unlimited) extra = Math.min(extra, state.balance);
    }
    await ctx.db.patch("aiRequests", request._id, { status: "refused", cost: request.cost + extra });
    const reason = args.reason.trim().slice(0, 300);
    if (reply?.ai) {
      await ctx.db.patch("messages", reply._id, { body: reason, ai: { ...reply.ai, status: "refused" } });
    }
    if (request.documentId) await settleDocRequest(ctx, request, { status: "refused", reason });
  },
});

/** Requests whose action died without reporting back (deploys, crashes). Every 10 minutes. */
export const sweepStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const weeks = [creditWeek(now).key, creditWeek(now - 7 * DAY_MS).key];
    for (const weekKey of weeks) {
      const rows = await ctx.db
        .query("aiRequests")
        .withIndex("by_week", (q) => q.eq("weekKey", weekKey))
        .collect();
      for (const request of rows) {
        if (request.status !== "pending" || now - request._creationTime < LIMITS.aiStaleRequestMs) continue;
        const reply = request.replyMessageId ? await ctx.db.get("messages", request.replyMessageId) : null;
        await failRequest(ctx, request, reply, "timed out");
      }
    }
  },
});

/** Ledger rows older than LIMITS.aiLedgerDays, plus settled appeals and suggestions. Daily. */
export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - LIMITS.aiLedgerDays * DAY_MS;
    const old = <T extends { _creationTime: number }>(rows: T[]) => rows.filter((r) => r._creationTime < cutoff);
    for (const row of old(await ctx.db.query("aiRequests").order("asc").take(LIMITS.purgeBatch))) {
      if (row.status !== "pending") await ctx.db.delete("aiRequests", row._id);
    }
    for (const row of old(await ctx.db.query("aiCreditAdjustments").order("asc").take(LIMITS.purgeBatch))) {
      await ctx.db.delete("aiCreditAdjustments", row._id);
    }
    for (const row of old(await ctx.db.query("aiAppeals").order("asc").take(LIMITS.purgeBatch))) {
      if (row.status !== "pending") await ctx.db.delete("aiAppeals", row._id);
    }
    for (const row of old(await ctx.db.query("aiSuggestions").order("asc").take(LIMITS.purgeBatch))) {
      await ctx.db.delete("aiSuggestions", row._id);
    }
    // Writing drafts are private previews; they outlive the appeal window and no longer.
    const draftCutoff = Date.now() - LIMITS.aiAppealWindowMs;
    for (const row of await ctx.db.query("aiDocDrafts").order("asc").take(LIMITS.purgeBatch)) {
      if (row._creationTime < draftCutoff) await ctx.db.delete("aiDocDrafts", row._id);
    }
  },
});

// ---------------------------------------------------------------------------------------------
// Appeals

/** The asker disputes an off-topic refusal, once, within LIMITS.aiAppealWindowMs. */
export const appeal = mutation({
  args: { requestId: v.id("aiRequests"), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const request = await ctx.db.get("aiRequests", args.requestId);
    if (!request || request.userId !== viewer.user._id) throw appError("NOT_FOUND");
    if (request.status !== "refused") throw appError("INVALID", "status");
    if (Date.now() - request._creationTime > LIMITS.aiAppealWindowMs) throw appError("INVALID", "expired");
    const existing = await ctx.db
      .query("aiAppeals")
      .withIndex("by_request", (q) => q.eq("requestId", request._id))
      .first();
    if (existing) throw appError("INVALID", "appealed");
    const note = (args.note ?? "").trim();
    if (note.length > LIMITS.aiAppealNote) throw appError("INVALID", "note");

    let questionText = "";
    let reason = "";
    if (request.documentId) {
      const draft = await ctx.db
        .query("aiDocDrafts")
        .withIndex("by_request", (q) => q.eq("requestId", request._id))
        .unique();
      questionText = draft?.prompt ?? "";
      reason = draft?.reason ?? "";
    } else {
      const question = request.questionMessageId ? await ctx.db.get("messages", request.questionMessageId) : null;
      const reply = request.replyMessageId ? await ctx.db.get("messages", request.replyMessageId) : null;
      questionText = question && isLiveUserContent(question) ? await new Names(ctx).text(question.body) : "";
      reason = reply?.body ?? "";
    }
    const appealId = await ctx.db.insert("aiAppeals", {
      requestId: request._id,
      userId: viewer.user._id,
      channelId: request.channelId,
      documentId: request.documentId,
      question: questionText,
      reason,
      note: note || undefined,
      status: "pending",
    });
    const admins = await ctx.db
      .query("users")
      .withIndex("by_isSystemAdmin", (q) => q.eq("isSystemAdmin", true))
      .collect();
    await notifyMany(
      ctx,
      admins.filter((a) => a.status === "approved").map((a) => a._id),
      { type: "ai_appeal", params: { actorId: viewer.user._id, preview: questionText.slice(0, 80) }, link: ADMIN_LINK },
    );
    return appealId;
  },
});

export type AppealView = {
  _id: Id<"aiAppeals">;
  _creationTime: number;
  user: UserSummary | null;
  chat: { _id: Id<"channels">; label: string; private: boolean } | null;
  /** Writing prompts are appealed from a document. */
  document: { _id: Id<"documents">; title: string } | null;
  question: string;
  reason: string;
  note?: string;
  status: Doc<"aiAppeals">["status"];
  reviewer: UserSummary | null;
  reviewedAt?: number;
  reviewNote?: string;
};

export const listAppeals = query({
  args: { status: v.union(v.literal("pending"), v.literal("approved"), v.literal("denied")) },
  handler: async (ctx, args): Promise<AppealView[]> => {
    await requireSystemAdmin(ctx);
    const rows = await ctx.db
      .query("aiAppeals")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .order("desc")
      .take(100);
    const people = await getUserSummaries(
      ctx,
      rows.flatMap((r) => (r.reviewedBy ? [r.userId, r.reviewedBy] : [r.userId])),
    );
    const views: AppealView[] = [];
    for (const row of rows) {
      const channel = row.channelId ? await ctx.db.get("channels", row.channelId) : null;
      const doc = row.documentId ? await ctx.db.get("documents", row.documentId) : null;
      views.push({
        _id: row._id,
        _creationTime: row._creationTime,
        user: people.get(row.userId) ?? null,
        chat: channel
          ? { _id: channel._id, label: await channelLabel(ctx, channel), private: channel.type === "assistant" }
          : null,
        document: doc ? { _id: doc._id, title: doc.title } : null,
        question: row.question,
        reason: row.reason,
        note: row.note,
        status: row.status,
        reviewer: row.reviewedBy ? (people.get(row.reviewedBy) ?? null) : null,
        reviewedAt: row.reviewedAt,
        reviewNote: row.reviewNote,
      });
    }
    return views;
  },
});

export const pendingAppealCount = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireApproved(ctx);
    if (!viewer.isSystemAdmin) return 0;
    const rows = await ctx.db
      .query("aiAppeals")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(100);
    return rows.length;
  },
});

/**
 * Approve: the asker gets AI_IRRELEVANT_COST credits back this week and 小飒 answers the question
 * for free, skipping the filter. Deny: 小飒 replies "这不是小飒该处理的事" with the admin's note.
 */
export const reviewAppeal = mutation({
  args: {
    appealId: v.id("aiAppeals"),
    approve: v.boolean(),
    note: v.optional(v.string()),
    /** Teach the filter: a rule saved to `aiFilterMemory` with this decision's verdict. */
    remember: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const viewer = await requireSystemAdmin(ctx);
    const appealRow = await ctx.db.get("aiAppeals", args.appealId);
    if (!appealRow) throw appError("NOT_FOUND");
    if (appealRow.status !== "pending") throw appError("INVALID", "status");
    const note = (args.note ?? "").trim();
    if (note.length > LIMITS.aiAppealNote) throw appError("INVALID", "note");
    if (args.remember !== undefined) {
      await addRule(ctx, viewer.user._id, {
        verdict: args.approve ? "allow" : "refuse",
        text: args.remember,
        appealId: appealRow._id,
      });
    }
    const now = Date.now();
    await ctx.db.patch("aiAppeals", appealRow._id, {
      status: args.approve ? "approved" : "denied",
      reviewedBy: viewer.user._id,
      reviewedAt: now,
      reviewNote: note || undefined,
    });

    const request = await ctx.db.get("aiRequests", appealRow.requestId);
    const asker = await viewerOf(ctx, appealRow.userId);
    const week = creditWeek(now);
    if (args.approve) {
      await ctx.db.insert("aiCreditAdjustments", {
        userId: appealRow.userId,
        weekKey: week.key,
        delta: AI_IRRELEVANT_COST,
        reason: "appeal",
        requestId: appealRow.requestId,
      });
    }

    let link: string | undefined;
    if (appealRow.documentId) {
      // A writing prompt: approval re-runs it into a fresh draft; denial shows the note on the draft.
      const access = asker ? await tryDocumentAccess(ctx, asker, appealRow.documentId) : null;
      const draft = await ctx.db
        .query("aiDocDrafts")
        .withIndex("by_request", (q) => q.eq("requestId", appealRow.requestId))
        .unique();
      if (args.approve && access?.canEdit && draft && aiConfigured()) {
        await startDocWrite(ctx, {
          userId: appealRow.userId,
          documentId: appealRow.documentId,
          prompt: draft.prompt,
          weekKey: week.key,
          cost: 0,
          source: "appeal",
          skipFilter: true,
        });
      } else if (!args.approve && draft) {
        await ctx.db.patch("aiDocDrafts", draft._id, { appealDenied: true, reason: note || draft.reason });
      }
      if (access) link = docLink(appealRow.documentId);
    } else {
      const channel = appealRow.channelId ? await ctx.db.get("channels", appealRow.channelId) : null;
      const question = request?.questionMessageId ? await ctx.db.get("messages", request.questionMessageId) : null;
      const canReach =
        channel !== null && asker !== null && (await channelAccess(ctx, asker, channel)).via === "member";
      const questionLive = question !== null && isLiveUserContent(question);
      if (args.approve) {
        if (canReach && questionLive && channel && question && aiConfigured()) {
          await startAnswer(ctx, {
            userId: appealRow.userId,
            channel,
            questionMessageId: question._id,
            source: "appeal",
            weekKey: week.key,
            cost: 0,
            skipFilter: true,
          });
        }
      } else if (channel && canReach) {
        const sasaId = await ensureSasa(ctx);
        await ctx.db.insert("messages", {
          channelId: channel._id,
          authorId: sasaId,
          body: note,
          kind: "ai",
          replyToId: questionLive ? question._id : undefined,
          ai: { status: "done", notice: "appeal_denied", requestId: appealRow.requestId },
        });
        await ctx.db.patch("channels", channel._id, { lastMessageAt: now });
      }
      if (channel && canReach) link = chatLink(channel._id, questionLive ? question._id : undefined);
    }

    await notify(ctx, appealRow.userId, {
      type: "ai_appeal_reviewed",
      params: { reviewerId: viewer.user._id, approved: args.approve, note: note || undefined },
      link,
    });
    await logAudit(ctx, {
      actorId: viewer.user._id,
      action: "ai.appeal_review",
      targetType: "aiAppeal",
      targetId: appealRow._id,
      subjectUserId: appealRow.userId,
      metadata: { approved: args.approve, remembered: args.remember !== undefined },
    });
  },
});

export type UsageRow = { user: UserSummary; used: number; questions: number; refused: number };

/** This week's usage and the chats with AI mode on, for /admin/ai. */
export const overview = query({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);
    const week = creditWeek(Date.now());
    const rows = await ctx.db
      .query("aiRequests")
      .withIndex("by_week", (q) => q.eq("weekKey", week.key))
      .collect();
    const byUser = new Map<Id<"users">, { used: number; questions: number; refused: number }>();
    for (const row of rows) {
      const entry = byUser.get(row.userId) ?? { used: 0, questions: 0, refused: 0 };
      entry.used += row.cost;
      if (row.source !== "appeal") entry.questions += 1;
      if (row.status === "refused") entry.refused += 1;
      byUser.set(row.userId, entry);
    }
    const people = await getUserSummaries(ctx, [...byUser.keys()]);
    const usage: UsageRow[] = [...byUser.entries()]
      .flatMap(([id, entry]) => {
        const user = people.get(id);
        return user ? [{ user, ...entry }] : [];
      })
      .sort((a, b) => b.questions - a.questions);

    const channels = await ctx.db
      .query("channels")
      .withIndex("by_aiEnabled", (q) => q.eq("aiEnabled", true))
      .collect();
    const enabledBy = await getUserSummaries(ctx, channels.flatMap((c) => (c.aiEnabledBy ? [c.aiEnabledBy] : [])));
    const chats = [];
    for (const channel of channels) {
      if (!isAiChannelType(channel.type)) continue;
      chats.push({
        _id: channel._id,
        label: await channelLabel(ctx, channel),
        enabledAt: channel.aiEnabledAt,
        enabledBy: channel.aiEnabledBy ? (enabledBy.get(channel.aiEnabledBy) ?? null) : null,
      });
    }
    return { weekKey: week.key, nextResetAt: week.end, configured: aiConfigured(), usage, chats };
  },
});

// ---------------------------------------------------------------------------------------------
// Task suggestions

export const scanJob = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args): Promise<ChatMessage[] | null> => {
    const message = await ctx.db.get("messages", args.messageId);
    if (!message || !message.aiReadable || !isLiveUserContent(message) || message.kind !== "user") return null;
    const channel = await ctx.db.get("channels", message.channelId);
    if (!channel || !isAiChannelType(channel.type) || !channel.aiEnabled) return null;
    const existing = await ctx.db
      .query("aiSuggestions")
      .withIndex("by_source", (q) => q.eq("sourceMessageId", message._id))
      .first();
    if (existing) return null;

    const names = new Names(ctx);
    const audience = (await channelAudience(ctx, channel)).slice(0, 200);
    const members = await Promise.all(audience.map(async (id) => `${id}: ${await names.of(id)}`));
    const open = (
      await ctx.db
        .query("assignments")
        .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
        .order("desc")
        .take(80)
    ).filter((a) => a.status === "open");
    const tasks: string[] = [];
    for (const task of open.slice(0, 40)) {
      const details = [
        task.dueAt ? `due ${pacificStamp(task.dueAt)}` : "",
        task.startAt ? `starts ${pacificStamp(task.startAt)}` : "",
        task.location ? `at ${task.location}` : "",
      ].filter(Boolean);
      tasks.push(`${task._id} | ${task.kind} | ${task.title} | ${details.join(", ")}`);
    }
    const before = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", channel._id).lt("_creationTime", message._creationTime))
      .order("desc")
      .take(20);
    const previous: string[] = [];
    for (const row of before.reverse()) {
      if (!row.aiReadable || !isLiveUserContent(row) || row.kind !== "user") continue;
      previous.push(`${await names.of(row.authorId)}: ${(await names.text(row.body)).slice(0, 300)}`);
    }
    return scanPrompt({
      now: nowLabel(),
      chatName: await channelLabel(ctx, channel),
      members: members.join("\n"),
      tasks: tasks.join("\n"),
      previous: previous.slice(-8).join("\n"),
      author: await names.of(message.authorId),
      message: await names.text(message.body),
    });
  },
});

function cleanString(value: unknown, max: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** Validates the model's suggestion and posts 小飒's card mentioning the assignees. */
export const suggest = internalMutation({
  args: { messageId: v.id("messages"), result: v.any() },
  handler: async (ctx, args) => {
    const result = (args.result ?? {}) as Record<string, unknown>;
    const action = result.action;
    if (action !== "create_task" && action !== "create_event" && action !== "edit") return;
    if (typeof result.confidence === "number" && result.confidence < 0.6) return;
    const message = await ctx.db.get("messages", args.messageId);
    if (!message || !isLiveUserContent(message)) return;
    const channel = await ctx.db.get("channels", message.channelId);
    if (!channel || !isAiChannelType(channel.type) || !channel.aiEnabled) return;
    const existing = await ctx.db
      .query("aiSuggestions")
      .withIndex("by_source", (q) => q.eq("sourceMessageId", message._id))
      .first();
    if (existing) return;

    const now = Date.now();
    const audience = new Set<string>(await channelAudience(ctx, channel));
    const assigneeIds = Array.isArray(result.assigneeIds)
      ? [
          ...new Set(
            result.assigneeIds.flatMap((raw) => {
              const id = typeof raw === "string" ? ctx.db.normalizeId("users", raw) : null;
              return id && audience.has(id) ? [id] : [];
            }),
          ),
        ].slice(0, 20)
      : [];
    const fields: Doc<"aiSuggestions">["fields"] = {
      title: cleanString(result.title, LIMITS.taskTitle),
      description: cleanString(result.description, 1000),
      assigneeIds: assigneeIds.length > 0 ? assigneeIds : undefined,
      dueAt: parseWhen(result.dueAt, now, true),
      startAt: parseWhen(result.startAt, now, false),
      endAt: parseWhen(result.endAt, now, false),
      location: cleanString(result.location, LIMITS.taskLocation),
    };
    if (fields.startAt && fields.endAt && fields.endAt <= fields.startAt) fields.endAt = undefined;

    let assignmentId: Id<"assignments"> | undefined;
    if (action === "edit") {
      const id = typeof result.assignmentId === "string" ? ctx.db.normalizeId("assignments", result.assignmentId) : null;
      const assignment = id ? await ctx.db.get("assignments", id) : null;
      if (!assignment || assignment.channelId !== channel._id || assignment.status !== "open") return;
      assignmentId = assignment._id;
      if (fields.title === assignment.title) fields.title = undefined;
      if (fields.description === assignment.description) fields.description = undefined;
      if (fields.location === assignment.location) fields.location = undefined;
      if (fields.dueAt === assignment.dueAt) fields.dueAt = undefined;
      if (fields.startAt === assignment.startAt) fields.startAt = undefined;
      if (fields.endAt === assignment.endAt) fields.endAt = undefined;
      if (Object.values(fields).every((value) => value === undefined)) return;
    } else if (!fields.title) {
      return;
    }

    const sasaId = await ensureSasa(ctx);
    const summary = cleanString(result.summary, 300) ?? "";
    const body = [...assigneeIds.map((id) => mentionToken(id)), summary].join(" ").trim();
    const suggestionId = await ctx.db.insert("aiSuggestions", {
      channelId: channel._id,
      sourceMessageId: message._id,
      action,
      assignmentId,
      fields,
      status: "pending",
    });
    const cardId = await ctx.db.insert("messages", {
      channelId: channel._id,
      authorId: sasaId,
      body,
      kind: "ai",
      replyToId: message._id,
      mentionUserIds: assigneeIds,
      ai: { status: "done", suggestionId },
    });
    await ctx.db.patch("aiSuggestions", suggestionId, { messageId: cardId });
    await ctx.db.patch("channels", channel._id, { lastMessageAt: now });
    for (const userId of assigneeIds) {
      await notify(ctx, userId, {
        type: "mention",
        params: { actorId: sasaId, channelId: channel._id, preview: summary.slice(0, 80) },
        link: chatLink(channel._id, cardId),
        messageId: cardId,
      });
    }
  },
});

export type SuggestionView = {
  _id: Id<"aiSuggestions">;
  channelId: Id<"channels">;
  action: Doc<"aiSuggestions">["action"];
  assignmentId?: Id<"assignments">;
  fields: Doc<"aiSuggestions">["fields"];
  status: Doc<"aiSuggestions">["status"];
  canAct: boolean;
};

/** For prefilling the task form; null when the viewer can't act on it. */
export const getSuggestion = query({
  args: { suggestionId: v.id("aiSuggestions") },
  handler: async (ctx, args): Promise<SuggestionView | null> => {
    const viewer = await requireApproved(ctx);
    const suggestion = await ctx.db.get("aiSuggestions", args.suggestionId);
    if (!suggestion) return null;
    const channel = await ctx.db.get("channels", suggestion.channelId);
    if (!channel) return null;
    const canAct = await canActOnSuggestion(ctx, viewer, suggestion);
    if (suggestion.documentId ? !canAct : (await channelAccess(ctx, viewer, channel)).via !== "member") return null;
    return {
      _id: suggestion._id,
      channelId: suggestion.channelId,
      action: suggestion.action,
      assignmentId: suggestion.assignmentId,
      fields: suggestion.fields,
      status: suggestion.status,
      canAct,
    };
  },
});

export const dismissSuggestion = mutation({
  args: { suggestionId: v.id("aiSuggestions") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const suggestion = await ctx.db.get("aiSuggestions", args.suggestionId);
    if (!suggestion) throw appError("NOT_FOUND");
    if (!(await canActOnSuggestion(ctx, viewer, suggestion))) throw appError("FORBIDDEN");
    await ctx.db.patch("aiSuggestions", suggestion._id, { status: "dismissed", actedBy: viewer.user._id });
  },
});
