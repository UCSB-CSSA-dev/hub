import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { maybeScan, prepareQuestion, startAnswer } from "./lib/ai/flow";
import { aiReadableChannel } from "./lib/ai/sasa";
import { logAudit } from "./lib/audit";
import {
  channelAudience,
  requireChannelAccess,
  touchReadState,
  userParticipates,
  type ChannelAccess,
} from "./lib/channels";
import { LIMITS, REACTIONS } from "./lib/constants";
import { canReadDocument, docSharedIn } from "./lib/documents";
import { appError } from "./lib/errors";
import { loadSpace, spaceAccess } from "./lib/files";
import {
  eraseMessageContent,
  isLiveUserContent,
  matchesQuery,
  mentionNames,
  previewText,
} from "./lib/messages";
import { toMessageViews, type ForwardItem, type ForwardSnapshot } from "./lib/messageViews";
import { chatLink, notify, notifyMany } from "./lib/notify";
import { requireApproved, type ViewerContext } from "./lib/permissions";
import { queuePush } from "./lib/push";
import { parseMentions, searchTerms, toSearchText } from "./lib/text";

export const list = query({
  args: { channelId: v.id("channels"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel } = await requireChannelAccess(ctx, viewer, args.channelId);
    const result = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...result, page: await toMessageViews(ctx, viewer.user._id, result.page) };
  },
});

/** A window of messages around one message, for jumping to search results and notifications. */
export const around = query({
  args: { channelId: v.id("channels"), messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel } = await requireChannelAccess(ctx, viewer, args.channelId);
    const target = await ctx.db.get("messages", args.messageId);
    if (!target || target.channelId !== channel._id) return null;
    const before = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) =>
        q.eq("channelId", channel._id).lt("_creationTime", target._creationTime),
      )
      .order("desc")
      .take(LIMITS.aroundMessages + 1);
    const after = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) =>
        q.eq("channelId", channel._id).gt("_creationTime", target._creationTime),
      )
      .take(LIMITS.aroundMessages + 1);
    const window = [
      ...before.slice(0, LIMITS.aroundMessages).reverse(),
      target,
      ...after.slice(0, LIMITS.aroundMessages),
    ];
    return {
      messages: await toMessageViews(ctx, viewer.user._id, window),
      hasOlder: before.length > LIMITS.aroundMessages,
      hasNewer: after.length > LIMITS.aroundMessages,
    };
  },
});

function requirePost(access: ChannelAccess) {
  if (access.canPost) return;
  throw appError(access.readOnly ? "READ_ONLY" : "FORBIDDEN");
}

function cleanBody(body: string, allowEmpty: boolean) {
  const trimmed = body.trim();
  if ((!trimmed && !allowEmpty) || trimmed.length > LIMITS.messageBody) {
    throw appError("INVALID", "body");
  }
  return trimmed;
}

/** Mentioned people who can read the channel as participants, excluding the author. */
async function validMentions(
  ctx: MutationCtx,
  viewer: ViewerContext,
  channel: Doc<"channels">,
  body: string,
): Promise<Id<"users">[]> {
  const ids: Id<"users">[] = [];
  for (const raw of parseMentions(body).userIds) {
    const userId = ctx.db.normalizeId("users", raw);
    if (!userId || userId === viewer.user._id) continue;
    if (await userParticipates(ctx, userId, channel)) ids.push(userId);
  }
  return ids;
}

