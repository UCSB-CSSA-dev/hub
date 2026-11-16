import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { trashFile } from "./files";
import { channelAccess, requireChannelAccess, touchReadState } from "./lib/channels";
import { DOC_CONTENT_TYPE, LIMITS } from "./lib/constants";
import {
  chatDocsEditable,
  chatSummary,
  deleteDocument,
  documentAccess,
  EMPTY_DOC,
  mentionableIds,
  prosemirrorSync,
  taskDocsEditable,
} from "./lib/documents";
import { appError } from "./lib/errors";
import { cleanName, logFileEvent, requireFolder, requireSpace, spaceKey, uniqueName } from "./lib/files";
import { requireApproved } from "./lib/permissions";
import { taskAccess } from "./lib/tasks";
import { toSearchText } from "./lib/text";
import { getUserSummaries } from "./lib/users";

function cleanTitle(title: string) {
  const cleaned = title.replace(/\s+/g, " ").trim().slice(0, LIMITS.documentTitle);
  if (!cleaned) throw appError("INVALID", "title");
  return cleaned;
}

/** Documents newest edit first, with who edited last. */
async function listView(ctx: QueryCtx, docs: Doc<"documents">[]) {
  const people = await getUserSummaries(
    ctx,
    docs.map((d) => d.updatedBy),
  );
  return docs
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((d) => ({
      _id: d._id,
      title: d.title,
      updatedAt: d.updatedAt,
      updatedBy: people.get(d.updatedBy) ?? null,
    }));
}

/** A task's documents and whether the viewer can add one. */
export const listForTask = query({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const assignment = await ctx.db.get("assignments", args.assignmentId);
    if (!assignment) return null;
    const access = await taskAccess(ctx, viewer, assignment);
    if (!access) return null;
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", assignment._id))
      .collect();
    return {
      canCreate: taskDocsEditable(assignment, access) && docs.length < LIMITS.documentsPerTask,
      documents: await listView(ctx, docs),
    };
  },
});

/** Every chat except 全体 can have shared documents, started by any participant. */
function chatAllowsDocs(channel: Doc<"channels">) {
  return channel.type === "department" || channel.type === "group" || channel.type === "dm";
}

/** A chat's documents and whether the viewer can start one. */
export const listForChat = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const channel = await ctx.db.get("channels", args.channelId);
    if (!channel || !chatAllowsDocs(channel)) return null;
    const access = await channelAccess(ctx, viewer, channel);
    if (!access.via) return null;
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
      .collect();
    return {
      canCreate: access.canPost && chatDocsEditable(access) && docs.length < LIMITS.documentsPerChat,
      documents: await listView(ctx, docs),
    };
  },
});

/** One document's details for the editor page, or null when it's gone or hidden. */
export const get = query({
  args: { documentId: v.string() },
  handler: async (ctx, args) => {
    let found;
    try {
      found = await documentAccess(ctx, args.documentId);
    } catch {
      return null;
    }
    const { doc, parent, viewer, canEdit, canDelete } = found;
    const mentionable = canEdit ? await mentionableIds(ctx, parent) : [];
    const people = await getUserSummaries(ctx, [doc.updatedBy, doc.createdBy, ...mentionable]);

    let parentView;
    if (parent.kind === "task") {
      const a = parent.assignment;
      parentView = { kind: "task" as const, _id: a._id, title: a.title, taskKind: a.kind, status: a.status };
    } else if (parent.kind === "chat") {
      parentView = { kind: "chat" as const, chat: await chatSummary(ctx, parent.channel, viewer.user._id) };
    } else {
      const d = parent.space.department;
      parentView = {
        kind: "file" as const,
        fileId: parent.file._id,
        folderId: parent.file.folderId ?? null,
        spaceKey: spaceKey(d),
        spaceNameZh: d?.nameZh ?? "公共",
        spaceNameEn: d?.nameEn ?? "Public",
      };
    }

    return {
      _id: doc._id,
      title: doc.title,
      updatedAt: doc.updatedAt,
      updatedBy: people.get(doc.updatedBy) ?? null,
      createdBy: people.get(doc.createdBy) ?? null,
      parent: parentView,
      canEdit,
      canDelete,
      /** Who can be @mentioned (only loaded for editors). */
      mentionable: mentionable.flatMap((id) => {
        const person = people.get(id);
        return person && id !== viewer.user._id ? [person] : [];
      }),
    };
  },
});

