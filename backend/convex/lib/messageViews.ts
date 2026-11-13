import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { canActOnSuggestion } from "./ai/suggestions";
import { LIMITS, PUBLIC_SPACE } from "./constants";
import { messageState, type MessageState } from "./messages";
import { buildViewerContext, type ViewerContext } from "./permissions";
import { eventEnd } from "./tasks";
import { MENTION_PATTERN } from "./text";
import { getUserSummaries, type UserSummary } from "./users";

export type AttachmentView = {
  _id: Id<"attachments">;
  name: string;
  size: number;
  contentType: string;
  isImage: boolean;
  url: string | null;
  thumbUrl: string | null;
  expired: boolean;
};

export type ForwardItem = {
  authorId: Id<"users">;
  body: string;
  sentAt: number;
  attachmentIds: Id<"attachments">[];
  forward?: ForwardSnapshot;
};

export type ForwardSnapshot = {
  source: {
    type: Doc<"channels">["type"];
    nameZh?: string;
    nameEn?: string;
    name?: string;
    /** DMs: the two people, to title the record "A 和 B 的聊天记录". */
    userIds?: Id<"users">[];
  };
  items: ForwardItem[];
};

export type ForwardItemView = Omit<ForwardItem, "forward"> & {
  attachments: AttachmentView[];
  forward?: ForwardView;
};
export type ForwardView = { source: ForwardSnapshot["source"]; items: ForwardItemView[] };

export type ReactionView = { emoji: string; count: number; mine: boolean; userIds: Id<"users">[] };

export type ReplyView = {
  _id: Id<"messages">;
  authorId: Id<"users"> | null;
  body: string;
  state: MessageState | "missing";
};

/** A file shared from Files. `canView` is false only for 主席团 files seen by others. */
export type SharedFileView = {
  _id: Id<"files">;
  name: string;
  size: number;
  contentType: string;
  spaceKey: string;
  spaceNameZh: string;
  spaceNameEn: string;
  deleted: boolean;
  canView: boolean;
  /** A document created in Files: the card opens the editor. */
  documentId: Id<"documents"> | null;
};

export type TaskCardView = {
  _id: Id<"assignments">;
  kind: "task" | "event";
  title: string;
  status: Doc<"assignments">["status"];
  dueAt?: number;
  startAt?: number;
  endAt?: number;
  location?: string;
  requiresSubmission: boolean;
  assigneeCount: number;
  /** Submitted or approved (tasks). */
  doneCount: number;
  myStatus: Doc<"assignmentSubmissions">["status"] | null;
  ended: boolean;
};

export type DocCardView = { _id: Id<"documents">; title: string; updatedAt: number };

export type AiSuggestionView = {
  _id: Id<"aiSuggestions">;
  action: Doc<"aiSuggestions">["action"];
  status: Doc<"aiSuggestions">["status"];
  assignmentId?: Id<"assignments">;
  /** Edits: the task's current title. */
  assignmentTitle?: string;
  fields: Doc<"aiSuggestions">["fields"];
  canAct: boolean;
};

export type AiView = {
  status: NonNullable<Doc<"messages">["ai"]>["status"];
  /** A fixed notice rendered from translations ("welcome", "appeal_denied"). */
  notice?: string;
  requestId?: Id<"aiRequests">;
  /** Who asked the question this message answers. */
  askerId?: Id<"users">;
  /** Announcements 小飒 posted for someone (from a document summary). */
  actorId?: Id<"users">;
  /** Refusals: the appeal state, and whether the viewer (the asker) can still appeal. */
  appeal?: { status: "none" | Doc<"aiAppeals">["status"]; canAppeal: boolean };
  /** Suggestion cards; null when the suggestion was cleaned up. */
  suggestion?: AiSuggestionView | null;
};

export type MessageView = {
  _id: Id<"messages">;
  _creationTime: number;
  kind: "user" | "system" | "forward" | "task" | "doc" | "ai";
  authorId: Id<"users">;
  body: string;
  state: MessageState;
  announcement: boolean;
  editedAt?: number;
  removedBy?: Id<"users">;
  replyTo?: ReplyView;
  reactions: ReactionView[];
  attachments: AttachmentView[];
  system?: { event: string; params: Record<string, unknown> };
  forward?: ForwardView;
  files: SharedFileView[];
  /** kind "task": the live card; null when the task was deleted. */
  task?: TaskCardView | null;
  /** kind "doc": the chat document; null when it was deleted. */
  doc?: DocCardView | null;
  /** kind "ai": 小飒's message state. */
  ai?: AiView;
  /** Documents attached to a question for 小飒. */
  aiDocuments?: DocCardView[];
  /** Every user referenced by this message (author, mentions, reactions, system params, forwards). */
  people: UserSummary[];
  /** Departments referenced by system params. */
  departments: DepartmentName[];
};

export type DepartmentName = { _id: Id<"departments">; nameZh: string; nameEn: string };

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

