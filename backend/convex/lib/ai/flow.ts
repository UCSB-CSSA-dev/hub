import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { LIMITS } from "../constants";
import { appError } from "../errors";
import type { ViewerContext } from "../permissions";
import { creditState, inFlightRequest } from "./credits";
import { worthScanning } from "./prefilter";
import { aiConfigured, aiReadableChannel, ensureSasa, findSasa, mentionsSasa } from "./sasa";

const HOUR_MS = 60 * 60 * 1000;

export type AiQuestion = { weekKey: string };

/**
 * Whether a message about to be sent is a question for 小飒 (anything in the private chat, an @小飒 in
 * an AI chat). Questions need a credit and no other question in flight; this throws before the
 * message is inserted so a refused send leaves nothing behind.
 */
export async function prepareQuestion(
  ctx: MutationCtx,
  viewer: ViewerContext,
  channel: Doc<"channels">,
  body: string,
): Promise<AiQuestion | null> {
  if (channel.type !== "assistant") {
    if (!aiReadableChannel(channel)) return null;
    const sasa = await findSasa(ctx);
    if (!mentionsSasa(body, sasa?._id ?? null)) return null;
  }
  return requireCredits(ctx, viewer, 1);
}

/** 小飒 is set up, nothing of the viewer's is in flight, and they have at least `cost` credits. */
export async function requireCredits(ctx: MutationCtx, viewer: ViewerContext, cost: number): Promise<AiQuestion> {
  if (!aiConfigured()) throw appError("AI_NOT_CONFIGURED");
  const now = Date.now();
  if (await inFlightRequest(ctx, viewer.user._id, now)) throw appError("AI_BUSY");
  const credits = await creditState(ctx, viewer, now);
  if (!credits.unlimited && credits.balance < cost) throw appError("AI_NO_CREDITS");
  return { weekKey: credits.weekKey };
}

/** Records a summary request and marks the document's summary as being generated. */
export async function startDocSummary(
  ctx: MutationCtx,
  args: { userId: Id<"users">; documentId: Id<"documents">; weekKey: string; cost: number },
) {
  const requestId = await ctx.db.insert("aiRequests", {
    userId: args.userId,
    documentId: args.documentId,
    source: "doc_summary",
    status: "pending",
    cost: args.cost,
    weekKey: args.weekKey,
  });
  const existing = await ctx.db
    .query("aiDocSummaries")
    .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
    .unique();
  if (existing) {
    await ctx.db.patch("aiDocSummaries", existing._id, { pendingRequestId: requestId, error: undefined });
  } else {
    await ctx.db.insert("aiDocSummaries", {
      documentId: args.documentId,
      requestedBy: args.userId,
      pendingRequestId: requestId,
      summary: "",
      tasks: [],
      announcements: [],
      edits: [],
    });
  }
  await ctx.scheduler.runAfter(0, internal.aiActions.summarize, { requestId });
  return requestId;
}

/** Records a writing request, replaces the editor's earlier draft for the document, and schedules it. */
export async function startDocWrite(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    documentId: Id<"documents">;
    prompt: string;
    weekKey: string;
    cost: number;
    source: "doc_write" | "appeal";
    skipFilter?: boolean;
  },
) {
  const requestId = await ctx.db.insert("aiRequests", {
    userId: args.userId,
    documentId: args.documentId,
    source: args.source,
    status: "pending",
    cost: args.cost,
    weekKey: args.weekKey,
    skipFilter: args.skipFilter || undefined,
  });
  const earlier = await ctx.db
    .query("aiDocDrafts")
    .withIndex("by_document_user", (q) => q.eq("documentId", args.documentId).eq("userId", args.userId))
    .collect();
  // Closed, not deleted: a refused prompt stays appealable.
  for (const draft of earlier) {
    if (draft.status !== "closed") await ctx.db.patch("aiDocDrafts", draft._id, { status: "closed" });
  }
  await ctx.db.insert("aiDocDrafts", {
    documentId: args.documentId,
    userId: args.userId,
    requestId,
    prompt: args.prompt,
    status: "thinking",
    text: "",
  });
  await ctx.scheduler.runAfter(0, internal.aiActions.write, { requestId });
  return requestId;
}

/** Records the request, posts 小飒's "thinking" message, and schedules the answer. */
export async function startAnswer(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    channel: Doc<"channels">;
    questionMessageId: Id<"messages">;
    source: "mention" | "private" | "appeal";
    weekKey: string;
    cost: number;
    skipFilter?: boolean;
  },
) {
  const sasaId = await ensureSasa(ctx);
  const requestId = await ctx.db.insert("aiRequests", {
    userId: args.userId,
    channelId: args.channel._id,
    questionMessageId: args.questionMessageId,
    source: args.source,
    status: "pending",
    cost: args.cost,
    weekKey: args.weekKey,
    skipFilter: args.skipFilter || undefined,
  });
  const replyMessageId = await ctx.db.insert("messages", {
    channelId: args.channel._id,
    authorId: sasaId,
    body: "",
    kind: "ai",
    aiReadable: true,
    replyToId: args.channel.type === "assistant" ? undefined : args.questionMessageId,
    ai: { status: "thinking", requestId },
  });
  await ctx.db.patch("aiRequests", requestId, { replyMessageId });
  await ctx.db.patch("channels", args.channel._id, { lastMessageAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.aiActions.answer, { requestId });
  return requestId;
}

/** Queues a task-suggestion scan for a plain message in an AI chat, within the per-chat hourly limit. */
export async function maybeScan(ctx: MutationCtx, channel: Doc<"channels">, messageId: Id<"messages">, body: string) {
  if (channel.type === "assistant" || !aiReadableChannel(channel) || !aiConfigured()) return;
  if (!worthScanning(body)) return;
  const now = Date.now();
  const fresh = !channel.aiScanWindowStart || now - channel.aiScanWindowStart >= HOUR_MS;
  const count = fresh ? 0 : (channel.aiScanCount ?? 0);
  if (count >= LIMITS.aiScansPerChannelHour) return;
  await ctx.db.patch("channels", channel._id, {
    aiScanWindowStart: fresh ? now : channel.aiScanWindowStart,
    aiScanCount: count + 1,
  });
  await ctx.scheduler.runAfter(0, internal.aiActions.scan, { messageId });
}