export const create = mutation({
  args: { assignmentId: v.id("assignments"), title: v.string() },
  handler: async (ctx, args): Promise<Id<"documents">> => {
    const viewer = await requireApproved(ctx);
    const assignment = await ctx.db.get("assignments", args.assignmentId);
    if (!assignment) throw appError("NOT_FOUND");
    const access = await taskAccess(ctx, viewer, assignment);
    if (!access) throw appError("NOT_FOUND");
    if (!taskDocsEditable(assignment, access)) throw appError("FORBIDDEN");
    const existing = await ctx.db
      .query("documents")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", assignment._id))
      .collect();
    if (existing.length >= LIMITS.documentsPerTask) throw appError("INVALID", "tooMany");
    const now = Date.now();
    const documentId = await ctx.db.insert("documents", {
      assignmentId: assignment._id,
      title: cleanTitle(args.title),
      createdBy: viewer.user._id,
      updatedAt: now,
      updatedBy: viewer.user._id,
    });
    await prosemirrorSync.create(ctx, documentId, EMPTY_DOC);
    return documentId;
  },
});

/** Starts a shared document in a chat and posts its card. */
export const createInChat = mutation({
  args: { channelId: v.id("channels"), title: v.string() },
  handler: async (ctx, args): Promise<Id<"documents">> => {
    const viewer = await requireApproved(ctx);
    const { channel, access } = await requireChannelAccess(ctx, viewer, args.channelId);
    if (!chatAllowsDocs(channel)) throw appError("FORBIDDEN");
    if (!access.canPost || !chatDocsEditable(access)) throw appError(access.readOnly ? "READ_ONLY" : "FORBIDDEN");
    const existing = await ctx.db
      .query("documents")
      .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
      .collect();
    if (existing.length >= LIMITS.documentsPerChat) throw appError("INVALID", "tooMany");
    const title = cleanTitle(args.title);
    const now = Date.now();
    const documentId = await ctx.db.insert("documents", {
      channelId: channel._id,
      title,
      createdBy: viewer.user._id,
      updatedAt: now,
      updatedBy: viewer.user._id,
    });
    await prosemirrorSync.create(ctx, documentId, EMPTY_DOC);
    await ctx.db.insert("messages", {
      channelId: channel._id,
      authorId: viewer.user._id,
      body: "",
      kind: "doc",
      documentId,
      searchText: toSearchText(title),
    });
    await ctx.db.patch("channels", channel._id, { lastMessageAt: now });
    await touchReadState(ctx, channel._id, viewer.user._id, now);
    return documentId;
  },
});

/** Creates a document as a file in a folder (Files → New document). */
export const createInFolder = mutation({
  args: { space: v.string(), folderId: v.optional(v.id("folders")), title: v.string() },
  handler: async (ctx, args): Promise<Id<"documents">> => {
    const viewer = await requireApproved(ctx);
    const { space, access } = await requireSpace(ctx, viewer, args.space);
    if (!access.upload) throw appError("FORBIDDEN");
    if (args.folderId) await requireFolder(ctx, space.departmentId, args.folderId);
    const name = await uniqueName(ctx, {
      departmentId: space.departmentId,
      parentId: args.folderId,
      name: cleanName(cleanTitle(args.title), LIMITS.fileName),
      kind: "file",
    });
    const now = Date.now();
    const documentId = await ctx.db.insert("documents", {
      title: name,
      createdBy: viewer.user._id,
      updatedAt: now,
      updatedBy: viewer.user._id,
    });
    const fileId = await ctx.db.insert("files", {
      documentId,
      name,
      contentType: DOC_CONTENT_TYPE,
      size: 0,
      departmentId: space.departmentId,
      folderId: args.folderId,
      uploadedBy: viewer.user._id,
    });
    await ctx.db.patch("documents", documentId, { fileId });
    await logFileEvent(ctx, { fileId, actorId: viewer.user._id, action: "created" });
    await prosemirrorSync.create(ctx, documentId, EMPTY_DOC);
    return documentId;
  },
});

export const rename = mutation({
  args: { documentId: v.id("documents"), title: v.string() },
  handler: async (ctx, args) => {
    const { doc, parent, canEdit, canDelete } = await documentAccess(ctx, args.documentId);
    if (parent.kind !== "file") {
      if (!canEdit) throw appError("FORBIDDEN");
      await ctx.db.patch("documents", doc._id, { title: cleanTitle(args.title) });
      return;
    }
    // Like any file: the creator or a manager renames, and names stay unique in the folder.
    if (!canDelete) throw appError("FORBIDDEN");
    const file = parent.file;
    const name = await uniqueName(ctx, {
      departmentId: file.departmentId,
      parentId: file.folderId,
      name: cleanName(cleanTitle(args.title), LIMITS.fileName),
      kind: "file",
      excludeId: file._id,
    });
    await ctx.db.patch("files", file._id, { name });
    await ctx.db.patch("documents", doc._id, { title: name });
  },
});

/** Task and chat documents are deleted for good; documents in Files go to the trash. */
export const remove = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const { doc, parent, viewer, canDelete } = await documentAccess(ctx, args.documentId);
    if (!canDelete) throw appError("FORBIDDEN");
    if (parent.kind === "file") {
      await trashFile(ctx, viewer, parent.file);
      return { trashed: true };
    }
    await deleteDocument(ctx, doc._id);
    return { trashed: false };
  },
});