async function notifyForMessage(
  ctx: MutationCtx,
  args: {
    viewer: ViewerContext;
    channel: Doc<"channels">;
    messageId: Id<"messages">;
    body: string;
    mentionIds: Id<"users">[];
    mentionAll: boolean;
    replyTo: Doc<"messages"> | null;
    announcement?: boolean;
    /** Edits only notify newly added mentions; the message itself was pushed when sent. */
    edited?: boolean;
  },
) {
  const { viewer, channel, messageId } = args;
  const preview = previewText(args.body, await mentionNames(ctx, args.body));
  const base = {
    params: { actorId: viewer.user._id, channelId: channel._id, preview },
    link: chatLink(channel._id, messageId),
    messageId,
  };
  const notified = new Set<Id<"users">>([viewer.user._id]);

  // Announcements reach everyone in the chat, muted or not; mentions and replies add nothing.
  if (args.announcement) {
    const audience = (await channelAudience(ctx, channel)).filter((id) => !notified.has(id));
    await notifyMany(ctx, audience, { type: "announcement", ...base });
    return;
  }
  for (const userId of args.mentionIds) {
    notified.add(userId);
    await notify(ctx, userId, { type: "mention", ...base });
  }
  const replyAuthor = args.replyTo?.authorId;
  if (replyAuthor && !notified.has(replyAuthor) && (await userParticipates(ctx, replyAuthor, channel))) {
    notified.add(replyAuthor);
    await notify(ctx, replyAuthor, { type: "reply", ...base });
  }
  if (args.mentionAll) {
    const audience = (await channelAudience(ctx, channel)).filter((id) => !notified.has(id));
    for (const id of audience) notified.add(id);
    await notifyMany(ctx, audience, {
      type: "mention",
      ...base,
      params: { ...base.params, all: true },
    });
  }
  if (args.edited) return;

  // Plain messages have no notification rows (the chat list shows unread counts), only a push.
  const members = await ctx.db
    .query("channelMembers")
    .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
    .collect();
  if (channel.type === "dm") {
    const recipients = members
      .filter((m) => m.joinedAt !== undefined && !m.muted && !notified.has(m.userId))
      .map((m) => m.userId);
    await queuePush(ctx, recipients, { type: "dm", params: base.params, link: base.link, tag: messageId });
    return;
  }
  const muted = new Set(members.filter((m) => m.muted).map((m) => m.userId));
  const recipients = (await channelAudience(ctx, channel)).filter((id) => !notified.has(id) && !muted.has(id));
  const params: Record<string, unknown> = { ...base.params };
  if (channel.name) params.name = channel.name;
  if (channel.departmentId) params.departmentId = channel.departmentId;
  await queuePush(ctx, recipients, { type: "chat", params, link: base.link, tag: messageId });
}

