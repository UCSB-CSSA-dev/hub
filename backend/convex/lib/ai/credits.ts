import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { AI_CREDITS, AI_RESET, LIMITS } from "../constants";
import type { ViewerContext } from "../permissions";
import { pacificDay, pacificWeekWindow } from "../time";

/** The credit week containing `ms`: Sunday 08:00 Pacific to the next one. */
export function creditWeek(ms: number) {
  const { start, end } = pacificWeekWindow(ms, AI_RESET.weekday, AI_RESET.hour);
  return { key: pacificDay(start), start, end };
}

/** Weekly credits for the viewer's highest role; null means unlimited (system admins). */
export function allowanceFor(viewer: ViewerContext): number | null {
  if (viewer.isSystemAdmin) return null;
  if (viewer.isPresidium) return AI_CREDITS.presidium;
  if (viewer.ledDepartmentIds.length > 0) return AI_CREDITS.lead;
  return AI_CREDITS.member;
}

export type CreditState = {
  unlimited: boolean;
  allowance: number;
  used: number;
  refunded: number;
  balance: number;
  weekKey: string;
  nextResetAt: number;
};

export async function creditState(ctx: QueryCtx, viewer: ViewerContext, now = Date.now()): Promise<CreditState> {
  const week = creditWeek(now);
  const userId = viewer.user._id;
  const requests = await ctx.db
    .query("aiRequests")
    .withIndex("by_user_week", (q) => q.eq("userId", userId).eq("weekKey", week.key))
    .collect();
  const adjustments = await ctx.db
    .query("aiCreditAdjustments")
    .withIndex("by_user_week", (q) => q.eq("userId", userId).eq("weekKey", week.key))
    .collect();
  const used = requests.reduce((sum, r) => sum + r.cost, 0);
  const refunded = adjustments.reduce((sum, a) => sum + a.delta, 0);
  const allowance = allowanceFor(viewer);
  return {
    unlimited: allowance === null,
    allowance: allowance ?? 0,
    used,
    refunded,
    balance: allowance === null ? Number.POSITIVE_INFINITY : Math.max(0, allowance - used + refunded),
    weekKey: week.key,
    nextResetAt: week.end,
  };
}

/** A pending question by this user that is still being answered (stale ones don't block). */
export async function inFlightRequest(ctx: QueryCtx, userId: Id<"users">, now = Date.now()) {
  const pending = await ctx.db
    .query("aiRequests")
    .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "pending"))
    .collect();
  return pending.find((r) => now - r._creationTime < LIMITS.aiStaleRequestMs && r.source !== "appeal") ?? null;
}
