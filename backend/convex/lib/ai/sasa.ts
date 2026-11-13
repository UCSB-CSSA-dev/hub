import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { SASA } from "../constants";
import { parseMentions } from "../text";

export async function findSasa(ctx: QueryCtx): Promise<Doc<"users"> | null> {
  return ctx.db
    .query("users")
    .withIndex("by_isBot", (q) => q.eq("isBot", true))
    .first();
}

/** The 小飒 user row, created on first use. */
export async function ensureSasa(ctx: MutationCtx): Promise<Id<"users">> {
  const existing = await findSasa(ctx);
  if (existing) return existing._id;
  return ctx.db.insert("users", {
    isBot: true,
    name: SASA.nameEn,
    nameZh: SASA.nameZh,
    nameEn: SASA.nameEn,
    locale: "zh",
  });
}

const TEXT_MENTION = /@(?:sasa\b|小飒)/i;

/** A question for 小飒: the picker's `<@id>` token, or "@Sasa" / "@小飒" typed by hand. */
export function mentionsSasa(body: string, sasaId: Id<"users"> | null) {
  if (sasaId && parseMentions(body).userIds.includes(sasaId)) return true;
  return TEXT_MENTION.test(body.replace(/<@[a-z0-9]+>/gi, " "));
}

export function isAiChannelType(type: Doc<"channels">["type"]) {
  return type === "org" || type === "department" || type === "group";
}

/** Whether new messages in this chat can be read by 小飒. */
export function aiReadableChannel(channel: Doc<"channels">) {
  return channel.type === "assistant" || (isAiChannelType(channel.type) && channel.aiEnabled === true);
}

const ASSISTANT_PREFIX = "assistant:";

export function assistantKey(userId: Id<"users">) {
  return `${ASSISTANT_PREFIX}${userId}`;
}

/** The owner of a private 小飒 chat. */
export function assistantOwner(channel: Doc<"channels">): Id<"users"> | null {
  if (channel.type !== "assistant" || !channel.dmKey?.startsWith(ASSISTANT_PREFIX)) return null;
  return channel.dmKey.slice(ASSISTANT_PREFIX.length) as Id<"users">;
}

export function aiConfigured() {
  return Boolean(process.env.AI_API_KEY) || process.env.AI_DRY_RUN === "true";
}