export const send = mutation({
  args: {
    channelId: v.id("channels"),
    body: v.string(),
    replyToId: v.optional(v.id("messages")),
    attachmentIds: v.optional(v.array(v.id("attachments"))),
    /** Files shared from Files; the viewer must be able to see each one. */
    fileIds: v.optional(v.array(v.id("files"))),
    announcement: v.optional(v.boolean()),
    /** Documents for 小飒 to read with a question (only allowed on questions to 小飒). */
    documentIds: v.optional(v.array(v.id("documents"))),
  },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel, access } = await requireChannelAccess(ctx, viewer, args.channelId);
    requirePost(access);
    const announcement = args.announcement === true;
    if (announcement && !access.canAnnounce) throw appError("FORBIDDEN");
    const assistant = channel.type === "assistant";
    if (assistant && ((args.attachmentIds?.length ?? 0) > 0 || (args.fileIds?.length ?? 0) > 0)) {
      throw appError("INVALID", "attachments");
    }

    const attachmentIds = [...new Set(args.attachmentIds ?? [])];
    if (attachmentIds.length > LIMITS.attachmentsPerMessage) throw appError("INVALID", "attachments");
    const fileIds = [...new Set(args.fileIds ?? [])];
    if (fileIds.length > LIMITS.sharedFilesPerMessage) throw appError("INVALID", "fileIds");
    for (const fileId of fileIds) {
      const file = await ctx.db.get("files", fileId);
      if (!file || file.deletedAt) throw appError("INVALID", "fileIds");
      const space = await loadSpace(ctx, file.departmentId);
      if (!spaceAccess(viewer, space.department).view) throw appError("INVALID", "fileIds");
    }
    const body = cleanBody(args.body, attachmentIds.length > 0 || fileIds.length > 0);

    const attachments: Doc<"attachments">[] = [];
    for (const id of attachmentIds) {
      const row = await ctx.db.get("attachments", id);
      // Only the uploader's own, unsent, unexpired uploads can be attached.
      if (!row || row.uploaderId !== viewer.user._id || row.messageId || row.expiredAt) {
        throw appError("INVALID", "attachments");
      }
      attachments.push(row);
    }

    let replyTo: Doc<"messages"> | null = null;
    if (args.replyToId) {
      replyTo = await ctx.db.get("messages", args.replyToId);
      if (!replyTo || replyTo.channelId !== channel._id || !isLiveUserContent(replyTo)) {
        throw appError("INVALID", "replyToId");
      }
    }

    const question = await prepareQuestion(ctx, viewer, channel, body);
    const documentIds = [...new Set(args.documentIds ?? [])];
    // Replying to a document card asks about that document.
    if (question && replyTo?.kind === "doc" && replyTo.documentId && !documentIds.includes(replyTo.documentId)) {
      documentIds.push(replyTo.documentId);
    }
    if (documentIds.length > 0 && !question) throw appError("INVALID", "documentIds");
    if (documentIds.length > LIMITS.aiDocsPerQuestion) throw appError("INVALID", "documentIds");
    for (const documentId of documentIds) {
      const doc = await ctx.db.get("documents", documentId);
      const allowed =
        doc !== null &&
        (await canReadDocument(ctx, viewer, doc._id)) &&
        (assistant || (await docSharedIn(ctx, doc, channel)));
      if (!allowed) throw appError("INVALID", "documentIds");
    }
    const mentionIds = await validMentions(ctx, viewer, channel, body);
    const mentionAll = parseMentions(body).all && access.canMentionAll;
    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      channelId: channel._id,
      authorId: viewer.user._id,
      body,
      kind: "user",
      aiReadable: aiReadableChannel(channel) || undefined,
      mentionUserIds: mentionIds,
      mentionAll,
      replyToId: replyTo?._id,
      announcement: announcement || undefined,
      searchText: toSearchText(body),
      fileIds: fileIds.length > 0 ? fileIds : undefined,
      aiDocumentIds: documentIds.length > 0 ? documentIds : undefined,
    });
    const expiresAt = now + LIMITS.attachmentRetentionDays * 24 * 60 * 60 * 1000;
    for (const attachment of attachments) {
      await ctx.db.patch("attachments", attachment._id, { messageId, expiresAt });
    }
    await ctx.db.patch("channels", channel._id, { lastMessageAt: now });
    await touchReadState(ctx, channel._id, viewer.user._id, now);
    if (!assistant) {
      await notifyForMessage(ctx, {
        viewer,
        channel,
        messageId,
        body,
        mentionIds,
        mentionAll,
        replyTo,
        announcement,
      });
    }
    if (question) {
      await startAnswer(ctx, {
        userId: viewer.user._id,
        channel,
        questionMessageId: messageId,
        source: assistant ? "private" : "mention",
        weekKey: question.weekKey,
        cost: 1,
      });
    } else {
      await maybeScan(ctx, channel, messageId, body);
    }
    return messageId;
  },
});

async function requireOwnLiveMessage(ctx: MutationCtx, viewer: ViewerContext, messageId: Id<"messages">) {
  const message = await ctx.db.get("messages", messageId);
  if (!message) throw appError("NOT_FOUND");
  if (message.authorId !== viewer.user._id || !isLiveUserContent(message)) throw appError("FORBIDDEN");
  const { channel, access } = await requireChannelAccess(ctx, viewer, message.channelId);
  if (access.via !== "member") throw appError("FORBIDDEN");
  return { message, channel, access };
}