async function attachmentViews(ctx: QueryCtx, rows: (Doc<"attachments"> | null)[]) {
  const views: AttachmentView[] = [];
  for (const row of rows) {
    if (!row) continue;
    const expired = row.expiredAt !== undefined;
    views.push({
      _id: row._id,
      name: row.name,
      size: row.size,
      contentType: row.contentType,
      isImage: IMAGE_TYPES.has(row.contentType),
      url: expired ? null : await ctx.storage.getUrl(row.storageId),
      thumbUrl: expired || !row.thumbStorageId ? null : await ctx.storage.getUrl(row.thumbStorageId),
      expired,
    });
  }
  return views;
}

function mentionIds(body: string) {
  return [...body.matchAll(MENTION_PATTERN)].map((m) => m[1]).filter((id) => id !== "all");
}

async function forwardView(
  ctx: QueryCtx,
  snapshot: ForwardSnapshot,
  people: Set<string>,
): Promise<ForwardView> {
  for (const id of snapshot.source.userIds ?? []) people.add(id);
  const items: ForwardItemView[] = [];
  for (const item of snapshot.items) {
    people.add(item.authorId);
    for (const id of mentionIds(item.body)) people.add(id);
    const rows = await Promise.all(item.attachmentIds.map((id) => ctx.db.get("attachments", id)));
    items.push({
      authorId: item.authorId,
      body: item.body,
      sentAt: item.sentAt,
      attachmentIds: item.attachmentIds,
      attachments: await attachmentViews(ctx, rows),
      forward: item.forward ? await forwardView(ctx, item.forward, people) : undefined,
    });
  }
  return { source: snapshot.source, items };
}

async function sharedFileViews(
  ctx: QueryCtx,
  fileIds: Id<"files">[],
  isAdmin: () => Promise<boolean>,
): Promise<SharedFileView[]> {
  const views: SharedFileView[] = [];
  for (const fileId of fileIds) {
    const file = await ctx.db.get("files", fileId);
    if (!file) {
      views.push({
        _id: fileId,
        name: "",
        size: 0,
        contentType: "",
        spaceKey: "",
        spaceNameZh: "",
        spaceNameEn: "",
        deleted: true,
        canView: false,
        documentId: null,
      });
      continue;
    }
    const department = file.departmentId ? await ctx.db.get("departments", file.departmentId) : null;
    views.push({
      _id: file._id,
      name: file.name,
      size: file.size,
      contentType: file.contentType,
      spaceKey: department?.slug ?? PUBLIC_SPACE,
      spaceNameZh: department?.nameZh ?? "公共",
      spaceNameEn: department?.nameEn ?? "Public",
      deleted: file.deletedAt !== undefined,
      canView: department?.kind === "presidium" ? await isAdmin() : true,
      documentId: file.documentId ?? null,
    });
  }
  return views;
}

export async function taskCard(
  ctx: QueryCtx,
  assignmentId: Id<"assignments">,
  viewerId: Id<"users">,
): Promise<TaskCardView | null> {
  const assignment = await ctx.db.get("assignments", assignmentId);
  if (!assignment) return null;
  const rows = await ctx.db
    .query("assignmentSubmissions")
    .withIndex("by_assignment", (q) => q.eq("assignmentId", assignment._id))
    .collect();
  return {
    _id: assignment._id,
    kind: assignment.kind,
    title: assignment.title,
    status: assignment.status,
    dueAt: assignment.dueAt,
    startAt: assignment.startAt,
    endAt: assignment.endAt,
    location: assignment.location,
    requiresSubmission: assignment.requiresSubmission,
    assigneeCount: rows.length,
    doneCount: rows.filter((r) => r.status === "submitted" || r.status === "approved").length,
    myStatus: rows.find((r) => r.assigneeId === viewerId)?.status ?? null,
    ended: assignment.kind === "event" && eventEnd(assignment) <= Date.now(),
  };
}

async function docCard(ctx: QueryCtx, documentId: Id<"documents">): Promise<DocCardView | null> {
  const doc = await ctx.db.get("documents", documentId);
  return doc ? { _id: doc._id, title: doc.title, updatedAt: doc.updatedAt } : null;
}

async function aiView(
  ctx: QueryCtx,
  viewerId: Id<"users">,
  viewer: () => Promise<ViewerContext | null>,
  message: Doc<"messages">,
): Promise<AiView | undefined> {
  if (message.kind !== "ai" || !message.ai) return undefined;
  const view: AiView = {
    status: message.ai.status,
    notice: message.ai.notice,
    requestId: message.ai.requestId,
    actorId: message.ai.actorId,
  };
  const request = message.ai.requestId ? await ctx.db.get("aiRequests", message.ai.requestId) : null;
  if (request) view.askerId = request.userId;
  if (message.ai.status === "refused" && request) {
    const appeal = await ctx.db
      .query("aiAppeals")
      .withIndex("by_request", (q) => q.eq("requestId", request._id))
      .first();
    view.appeal = {
      status: appeal?.status ?? "none",
      canAppeal:
        !appeal &&
        request.userId === viewerId &&
        request.status === "refused" &&
        Date.now() - request._creationTime <= LIMITS.aiAppealWindowMs,
    };
  }
  if (message.ai.suggestionId) {
    const suggestion = await ctx.db.get("aiSuggestions", message.ai.suggestionId);
    if (!suggestion) {
      view.suggestion = null;
    } else {
      const assignment = suggestion.assignmentId ? await ctx.db.get("assignments", suggestion.assignmentId) : null;
      const context = await viewer();
      view.suggestion = {
        _id: suggestion._id,
        action: suggestion.action,
        status: suggestion.status,
        assignmentId: suggestion.assignmentId,
        assignmentTitle: assignment?.title,
        fields: suggestion.fields,
        canAct: context ? await canActOnSuggestion(ctx, context, suggestion) : false,
      };
    }
  }
  return view;
}

