import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { aiModels, chatJson, chatStream, parseJsonObject } from "./lib/ai/client";
import { LIMITS } from "./lib/constants";

const DRY_RUN_ANSWER = "（测试模式）小飒收到了你的问题。 (Dry run: Sasa got your question.)";

/** Relevance filter (fast model), context, then the streamed answer (answer model). */
export const answer = internalAction({
  args: { requestId: v.id("aiRequests") },
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.ai.answerJob, { requestId: args.requestId });
    if (!job) return;
    if (job.gone) {
      await ctx.runMutation(internal.ai.fail, { requestId: args.requestId, error: "question removed" });
      return;
    }
    const models = aiModels();
    try {
      let keywords: string[] = [];
      if (!job.skipFilter) {
        // The filter fails open: a broken filter call shouldn't block a real question.
        const verdict = await chatJson(models.fast, job.filter, () => ({ relevant: true, keywords: [] })).catch(
          () => null,
        );
        if (verdict?.relevant === false) {
          await ctx.runMutation(internal.ai.refuse, {
            requestId: args.requestId,
            reason: typeof verdict.reason === "string" ? verdict.reason : "",
          });
          return;
        }
        if (Array.isArray(verdict?.keywords)) {
          keywords = verdict.keywords.filter((k): k is string => typeof k === "string").slice(0, 6);
        }
      }

      const prompt = await ctx.runQuery(internal.ai.answerContext, { requestId: args.requestId, keywords });
      if (!prompt) {
        await ctx.runMutation(internal.ai.fail, { requestId: args.requestId, error: "no access" });
        return;
      }

      let flushedAt = 0;
      let flushedLength = 0;
      const text = await chatStream(
        models.answer,
        prompt,
        async (partial) => {
          const now = Date.now();
          if (now - flushedAt < LIMITS.aiStreamFlushMs && partial.length - flushedLength < LIMITS.aiStreamFlushChars) {
            return;
          }
          flushedAt = now;
          flushedLength = partial.length;
          if (partial) await ctx.runMutation(internal.ai.streamText, { requestId: args.requestId, text: partial });
        },
        () => DRY_RUN_ANSWER,
      );
      await ctx.runMutation(internal.ai.finish, { requestId: args.requestId, text, model: models.answer });
    } catch (error) {
      await ctx.runMutation(internal.ai.fail, {
        requestId: args.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

/** Looks for a task or event to suggest in a message sent in an AI chat. Free; failures are dropped. */
export const scan = internalAction({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const prompt = await ctx.runQuery(internal.ai.scanJob, { messageId: args.messageId });
    if (!prompt) return;
    const result = await chatJson(aiModels().fast, prompt, () => ({ action: "none" })).catch(() => null);
    if (!result || result.action === "none") return;
    await ctx.runMutation(internal.ai.suggest, { messageId: args.messageId, result });
  },
});

const DRY_RUN_SUMMARY = JSON.stringify({
  summary: "（测试模式）小飒读过了这份文档。 (Dry run: Sasa read this document.)",
  tasks: [],
  announcements: [],
  edits: [],
});
const DRY_RUN_WRITE = "（测试模式）小飒写的内容。\n\n(Dry run: what Sasa wrote.)";

/** Summary and extraction of a document (answer model, JSON). No relevance filter: reading a CSSA document is always in scope. */
export const summarize = internalAction({
  args: { requestId: v.id("aiRequests") },
  handler: async (ctx, args) => {
    const prompt = await ctx.runQuery(internal.aiDocs.summaryJob, { requestId: args.requestId });
    if (!prompt) {
      await ctx.runMutation(internal.ai.fail, { requestId: args.requestId, error: "no access" });
      return;
    }
    const models = aiModels();
    try {
      // Streamed so long documents don't hit gateway idle timeouts; parsed once complete.
      const text = await chatStream(models.answer, prompt, async () => {}, () => DRY_RUN_SUMMARY, {
        temperature: 0.2,
        timeoutMs: LIMITS.aiDocTimeoutMs,
      });
      await ctx.runMutation(internal.aiDocs.finishSummary, {
        requestId: args.requestId,
        result: parseJsonObject(text),
        model: models.answer,
      });
    } catch (error) {
      await ctx.runMutation(internal.ai.fail, {
        requestId: args.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

/** Writing with a prompt: relevance filter (fast model), then the streamed draft (answer model). */
export const write = internalAction({
  args: { requestId: v.id("aiRequests") },
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.aiDocs.writeJob, { requestId: args.requestId });
    if (!job) return;
    if (job.gone) {
      await ctx.runMutation(internal.ai.fail, { requestId: args.requestId, error: "no access" });
      return;
    }
    const models = aiModels();
    try {
      if (!job.skipFilter) {
        const verdict = await chatJson(models.fast, job.filter, () => ({ relevant: true })).catch(() => null);
        if (verdict?.relevant === false) {
          await ctx.runMutation(internal.ai.refuse, {
            requestId: args.requestId,
            reason: typeof verdict.reason === "string" ? verdict.reason : "",
          });
          return;
        }
      }
      const prompt = await ctx.runQuery(internal.aiDocs.writeContext, { requestId: args.requestId });
      if (!prompt) {
        await ctx.runMutation(internal.ai.fail, { requestId: args.requestId, error: "no access" });
        return;
      }
      let flushedAt = 0;
      let flushedLength = 0;
      const text = await chatStream(
        models.answer,
        prompt,
        async (partial) => {
          const now = Date.now();
          if (now - flushedAt < LIMITS.aiStreamFlushMs && partial.length - flushedLength < LIMITS.aiStreamFlushChars) {
            return;
          }
          flushedAt = now;
          flushedLength = partial.length;
          if (partial) await ctx.runMutation(internal.aiDocs.streamDraft, { requestId: args.requestId, text: partial });
        },
        () => DRY_RUN_WRITE,
        { timeoutMs: LIMITS.aiDocTimeoutMs },
      );
      await ctx.runMutation(internal.aiDocs.finishDraft, { requestId: args.requestId, text, model: models.answer });
    } catch (error) {
      await ctx.runMutation(internal.ai.fail, {
        requestId: args.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});