export const edit = mutation({
  args: { messageId: v.id("messages"), body: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { message, channel, access } = await requireOwnLiveMessage(ctx, viewer, args.messageId);
    if (message.kind === "forward" || message.kind === "task" || message.kind === "doc") throw appError("FORBIDDEN");
    requirePost(access);
    const hasAttachments =
      (message.fileIds?.length ?? 0) > 0 ||
      (await ctx.db
        .query("attachments")
        .withIndex("by_message", (q) => q.eq("messageId", message._id))
        .first()) !== null;
    const body = cleanBody(args.body, hasAttachments);
    if (body === message.body) return;

    const mentionIds = await validMentions(ctx, viewer, channel, body);
    const mentionAll = parseMentions(body).all && access.canMentionAll;
    await ctx.db.insert("messageEdits", { messageId: message._id, body: message.body });
    await ctx.db.patch("messages", message._id, {
      body,
      editedAt: Date.now(),
      mentionUserIds: mentionIds,
      mentionAll,
      searchText: toSearchText(body),
    });

    const previous = new Set(message.mentionUserIds ?? []);
    const added = mentionIds.filter((id) => !previous.has(id));
    if (added.length > 0 || (mentionAll && !message.mentionAll)) {
      await notifyForMessage(ctx, {
        viewer,
        channel,
        messageId: message._id,
        body,
        mentionIds: added,
        mentionAll: mentionAll && !message.mentionAll,
        replyTo: null,
        edited: true,
      });
    }
  },
});

/** Every version of an edited message, oldest first. Visible to anyone who can read the chat. */
export const history = query({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const message = await ctx.db.get("messages", args.messageId);
    if (!message) return null;
    await requireChannelAccess(ctx, viewer, message.channelId);
    if (!isLiveUserContent(message)) return [];
    const edits = await ctx.db
      .query("messageEdits")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .collect();
    const versions = edits.map((edit, i) => ({
      body: edit.body,
      at: i === 0 ? message._creationTime : edits[i - 1]._creationTime,
    }));
    versions.push({
      body: message.body,
      at: edits.at(-1)?._creationTime ?? message._creationTime,
    });
    return versions;
  },
});

export const recall = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { message } = await requireOwnLiveMessage(ctx, viewer, args.messageId);
    if (Date.now() - message._creationTime > LIMITS.recallWindowMs) throw appError("RECALL_EXPIRED");
    await eraseMessageContent(ctx, message);
    await ctx.db.patch("messages", message._id, { recalledAt: Date.now() });
  },
});

/** 主席团 and system admins remove any message they can read. The content is erased. */
export const remove = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const message = await ctx.db.get("messages", args.messageId);
    if (!message) throw appError("NOT_FOUND");
    const { access } = await requireChannelAccess(ctx, viewer, message.channelId);
    if (!access.canModerate) throw appError("FORBIDDEN");
    if (!isLiveUserContent(message)) throw appError("INVALID", "state");
    await eraseMessageContent(ctx, message);
    await ctx.db.patch("messages", message._id, { removedAt: Date.now(), removedBy: viewer.user._id });
    await logAudit(ctx, {
      actorId: viewer.user._id,
      action: "message.moderate_remove",
      targetType: "message",
      targetId: message._id,
      subjectUserId: message.authorId,
      metadata: { channelId: message.channelId, via: access.via },
    });
  },
});

export const toggleReaction = mutation({
  args: { messageId: v.id("messages"), emoji: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    if (!(REACTIONS as readonly string[]).includes(args.emoji)) throw appError("INVALID", "emoji");
    const message = await ctx.db.get("messages", args.messageId);
    if (!message || !isLiveUserContent(message)) throw appError("NOT_FOUND");
    const { access } = await requireChannelAccess(ctx, viewer, message.channelId);
    if (access.via !== "member" || !access.canInteract) throw appError("FORBIDDEN");
    const existing = await ctx.db
      .query("messageReactions")
      .withIndex("by_message_user_emoji", (q) =>
        q.eq("messageId", message._id).eq("userId", viewer.user._id).eq("emoji", args.emoji),
      )
      .unique();
    if (existing) await ctx.db.delete("messageReactions", existing._id);
    else await ctx.db.insert("messageReactions", { messageId: message._id, userId: viewer.user._id, emoji: args.emoji });
  },
});

/** Search within one channel. Works for Chinese through the bigram search text. */
export const search = query({
  args: { channelId: v.id("channels"), query: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel } = await requireChannelAccess(ctx, viewer, args.channelId);
    const terms = [...new Set(searchTerms(args.query))].slice(0, LIMITS.searchTerms);
    if (terms.length === 0) return [];
    const candidates = await ctx.db
      .query("messages")
      .withSearchIndex("search_text", (q) =>
        q.search("searchText", terms.join(" ")).eq("channelId", channel._id),
      )
      .take(256);
    const hits = candidates
      .filter((m) => isLiveUserContent(m) && matchesQuery(m.body, args.query))
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, LIMITS.searchResults);
    return toMessageViews(ctx, viewer.user._id, hits);
  },
});

