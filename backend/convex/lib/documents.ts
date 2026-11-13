import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";
import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { channelAccess, channelAudience, explicitMembers, presidiumUserIds, type ChannelAccess } from "./channels";
import { LIMITS } from "./constants";
import { snapshotText } from "./docText";
import { appError } from "./errors";
import { inTaskFolder, loadSpace, spaceAccess, type Space, type SpaceAccess } from "./files";
import { notifyMany } from "./notify";
import { buildViewerContext, requireApproved, type ViewerContext } from "./permissions";
import { taskAccess, type TaskAccess } from "./tasks";

export const prosemirrorSync = new ProsemirrorSync(components.prosemirrorSync);

export const EMPTY_DOC = { type: "doc", content: [] };

export function docLink(documentId: Id<"documents">) {
  return `/docs/?d=${documentId}`;
}

export type DocParent =
  | { kind: "task"; assignment: Doc<"assignments">; access: TaskAccess }
  | { kind: "chat"; channel: Doc<"channels">; access: ChannelAccess }
  | { kind: "file"; file: Doc<"files">; space: Space; access: SpaceAccess };

export type DocumentAccess = {
  viewer: ViewerContext;
  doc: Doc<"documents">;
  parent: DocParent;
  canEdit: boolean;
  canDelete: boolean;
};

/** Task documents: reviewers and assignees (or helpers) edit until the task is closed. */
export function taskDocsEditable(assignment: Doc<"assignments">, access: TaskAccess) {
  return assignment.status !== "closed" && (access.review || access.submission !== null);
}

/** Chat documents: participants of a writable chat edit; 全体 has none. */
export function chatDocsEditable(access: ChannelAccess) {
  return access.via === "member" && access.canInteract;
}

/**
 * Who can read and edit a document, following its parent:
 * - task: anyone who can see the task reads; see `taskDocsEditable`.
 * - chat: anyone who can read the chat; see `chatDocsEditable`. The author, group managers and 主席团 delete.
 * - file: anyone who can see the space reads; uploaders of the space edit; like other files, the creator
 *   and the space's managers rename and delete (to the trash).
 */
export async function documentAccessFor(ctx: QueryCtx, viewer: ViewerContext, id: string): Promise<DocumentAccess> {
  const documentId = ctx.db.normalizeId("documents", id);
  const doc = documentId ? await ctx.db.get("documents", documentId) : null;
  if (!doc) throw appError("NOT_FOUND");
  const me = viewer.user._id;

  if (doc.assignmentId) {
    const assignment = await ctx.db.get("assignments", doc.assignmentId);
    if (!assignment) throw appError("NOT_FOUND");
    const access = await taskAccess(ctx, viewer, assignment);
    if (!access) throw appError("NOT_FOUND");
    const canEdit = taskDocsEditable(assignment, access);
    return {
      viewer,
      doc,
      parent: { kind: "task", assignment, access },
      canEdit,
      canDelete: canEdit && (access.review || doc.createdBy === me),
    };
  }

  if (doc.channelId) {
    const channel = await ctx.db.get("channels", doc.channelId);
    if (!channel) throw appError("NOT_FOUND");
    const access = await channelAccess(ctx, viewer, channel);
    if (!access.via) throw appError("NOT_FOUND");
    const canEdit = chatDocsEditable(access);
    return {
      viewer,
      doc,
      parent: { kind: "chat", channel, access },
      canEdit,
      canDelete: (canEdit && (doc.createdBy === me || access.canManage)) || access.canModerate,
    };
  }

  if (doc.fileId) {
    const file = await ctx.db.get("files", doc.fileId);
    if (!file || file.deletedAt) throw appError("NOT_FOUND");
    const space = await loadSpace(ctx, file.departmentId);
    const access = spaceAccess(viewer, space.department);
    if (!access.view) throw appError("NOT_FOUND");
    const own = file.uploadedBy === me && (access.upload || (await inTaskFolder(ctx, file.folderId)));
    const canDelete = access.manage || own;
    return {
      viewer,
      doc,
      parent: { kind: "file", file, space, access },
      canEdit: access.upload || canDelete,
      canDelete,
    };
  }

  throw appError("NOT_FOUND");
}

/** `documentAccessFor`, or null when the viewer can't open the document. */
export async function tryDocumentAccess(ctx: QueryCtx, viewer: ViewerContext, id: string) {
  try {
    return await documentAccessFor(ctx, viewer, id);
  } catch {
    return null;
  }
}

export async function canReadDocument(ctx: QueryCtx, viewer: ViewerContext, id: string) {
  return (await tryDocumentAccess(ctx, viewer, id)) !== null;
}

export async function documentAccess(ctx: QueryCtx, id: string) {
  return documentAccessFor(ctx, await requireApproved(ctx), id);
}

/** People who can be @mentioned in the document: whoever can open it. */
export async function mentionableIds(ctx: QueryCtx, parent: DocParent): Promise<Id<"users">[]> {
  const ids = new Set<Id<"users">>();
  if (parent.kind === "task") {
    if (parent.access.channel) for (const id of await channelAudience(ctx, parent.access.channel)) ids.add(id);
    const rows = await ctx.db
      .query("assignmentSubmissions")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", parent.assignment._id))
      .collect();
    for (const row of rows) ids.add(row.assigneeId);
    ids.add(parent.assignment.createdBy);
  } else if (parent.kind === "chat") {
    for (const id of await channelAudience(ctx, parent.channel)) ids.add(id);
  } else if (parent.space.department?.kind === "presidium") {
    for (const id of await presidiumUserIds(ctx)) ids.add(id);
  } else {
    const users = await ctx.db
      .query("users")
      .withIndex("by_status", (q) => q.eq("status", "approved"))
      .collect();
    for (const user of users) ids.add(user._id);
  }
  return [...ids];
}

