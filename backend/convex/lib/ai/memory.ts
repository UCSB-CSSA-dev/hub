import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { logAudit } from "../audit";
import { LIMITS } from "../constants";
import { appError } from "../errors";
import type { FilterRule } from "./prompts";

/** The admins' rules for the relevance filter, newest first. Read on every filter call. */
export async function filterMemory(ctx: QueryCtx): Promise<FilterRule[]> {
  const rows = await ctx.db.query("aiFilterMemory").withIndex("by_updatedAt").order("desc").take(LIMITS.aiMemoryRules);
  return rows.map((row) => ({ verdict: row.verdict, text: row.text }));
}

export function cleanRule(text: string) {
  const rule = text.replace(/\s+/g, " ").trim();
  if (!rule || rule.length > LIMITS.aiMemoryRule) throw appError("INVALID", "rule");
  return rule;
}

export async function addRule(
  ctx: MutationCtx,
  actorId: Id<"users">,
  rule: { verdict: FilterRule["verdict"]; text: string; appealId?: Id<"aiAppeals"> },
) {
  const text = cleanRule(rule.text);
  const count = (await ctx.db.query("aiFilterMemory").take(LIMITS.aiMemoryRules)).length;
  if (count >= LIMITS.aiMemoryRules) throw appError("INVALID", "memory_full");
  const now = Date.now();
  const id = await ctx.db.insert("aiFilterMemory", {
    verdict: rule.verdict,
    text,
    appealId: rule.appealId,
    createdBy: actorId,
    updatedAt: now,
    updatedBy: actorId,
  });
  await logAudit(ctx, {
    actorId,
    action: "ai.memory_change",
    targetType: "aiFilterMemory",
    targetId: id,
    metadata: { change: "add", verdict: rule.verdict, text, appealId: rule.appealId },
  });
  return id;
}