function snapshotSize(snapshot: ForwardSnapshot) {
  return JSON.stringify(snapshot).length;
}

function snapshotDepth(snapshot: ForwardSnapshot | undefined): number {
  if (!snapshot) return 0;
  return 1 + Math.max(0, ...snapshot.items.map((item) => snapshotDepth(item.forward)));
}

/** Sends the selected messages to other chats as one combined chat record (合并转发). */
export const forward = mutation({
  args: {
    sourceChannelId: v.id("channels"),
    messageIds: v.array(v.id("messages")),
    targetChannelIds: v.array(v.id("channels")),
  },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel: source, access } = await requireChannelAccess(ctx, viewer, args.sourceChannelId);
    if (access.via !== "member") throw appError("FORBIDDEN");
    const messageIds = [...new Set(args.messageIds)];
    const targetIds = [...new Set(args.targetChannelIds)];
    if (messageIds.length === 0 || messageIds.length > LIMITS.forwardMessages) {
      throw appError("INVALID", "messageIds");
    }
    if (targetIds.length === 0 || targetIds.length > LIMITS.forwardTargets) {
      throw appError("INVALID", "targetChannelIds");
    }

    const messages: Doc<"messages">[] = [];
    for (const id of messageIds) {
      const message = await ctx.db.get("messages", id);
      const card =
        message?.kind === "task" ||
        message?.kind === "doc" ||
        (message?.kind === "ai" && (message.ai?.status !== "done" || message.ai.suggestionId !== undefined));
      if (!message || message.channelId !== source._id || !isLiveUserContent(message) || card) {
        throw appError("INVALID", "messageIds");
      }
      messages.push(message);
    }
    messages.sort((a, b) => a._creationTime - b._creationTime);

    const items: ForwardItem[] = [];
    for (const message of messages) {
      const attachments = await ctx.db
        .query("attachments")
        .withIndex("by_message", (q) => q.eq("messageId", message._id))
        .collect();
      items.push({
        authorId: message.authorId,
        body: message.body,
        sentAt: message._creationTime,
        attachmentIds: attachments.map((a) => a._id),
        forward: message.forward as ForwardSnapshot | undefined,
      });
    }

    const sourceInfo: ForwardSnapshot["source"] = { type: source.type };
    if (source.type === "group") sourceInfo.name = source.name;
    if (source.departmentId) {
      const department = await ctx.db.get("departments", source.departmentId);
      sourceInfo.nameZh = department?.nameZh;
      sourceInfo.nameEn = department?.nameEn;
    }
    if (source.type === "dm") {
      const rows = await ctx.db
        .query("channelMembers")
        .withIndex("by_channel", (q) => q.eq("channelId", source._id))
        .collect();
      sourceInfo.userIds = rows.map((r) => r.userId);
    }
    const snapshot: ForwardSnapshot = { source: sourceInfo, items };
    if (snapshotDepth(snapshot) > LIMITS.forwardDepth || snapshotSize(snapshot) > LIMITS.forwardBytes) {
      throw appError("INVALID", "too_large");
    }

    const now = Date.now();
    const sent: Id<"messages">[] = [];
    for (const targetId of targetIds) {
      const { channel: target, access: targetAccess } = await requireChannelAccess(ctx, viewer, targetId);
      if (target.type === "assistant") throw appError("INVALID", "targetChannelIds");
      requirePost(targetAccess);
      const searchText = toSearchText(items.map((item) => item.body).join(" "));
      sent.push(
        await ctx.db.insert("messages", {
          channelId: target._id,
          authorId: viewer.user._id,
          body: "",
          kind: "forward",
          forward: snapshot,
          searchText,
        }),
      );
      await ctx.db.patch("channels", target._id, { lastMessageAt: now });
      await touchReadState(ctx, target._id, viewer.user._id, now);
    }
    return sent;
  },
});
