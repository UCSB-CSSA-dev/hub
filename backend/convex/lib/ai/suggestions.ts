import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { channelAccess } from "../channels";
import type { ViewerContext } from "../permissions";
import { canCreateTaskIn, taskAccess } from "../tasks";
import { pacificWallTime } from "../time";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Who can press a suggestion card's button: task creators in the chat, or the task's reviewers for edits.
 * Edits proposed from a document summary only need the reviewer check (they aren't shown in the chat).
 */
export async function canActOnSuggestion(ctx: QueryCtx, viewer: ViewerContext, suggestion: Doc<"aiSuggestions">) {
  if (suggestion.status !== "pending") return false;
  const channel = await ctx.db.get("channels", suggestion.channelId);
  if (!channel) return false;
  if (!suggestion.documentId) {
    const access = await channelAccess(ctx, viewer, channel);
    if (access.via !== "member" || access.readOnly) return false;
  }
  if (suggestion.action === "edit") {
    const assignment = suggestion.assignmentId ? await ctx.db.get("assignments", suggestion.assignmentId) : null;
    if (!assignment || assignment.status !== "open") return false;
    return (await taskAccess(ctx, viewer, assignment))?.review === true;
  }
  return canCreateTaskIn(ctx, viewer, channel);
}

/** Marks a suggestion applied once the task form saved it in the same chat (assignments.create/update). */
export async function markSuggestionApplied(
  ctx: MutationCtx,
  viewer: ViewerContext,
  suggestionId: Id<"aiSuggestions"> | undefined,
  channelId: Id<"channels">,
) {
  if (!suggestionId) return;
  const suggestion = await ctx.db.get("aiSuggestions", suggestionId);
  if (!suggestion || suggestion.status !== "pending" || suggestion.channelId !== channelId) return;
  await ctx.db.patch("aiSuggestions", suggestion._id, { status: "applied", actedBy: viewer.user._id });
}

/** ISO 8601 from the model. Without an offset it's Pacific wall time; a bare date means 23:59 that day. */
export function parseWhen(value: unknown, now: number, allowDateOnly: boolean): number | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(text);
  if (!parts) return undefined;
  let ms: number;
  if (parts[4] !== undefined && /(z|[+-]\d{2}:?\d{2})$/i.test(text)) ms = Date.parse(text);
  else if (parts[4] !== undefined) ms = pacificWallTime(+parts[1], +parts[2], +parts[3], +parts[4], +parts[5]);
  else if (allowDateOnly) ms = pacificWallTime(+parts[1], +parts[2], +parts[3], 23, 59);
  else return undefined;
  if (!Number.isFinite(ms) || ms < now - DAY_MS || ms > now + 400 * DAY_MS) return undefined;
  return ms;
}