export async function toMessageViews(
  ctx: QueryCtx,
  viewerId: Id<"users">,
  messages: Doc<"messages">[],
): Promise<MessageView[]> {
  let viewerCache: ViewerContext | null | undefined;
  const viewer = async () => {
    if (viewerCache === undefined) {
      const user = await ctx.db.get("users", viewerId);
      viewerCache = user ? await buildViewerContext(ctx, user) : null;
    }
    return viewerCache;
  };
  const isAdmin = async () => (await viewer())?.isAdmin ?? false;
  const views: MessageView[] = [];
  for (const message of messages) {
    const people = new Set<string>([message.authorId]);
    const state = messageState(message);
    if (message.removedBy) people.add(message.removedBy);
    for (const id of mentionIds(message.body)) people.add(id);

    const reactionRows = await ctx.db
      .query("messageReactions")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .collect();
    const byEmoji = new Map<string, Id<"users">[]>();
    for (const row of reactionRows) {
      byEmoji.set(row.emoji, [...(byEmoji.get(row.emoji) ?? []), row.userId]);
      people.add(row.userId);
    }
    const reactions = [...byEmoji.entries()].map(([emoji, userIds]) => ({
      emoji,
      count: userIds.length,
      mine: userIds.includes(viewerId),
      userIds,
    }));

    let replyTo: ReplyView | undefined;
    if (message.replyToId) {
      const original = await ctx.db.get("messages", message.replyToId);
      if (original) people.add(original.authorId);
      for (const id of original ? mentionIds(original.body) : []) people.add(id);
      replyTo = original
        ? {
            _id: original._id,
            authorId: original.authorId,
            body: messageState(original) === "normal" ? original.body.slice(0, 200) : "",
            state: messageState(original),
          }
        : { _id: message.replyToId, authorId: null, body: "", state: "missing" };
    }

    const attachmentRows = await ctx.db
      .query("attachments")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .collect();

    const system = message.system
      ? { event: message.system.event, params: (message.system.params ?? {}) as Record<string, unknown> }
      : undefined;
    const departments: DepartmentName[] = [];
    for (const value of Object.values(system?.params ?? {})) {
      for (const id of Array.isArray(value) ? value : [value]) {
        if (typeof id !== "string") continue;
        if (ctx.db.normalizeId("users", id)) people.add(id);
        const departmentId = ctx.db.normalizeId("departments", id);
        const department = departmentId ? await ctx.db.get("departments", departmentId) : null;
        if (department) departments.push({ _id: department._id, nameZh: department.nameZh, nameEn: department.nameEn });
      }
    }

    const ai = state === "normal" ? await aiView(ctx, viewerId, viewer, message) : undefined;
    if (ai?.askerId) people.add(ai.askerId);
    if (ai?.actorId) people.add(ai.actorId);
    for (const id of ai?.suggestion?.fields.assigneeIds ?? []) people.add(id);
    const aiDocuments: DocCardView[] = [];
    if (state === "normal") {
      for (const id of message.aiDocumentIds ?? []) {
        const card = await docCard(ctx, id);
        if (card) aiDocuments.push(card);
      }
    }

    const forward =
      message.forward && state === "normal"
        ? await forwardView(ctx, message.forward as ForwardSnapshot, people)
        : undefined;

    const summaries = await getUserSummaries(
      ctx,
      [...people].flatMap((id) => {
        const userId = ctx.db.normalizeId("users", id);
        return userId ? [userId] : [];
      }),
    );

    views.push({
      _id: message._id,
      _creationTime: message._creationTime,
      kind: message.kind ?? "user",
      authorId: message.authorId,
      body: state === "normal" ? message.body : "",
      state,
      announcement: message.announcement === true,
      editedAt: message.editedAt,
      removedBy: message.removedBy,
      replyTo,
      reactions,
      attachments: await attachmentViews(ctx, attachmentRows),
      system,
      forward,
      files: state === "normal" ? await sharedFileViews(ctx, message.fileIds ?? [], isAdmin) : [],
      task: message.assignmentId ? await taskCard(ctx, message.assignmentId, viewerId) : undefined,
      doc: message.documentId ? await docCard(ctx, message.documentId) : undefined,
      ai,
      aiDocuments: aiDocuments.length > 0 ? aiDocuments : undefined,
      people: [...summaries.values()],
      departments,
    });
  }
  return views;
}