/** The chat a task or chat document belongs to, named for display (DMs use the other person's name). */
export async function chatSummary(ctx: QueryCtx, channel: Doc<"channels">, viewerId: Id<"users">) {
  let nameZh: string | undefined;
  let nameEn: string | undefined;
  if (channel.departmentId) {
    const department = await ctx.db.get("departments", channel.departmentId);
    nameZh = department?.nameZh;
    nameEn = department?.nameEn;
  } else if (channel.type === "dm") {
    const otherId = (await explicitMembers(ctx, channel)).find((r) => r.userId !== viewerId)?.userId;
    const other = otherId ? await ctx.db.get("users", otherId) : null;
    nameZh = other?.nameZh || other?.nameEn || other?.name;
    nameEn = other?.nameEn || other?.nameZh || other?.name;
  }
  return { _id: channel._id, type: channel.type, name: channel.name, nameZh, nameEn };
}

/** User ids of the mention nodes in a ProseMirror JSON snapshot. */
export function snapshotMentionIds(snapshot: string): string[] {
  const ids = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 200) return;
    const n = node as { type?: unknown; attrs?: { id?: unknown }; content?: unknown };
    if (n.type === "mention" && typeof n.attrs?.id === "string") ids.add(n.attrs.id);
    if (Array.isArray(n.content)) for (const child of n.content) walk(child, depth + 1);
  };
  try {
    walk(JSON.parse(snapshot), 0);
  } catch {
    return [];
  }
  return [...ids];
}

/**
 * On each saved snapshot: notifies people newly mentioned since the last save, if they can open the
 * document, and remembers who is mentioned now.
 */
export async function recordDocumentMentions(ctx: MutationCtx, access: DocumentAccess, snapshot: string) {
  const { doc, viewer } = access;
  const current: Id<"users">[] = [];
  for (const id of snapshotMentionIds(snapshot)) {
    const userId = ctx.db.normalizeId("users", id);
    if (userId) current.push(userId);
  }
  const previous = new Set(doc.mentionedIds ?? []);
  const fresh = current
    .filter((id) => !previous.has(id) && id !== viewer.user._id)
    .slice(0, LIMITS.documentMentionsPerSave);
  const recipients: Id<"users">[] = [];
  for (const userId of fresh) {
    const user = await ctx.db.get("users", userId);
    if (!user || user.status !== "approved") continue;
    if (await canReadDocument(ctx, await buildViewerContext(ctx, user), doc._id)) recipients.push(userId);
  }
  await notifyMany(ctx, recipients, {
    type: "doc_mention",
    params: { actorId: viewer.user._id, title: doc.title, documentId: doc._id },
    link: docLink(doc._id),
  });
  const same = current.length === previous.size && current.every((id) => previous.has(id));
  if (!same) await ctx.db.patch("documents", doc._id, { mentionedIds: current.slice(0, 200) });
}

/** The document's plain text for 小飒; documents saved before `text` existed fall back to the latest snapshot. */
export async function documentText(ctx: QueryCtx, doc: Doc<"documents">): Promise<string> {
  if (doc.text !== undefined) return doc.text;
  const snapshot = await ctx.runQuery(components.prosemirrorSync.lib.getSnapshot, { id: doc._id });
  return snapshotText(snapshot.content);
}

/**
 * Whether everyone who can read `channel` can also open the document, so 小飒 may use it in a shared chat:
 * the chat's own documents, documents of the chat's tasks, and Files documents outside the 主席团 space.
 */
export async function docSharedIn(ctx: QueryCtx, doc: Doc<"documents">, channel: Doc<"channels">) {
  if (doc.channelId) return doc.channelId === channel._id;
  if (doc.assignmentId) {
    const assignment = await ctx.db.get("assignments", doc.assignmentId);
    return assignment?.channelId === channel._id && assignment.status !== "draft";
  }
  if (doc.fileId) {
    const file = await ctx.db.get("files", doc.fileId);
    if (!file || file.deletedAt) return false;
    const space = await loadSpace(ctx, file.departmentId);
    return space.department?.kind !== "presidium";
  }
  return false;
}

/** Deletes a document row and its content. */
export async function deleteDocument(ctx: MutationCtx, documentId: Id<"documents">) {
  const summary = await ctx.db
    .query("aiDocSummaries")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .unique();
  if (summary) await ctx.db.delete("aiDocSummaries", summary._id);
  const drafts = await ctx.db
    .query("aiDocDrafts")
    .withIndex("by_document_user", (q) => q.eq("documentId", documentId))
    .collect();
  for (const draft of drafts) await ctx.db.delete("aiDocDrafts", draft._id);
  await ctx.db.delete("documents", documentId);
  await ctx.runMutation(components.prosemirrorSync.lib.deleteDocument, { id: documentId });
}

/** Deletes a task's documents and their content (draft deletion). */
export async function deleteTaskDocuments(ctx: MutationCtx, assignmentId: Id<"assignments">) {
  const docs = await ctx.db
    .query("documents")
    .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
    .collect();
  for (const doc of docs) await deleteDocument(ctx, doc._id);
}
