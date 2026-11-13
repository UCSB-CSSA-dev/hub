import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { logAudit } from "./lib/audit";
import { addRule, cleanRule } from "./lib/ai/memory";
import { LIMITS } from "./lib/constants";
import { appError } from "./lib/errors";
import { requireSystemAdmin } from "./lib/permissions";
import { getUserSummaries, type UserSummary } from "./lib/users";

const verdict = v.union(v.literal("allow"), v.literal("refuse"));

export type FilterRuleView = {
  _id: Id<"aiFilterMemory">;
  verdict: "allow" | "refuse";
  text: string;
  fromAppeal: boolean;
  createdBy: UserSummary | null;
  updatedAt: number;
  updatedBy: UserSummary | null;
};

/** What 小飒's relevance filter has been taught, newest first. Live: the filter reads the same rows. */
export const list = query({
  args: {},
  handler: async (ctx): Promise<{ rules: FilterRuleView[]; max: number }> => {
    await requireSystemAdmin(ctx);
    const rows = await ctx.db.query("aiFilterMemory").withIndex("by_updatedAt").order("desc").take(LIMITS.aiMemoryRules);
    const people = await getUserSummaries(ctx, rows.flatMap((r) => [r.createdBy, r.updatedBy]));
    return {
      max: LIMITS.aiMemoryRules,
      rules: rows.map((row) => ({
        _id: row._id,
        verdict: row.verdict,
        text: row.text,
        fromAppeal: row.appealId !== undefined,
        createdBy: people.get(row.createdBy) ?? null,
        updatedAt: row.updatedAt,
        updatedBy: people.get(row.updatedBy) ?? null,
      })),
    };
  },
});

export const add = mutation({
  args: { verdict, text: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireSystemAdmin(ctx);
    return addRule(ctx, viewer.user._id, { verdict: args.verdict, text: args.text });
  },
});

export const update = mutation({
  args: { ruleId: v.id("aiFilterMemory"), verdict, text: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireSystemAdmin(ctx);
    const row = await ctx.db.get("aiFilterMemory", args.ruleId);
    if (!row) throw appError("NOT_FOUND");
    const text = cleanRule(args.text);
    if (text === row.text && args.verdict === row.verdict) return;
    await ctx.db.patch("aiFilterMemory", row._id, {
      verdict: args.verdict,
      text,
      updatedAt: Date.now(),
      updatedBy: viewer.user._id,
    });
    await logAudit(ctx, {
      actorId: viewer.user._id,
      action: "ai.memory_change",
      targetType: "aiFilterMemory",
      targetId: row._id,
      metadata: { change: "update", verdict: args.verdict, text, before: { verdict: row.verdict, text: row.text } },
    });
  },
});

export const remove = mutation({
  args: { ruleId: v.id("aiFilterMemory") },
  handler: async (ctx, args) => {
    const viewer = await requireSystemAdmin(ctx);
    const row = await ctx.db.get("aiFilterMemory", args.ruleId);
    if (!row) return;
    await ctx.db.delete("aiFilterMemory", row._id);
    await logAudit(ctx, {
      actorId: viewer.user._id,
      action: "ai.memory_change",
      targetType: "aiFilterMemory",
      targetId: row._id,
      metadata: { change: "remove", verdict: row.verdict, text: row.text },
    });
  },
});
