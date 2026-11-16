import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { logAudit } from "./lib/audit";
import { requireChannelAccess } from "./lib/channels";
import { LIMITS, PUBLIC_SPACE, type ErrorCode } from "./lib/constants";
import { appError } from "./lib/errors";
import {
  breadcrumb,
  chargeQuota,
  cleanName,
  descendantFolders,
  ensureTaskFolder,
  filesIn,
  inTaskFolder,
  isBlockedFile,
  listChildren,
  loadSpace,
  purgeFile,
  requireFolder,
  requireSpace,
  spaceAccess,
  spaceKey,
  spaceUsage,
  trashFolderTree,
  uniqueName,
  type Space,
  type SpaceAccess,
} from "./lib/files";
import { requireAdmin, requireApproved, type ViewerContext } from "./lib/permissions";
import { taskAccess } from "./lib/tasks";
import { getUserSummaries, type UserSummary } from "./lib/users";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

export type SpaceView = {
  key: string;
  departmentId: Id<"departments"> | null;
  kind: "public" | "presidium" | "regular";
  nameZh: string;
  nameEn: string;
  archived: boolean;
  access: SpaceAccess;
  usedBytes: number;
  quotaBytes: number;
};

export type FileView = {
  _id: Id<"files">;
  _creationTime: number;
  name: string;
  size: number;
  contentType: string;
  isImage: boolean;
  /** Kept in Google Drive: anyone with the link can open it. */
  drive: boolean;
  /** A collaborative document: opens in the editor instead of downloading. */
  documentId: Id<"documents"> | null;
  /** Direct download. */
  url: string | null;
  /** For the preview dialog (an iframe for Drive files). */
  previewUrl: string | null;
  /** Opens the file in a new tab. */
  openUrl: string | null;
  thumbUrl: string | null;
  uploadedBy: UserSummary | null;
  folderId: Id<"folders"> | null;
  canEdit: boolean;
};

export type FolderView = {
  _id: Id<"folders">;
  _creationTime: number;
  name: string;
  isTaskFolder: boolean;
  assignmentId: Id<"assignments"> | null;
};

async function spaceView(ctx: QueryCtx, viewer: ViewerContext, space: Space): Promise<SpaceView> {
  const { usedBytes, quotaBytes } = await spaceUsage(ctx, space.departmentId);
  const d = space.department;
  return {
    key: spaceKey(d),
    departmentId: space.departmentId ?? null,
    kind: d ? d.kind : "public",
    nameZh: d?.nameZh ?? "公共",
    nameEn: d?.nameEn ?? "Public",
    archived: d?.archivedAt !== undefined,
    access: spaceAccess(viewer, d),
    usedBytes,
    quotaBytes,
  };
}

/** Uploaders edit their own files where they can upload (or in task folders); managers edit everything. */
function canEditFile(viewer: ViewerContext, access: SpaceAccess, file: Doc<"files">, taskFolder: boolean) {
  return access.manage || (file.uploadedBy === viewer.user._id && (access.upload || taskFolder));
}

async function fileViews(
  ctx: QueryCtx,
  viewer: ViewerContext,
  access: SpaceAccess,
  files: Doc<"files">[],
  taskFolder: (file: Doc<"files">) => Promise<boolean>,
): Promise<FileView[]> {
  const people = await getUserSummaries(ctx, files.map((f) => f.uploadedBy));
  const views: FileView[] = [];
  for (const file of files) {
    const isImage = IMAGE_TYPES.has(file.contentType);
    const drive = file.driveFileId;
    const url = drive
      ? `https://drive.google.com/uc?export=download&id=${drive}`
      : file.storageId
        ? await ctx.storage.getUrl(file.storageId)
        : null;
    views.push({
      _id: file._id,
      _creationTime: file._creationTime,
      name: file.name,
      size: file.size,
      contentType: file.contentType,
      isImage,
      drive: drive !== undefined,
      documentId: file.documentId ?? null,
      url,
      previewUrl: drive ? `https://drive.google.com/file/d/${drive}/preview` : url,
      openUrl: drive ? `https://drive.google.com/file/d/${drive}/view` : url,
      thumbUrl: drive
        ? isImage
          ? `https://drive.google.com/thumbnail?id=${drive}&sz=w400`
          : null
        : file.thumbStorageId
          ? await ctx.storage.getUrl(file.thumbStorageId)
          : null,
      uploadedBy: people.get(file.uploadedBy) ?? null,
      folderId: file.folderId ?? null,
      canEdit: canEditFile(viewer, access, file, await taskFolder(file)),
    });
  }
  return views;
}

export async function toFileViews(ctx: QueryCtx, viewer: ViewerContext, files: Doc<"files">[]) {
  const views: FileView[] = [];
  for (const file of files) {
    const { department } = await loadSpace(ctx, file.departmentId);
    const access = spaceAccess(viewer, department);
    views.push(...(await fileViews(ctx, viewer, access, [file], (f) => inTaskFolder(ctx, f.folderId))));
  }
  return views;
}

function folderView(folder: Doc<"folders">): FolderView {
  return {
    _id: folder._id,
    _creationTime: folder._creationTime,
    name: folder.name,
    isTaskFolder: folder.assignmentId !== undefined || folder.tasksRoot === true,
    assignmentId: folder.assignmentId ?? null,
  };
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "zh-Hans-CN");

export const listSpaces = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireApproved(ctx);
    const departments = (await ctx.db.query("departments").collect()).sort((a, b) => a.sortOrder - b.sortOrder);
    const spaces: Space[] = [
      { departmentId: undefined, department: null },
      ...departments.map((d) => ({ departmentId: d._id, department: d })),
    ];
    const views: SpaceView[] = [];
    for (const space of spaces) {
      const view = await spaceView(ctx, viewer, space);
      if (view.access.view) views.push(view);
    }
    // Spaces the viewer can upload to come first; archived ones last.
    const rank = (s: SpaceView) => (s.archived ? 2 : s.access.upload ? 0 : 1);
    return views.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(({ s }) => s);
  },
});

export const listFolder = query({
  args: { space: v.string(), folderId: v.optional(v.id("folders")) },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const space = await requireSpaceOrNull(ctx, viewer, args.space);
    if (!space) return null;
    const { space: s, access } = space;
    let folder: Doc<"folders"> | null = null;
    if (args.folderId) {
      folder = await ctx.db.get("folders", args.folderId);
      if (!folder || folder.deletedAt || folder.departmentId !== s.departmentId) return null;
    }
    const trail = await breadcrumb(ctx, folder?._id);
    const taskFolder = trail.some((f) => f.assignmentId !== undefined);
    const { folders, files } = await listChildren(ctx, s.departmentId, folder?._id);
    return {
      space: await spaceView(ctx, viewer, s),
      folder: folder ? folderView(folder) : null,
      breadcrumb: trail.map(folderView),
      folders: folders.sort(byName).map(folderView),
      files: await fileViews(ctx, viewer, access, files.sort(byName), async () => taskFolder),
    };
  },
});

async function requireSpaceOrNull(ctx: QueryCtx, viewer: ViewerContext, key: string) {
  try {
    return await requireSpace(ctx, viewer, key);
  } catch {
    return null;
  }
}

/** One file with its space and folder trail, or null when it's gone or hidden. */
export const get = query({
  args: { fileId: v.id("files") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const file = await ctx.db.get("files", args.fileId);
    if (!file || file.deletedAt) return null;
    const space = await loadSpace(ctx, file.departmentId);
    const access = spaceAccess(viewer, space.department);
    if (!access.view) return null;
    const trail = await breadcrumb(ctx, file.folderId);
    const taskFolder = trail.some((f) => f.assignmentId !== undefined);
    const [view] = await fileViews(ctx, viewer, access, [file], async () => taskFolder);
    return { file: view, space: await spaceView(ctx, viewer, space), breadcrumb: trail.map(folderView) };
  },
});

/** File names containing the query, across every space the viewer can see. */
export const search = query({
  args: { query: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const needle = args.query.trim().toLowerCase();
    if (!needle) return [];
    const live = await ctx.db
      .query("files")
      .withIndex("by_deletedAt", (q) => q.eq("deletedAt", undefined))
      .collect();
    const results: { file: Doc<"files">; space: SpaceView }[] = [];
    const spaces = new Map<string, SpaceView>();
    for (const file of live) {
      if (!file.name.toLowerCase().includes(needle)) continue;
      const key = file.departmentId ?? PUBLIC_SPACE;
      if (!spaces.has(key)) spaces.set(key, await spaceView(ctx, viewer, await loadSpace(ctx, file.departmentId)));
      const space = spaces.get(key)!;
      if (!space.access.view) continue;
      results.push({ file, space });
      if (results.length >= LIMITS.fileSearchResults) break;
    }
    const views = await toFileViews(
      ctx,
      viewer,
      results.map((r) => r.file),
    );
    return views.map((file, i) => ({ file, space: results[i].space }));
  },
});

/** Items deleted in the last 30 days, showing only what was deleted (not the contents of deleted folders). */
export const listTrash = query({
  args: { space: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { space, access } = await requireSpace(ctx, viewer, args.space);
    if (!access.manage) throw appError("FORBIDDEN");
    const [folders, files] = await Promise.all([
      ctx.db
        .query("folders")
        .withIndex("by_deletedAt", (q) => q.gt("deletedAt", 0))
        .collect(),
      ctx.db
        .query("files")
        .withIndex("by_deletedAt", (q) => q.gt("deletedAt", 0))
        .collect(),
    ]);
    const parentDeletedAt = async (folderId: Id<"folders"> | undefined) =>
      folderId ? (await ctx.db.get("folders", folderId))?.deletedAt : undefined;
    const trashedFolders = [];
    for (const folder of folders) {
      if (folder.departmentId !== space.departmentId) continue;
      if ((await parentDeletedAt(folder.parentId)) === folder.deletedAt) continue;
      trashedFolders.push(folder);
    }
    const trashedFiles = [];
    for (const file of files) {
      if (file.departmentId !== space.departmentId) continue;
      if ((await parentDeletedAt(file.folderId)) === file.deletedAt) continue;
      trashedFiles.push(file);
    }
    const people = await getUserSummaries(ctx, [
      ...trashedFolders.flatMap((f) => (f.deletedBy ? [f.deletedBy] : [])),
      ...trashedFiles.flatMap((f) => (f.deletedBy ? [f.deletedBy] : [])),
    ]);
    const purgeAt = (deletedAt: number) => deletedAt + LIMITS.trashDays * 24 * 60 * 60 * 1000;
    return {
      folders: trashedFolders.map((f) => ({
        ...folderView(f),
        deletedAt: f.deletedAt!,
        purgeAt: purgeAt(f.deletedAt!),
        deletedBy: f.deletedBy ? (people.get(f.deletedBy) ?? null) : null,
      })),
      files: trashedFiles.map((f) => ({
        _id: f._id,
        name: f.name,
        size: f.size,
        contentType: f.contentType,
        deletedAt: f.deletedAt!,
        purgeAt: purgeAt(f.deletedAt!),
        deletedBy: f.deletedBy ? (people.get(f.deletedBy) ?? null) : null,
      })),
    };
  },
});

async function requireManage(ctx: QueryCtx, viewer: ViewerContext, departmentId: Id<"departments"> | undefined) {
  const space = await loadSpace(ctx, departmentId);
  const access = spaceAccess(viewer, space.department);
  if (!access.manage) throw appError("FORBIDDEN");
  return space;
}

export const createFolder = mutation({
  args: { space: v.string(), parentId: v.optional(v.id("folders")), name: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { space, access } = await requireSpace(ctx, viewer, args.space);
    if (!access.manage) throw appError("FORBIDDEN");
    if (args.parentId) await requireFolder(ctx, space.departmentId, args.parentId);
    const name = await uniqueName(ctx, {
      departmentId: space.departmentId,
      parentId: args.parentId,
      name: cleanName(args.name, LIMITS.folderName),
      kind: "folder",
    });
    return await ctx.db.insert("folders", {
      name,
      departmentId: space.departmentId,
      parentId: args.parentId,
      createdBy: viewer.user._id,
    });
  },
});

export const renameFolder = mutation({
  args: { folderId: v.id("folders"), name: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const folder = await ctx.db.get("folders", args.folderId);
    if (!folder || folder.deletedAt) throw appError("NOT_FOUND");
    await requireManage(ctx, viewer, folder.departmentId);
    const name = await uniqueName(ctx, {
      departmentId: folder.departmentId,
      parentId: folder.parentId,
      name: cleanName(args.name, LIMITS.folderName),
      kind: "folder",
      excludeId: folder._id,
    });
    await ctx.db.patch("folders", folder._id, { name });
  },
});

export const moveFolder = mutation({
  args: { folderId: v.id("folders"), parentId: v.optional(v.id("folders")) },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const folder = await ctx.db.get("folders", args.folderId);
    if (!folder || folder.deletedAt) throw appError("NOT_FOUND");
    await requireManage(ctx, viewer, folder.departmentId);
    if (args.parentId) {
      await requireFolder(ctx, folder.departmentId, args.parentId);
      const trail = await breadcrumb(ctx, args.parentId);
      if (trail.some((f) => f._id === folder._id)) throw appError("INVALID", "parentId");
    }
    const name = await uniqueName(ctx, {
      departmentId: folder.departmentId,
      parentId: args.parentId,
      name: folder.name,
      kind: "folder",
      excludeId: folder._id,
    });
    await ctx.db.patch("folders", folder._id, { parentId: args.parentId, name });
  },
});

export const removeFolder = mutation({
  args: { folderId: v.id("folders") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const folder = await ctx.db.get("folders", args.folderId);
    if (!folder || folder.deletedAt) throw appError("NOT_FOUND");
    await requireManage(ctx, viewer, folder.departmentId);
    await trashFolderTree(ctx, folder, viewer.user._id);
  },
});

export const restoreFolder = mutation({
  args: { folderId: v.id("folders") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const folder = await ctx.db.get("folders", args.folderId);
    if (!folder || !folder.deletedAt) throw appError("NOT_FOUND");
    await requireManage(ctx, viewer, folder.departmentId);
    const at = folder.deletedAt;
    const restored = { deletedAt: undefined, deletedBy: undefined };
    // A folder whose parent is gone comes back at the top of the space.
    const parent = folder.parentId ? await ctx.db.get("folders", folder.parentId) : null;
    const parentId = parent && !parent.deletedAt ? parent._id : undefined;
    const name = await uniqueName(ctx, { departmentId: folder.departmentId, parentId, name: folder.name, kind: "folder" });
    await ctx.db.patch("folders", folder._id, { ...restored, parentId, name });
    for (const f of [folder, ...(await descendantFolders(ctx, folder))]) {
      if (f._id !== folder._id && f.deletedAt === at) await ctx.db.patch("folders", f._id, restored);
      for (const file of await filesIn(ctx, f.departmentId, f._id)) {
        if (file.deletedAt === at) await ctx.db.patch("files", file._id, restored);
      }
    }
  },
});

/** Upload rights for a plain space upload, or for the task folder of `assignmentId`. */
export async function uploadTarget(
  ctx: MutationCtx,
  viewer: ViewerContext,
  args: { space?: string; assignmentId?: Id<"assignments"> },
): Promise<{ departmentId: Id<"departments"> | undefined; assignment: Doc<"assignments"> | null }> {
  if (args.assignmentId) {
    const assignment = await ctx.db.get("assignments", args.assignmentId);
    if (!assignment) throw appError("NOT_FOUND");
    const access = await taskAccess(ctx, viewer, assignment);
    if (!access || (!access.review && !access.submission)) throw appError("FORBIDDEN");
    if (assignment.status === "closed") throw appError("INVALID", "closed");
    return { departmentId: assignment.departmentId, assignment };
  }
  const { space, access } = await requireSpace(ctx, viewer, args.space ?? "");
  if (!access.upload) throw appError("FORBIDDEN");
  return { departmentId: space.departmentId, assignment: null };
}

export const generateUploadUrl = mutation({
  args: { space: v.optional(v.string()), assignmentId: v.optional(v.id("assignments")) },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    await uploadTarget(ctx, viewer, args);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Records an upload in a folder (or the task's folder). Size and type come from `_storage`.
 * Anything rejected is deleted from storage right away.
 */
export const save = mutation({
  args: {
    space: v.optional(v.string()),
    folderId: v.optional(v.id("folders")),
    assignmentId: v.optional(v.id("assignments")),
    storageId: v.id("_storage"),
    thumbStorageId: v.optional(v.id("_storage")),
    name: v.string(),
  },
  handler: async (ctx, args): Promise<SaveResult> => {
    const viewer = await requireApproved(ctx);
    const stored = await ctx.db.system.get("_storage", args.storageId);
    if (!stored) throw appError("NOT_FOUND");
    const thumb = args.thumbStorageId ? await ctx.db.system.get("_storage", args.thumbStorageId) : null;
    const contentType = stored.contentType ?? "application/octet-stream";
    try {
      const name = cleanName(args.name, LIMITS.fileName);
      if (stored.size > LIMITS.fileBytes) throw appError("FILE_TOO_LARGE");
      if (isBlockedFile(name, contentType)) throw appError("FILE_TYPE_BLOCKED");
      if (thumb && (thumb.size > LIMITS.thumbnailBytes || !thumb.contentType?.startsWith("image/"))) {
        throw appError("INVALID", "thumbnail");
      }
      const target = await uploadTarget(ctx, viewer, args);
      let folderId = args.folderId;
      if (target.assignment) folderId = await ensureTaskFolder(ctx, target.assignment, viewer.user._id);
      else if (folderId) await requireFolder(ctx, target.departmentId, folderId);
      await chargeQuota(ctx, target.departmentId, stored.size);
      const fileId = await ctx.db.insert("files", {
        storageId: args.storageId,
        thumbStorageId: thumb?._id,
        name: await uniqueName(ctx, { departmentId: target.departmentId, parentId: folderId, name, kind: "file" }),
        contentType,
        size: stored.size,
        departmentId: target.departmentId,
        folderId,
        uploadedBy: viewer.user._id,
      });
      return { ok: true, fileId };
    } catch (error) {
      // Throwing would roll back the deletes, so rejected uploads are reported as a result instead.
      if (!(error instanceof ConvexError)) throw error;
      const data = error.data as { code: ErrorCode; message?: string };
      await ctx.storage.delete(args.storageId);
      if (thumb) await ctx.storage.delete(thumb._id);
      return { ok: false, code: data.code, message: data.message ?? data.code };
    }
  },
});

export type SaveResult = { ok: true; fileId: Id<"files"> } | { ok: false; code: ErrorCode; message: string };

async function requireEditableFile(ctx: QueryCtx, viewer: ViewerContext, fileId: Id<"files">) {
  const file = await ctx.db.get("files", fileId);
  if (!file) throw appError("NOT_FOUND");
  const space = await loadSpace(ctx, file.departmentId);
  const access = spaceAccess(viewer, space.department);
  if (!access.view) throw appError("NOT_FOUND");
  if (!canEditFile(viewer, access, file, await inTaskFolder(ctx, file.folderId))) throw appError("FORBIDDEN");
  return { file, access };
}

export const rename = mutation({
  args: { fileId: v.id("files"), name: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { file } = await requireEditableFile(ctx, viewer, args.fileId);
    if (file.deletedAt) throw appError("NOT_FOUND");
    const name = await uniqueName(ctx, {
      departmentId: file.departmentId,
      parentId: file.folderId,
      name: cleanName(args.name, LIMITS.fileName),
      kind: "file",
      excludeId: file._id,
    });
    await ctx.db.patch("files", file._id, { name });
    if (file.documentId) await ctx.db.patch("documents", file.documentId, { title: name });
  },
});

export const move = mutation({
  args: { fileId: v.id("files"), folderId: v.optional(v.id("folders")) },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { file, access } = await requireEditableFile(ctx, viewer, args.fileId);
    if (file.deletedAt) throw appError("NOT_FOUND");
    // Uploaders who can't otherwise upload here (task folders) can't move files out of them.
    if (!access.upload && !access.manage) throw appError("FORBIDDEN");
    if (args.folderId) await requireFolder(ctx, file.departmentId, args.folderId);
    const name = await uniqueName(ctx, {
      departmentId: file.departmentId,
      parentId: args.folderId,
      name: file.name,
      kind: "file",
      excludeId: file._id,
    });
    await ctx.db.patch("files", file._id, { folderId: args.folderId, name });
  },
});

/** Moves a file to the trash; deleting someone else's file is audit logged. Rights are checked by the caller. */
export async function trashFile(ctx: MutationCtx, viewer: ViewerContext, file: Doc<"files">) {
  if (file.deletedAt) return;
  await ctx.db.patch("files", file._id, { deletedAt: Date.now(), deletedBy: viewer.user._id });
  if (file.uploadedBy !== viewer.user._id) {
    await logAudit(ctx, {
      actorId: viewer.user._id,
      action: "file.moderate_delete",
      targetType: "file",
      targetId: file._id,
      subjectUserId: file.uploadedBy,
      metadata: { name: file.name },
    });
  }
}

export const remove = mutation({
  args: { fileId: v.id("files") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { file } = await requireEditableFile(ctx, viewer, args.fileId);
    await trashFile(ctx, viewer, file);
  },
});

export const restore = mutation({
  args: { fileId: v.id("files") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const file = await ctx.db.get("files", args.fileId);
    if (!file || !file.deletedAt) throw appError("NOT_FOUND");
    await requireManage(ctx, viewer, file.departmentId);
    const folder = file.folderId ? await ctx.db.get("folders", file.folderId) : null;
    const folderId = folder && !folder.deletedAt ? folder._id : undefined;
    const name = await uniqueName(ctx, { departmentId: file.departmentId, parentId: folderId, name: file.name, kind: "file" });
    await ctx.db.patch("files", file._id, { deletedAt: undefined, deletedBy: undefined, folderId, name });
  },
});

/** Deletes trashed items for good, freeing their quota right away. */
export const purge = mutation({
  args: { fileId: v.optional(v.id("files")), folderId: v.optional(v.id("folders")) },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    if (args.fileId) {
      const file = await ctx.db.get("files", args.fileId);
      if (!file || !file.deletedAt) throw appError("NOT_FOUND");
      await requireManage(ctx, viewer, file.departmentId);
      await purgeFile(ctx, file);
    }
    if (args.folderId) {
      const folder = await ctx.db.get("folders", args.folderId);
      if (!folder || !folder.deletedAt) throw appError("NOT_FOUND");
      await requireManage(ctx, viewer, folder.departmentId);
      for (const f of [folder, ...(await descendantFolders(ctx, folder))]) {
        if (!f.deletedAt) continue;
        for (const file of await filesIn(ctx, f.departmentId, f._id)) {
          if (file.deletedAt) await purgeFile(ctx, file);
        }
        if ((await listChildren(ctx, f.departmentId, f._id)).files.length === 0) await ctx.db.delete("folders", f._id);
      }
    }
  },
});

/** Save to Files: copies a chat attachment into a folder, sharing the stored object. */
export const saveAttachment = mutation({
  args: { attachmentId: v.id("attachments"), space: v.string(), folderId: v.optional(v.id("folders")) },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const attachment = await ctx.db.get("attachments", args.attachmentId);
    if (!attachment || !attachment.messageId || attachment.expiredAt) throw appError("NOT_FOUND");
    const message = await ctx.db.get("messages", attachment.messageId);
    if (!message) throw appError("NOT_FOUND");
    await requireChannelAccess(ctx, viewer, message.channelId);
    const { space, access } = await requireSpace(ctx, viewer, args.space);
    if (!access.upload) throw appError("FORBIDDEN");
    if (args.folderId) await requireFolder(ctx, space.departmentId, args.folderId);
    if (isBlockedFile(attachment.name, attachment.contentType)) throw appError("FILE_TYPE_BLOCKED");
    await chargeQuota(ctx, space.departmentId, attachment.size);
    return await ctx.db.insert("files", {
      storageId: attachment.storageId,
      thumbStorageId: attachment.thumbStorageId,
      name: await uniqueName(ctx, {
        departmentId: space.departmentId,
        parentId: args.folderId,
        name: attachment.name,
        kind: "file",
      }),
      contentType: attachment.contentType,
      size: attachment.size,
      departmentId: space.departmentId,
      folderId: args.folderId,
      uploadedBy: viewer.user._id,
    });
  },
});

/** Folders of a space the viewer can save or move into, as an indented list. */
export const folderTree = query({
  args: { space: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const space = await requireSpaceOrNull(ctx, viewer, args.space);
    if (!space) return [];
    const result: { _id: Id<"folders">; name: string; depth: number }[] = [];
    const walk = async (parentId: Id<"folders"> | undefined, depth: number) => {
      if (depth > 8 || result.length > 500) return;
      const { folders } = await listChildren(ctx, space.space.departmentId, parentId);
      for (const folder of folders.sort(byName)) {
        result.push({ _id: folder._id, name: folder.name, depth });
        await walk(folder._id, depth + 1);
      }
    };
    await walk(undefined, 0);
    return result;
  },
});

export const setQuota = mutation({
  args: { space: v.string(), quotaBytes: v.number() },
  handler: async (ctx, args) => {
    const viewer = await requireAdmin(ctx);
    const { space } = await requireSpace(ctx, viewer, args.space);
    const quotaBytes = Math.round(args.quotaBytes);
    if (!Number.isFinite(quotaBytes) || quotaBytes < 0 || quotaBytes > LIMITS.maxSpaceQuotaBytes) {
      throw appError("INVALID", "quotaBytes");
    }
    const { row, quotaBytes: previous } = await spaceUsage(ctx, space.departmentId);
    if (row) await ctx.db.patch("fileSpaces", row._id, { quotaBytes });
    else await ctx.db.insert("fileSpaces", { departmentId: space.departmentId, quotaBytes, usedBytes: 0 });
    await logAudit(ctx, {
      actorId: viewer.user._id,
      action: "files.quota_change",
      targetType: "department",
      targetId: space.departmentId ?? PUBLIC_SPACE,
      metadata: { from: previous, to: quotaBytes },
    });
  },
});

/** Daily: permanently delete items trashed more than 30 days ago. */
export const purgeTrash = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - LIMITS.trashDays * 24 * 60 * 60 * 1000;
    const files = await ctx.db
      .query("files")
      .withIndex("by_deletedAt", (q) => q.gt("deletedAt", 0).lt("deletedAt", cutoff))
      .take(LIMITS.purgeBatch);
    for (const file of files) await purgeFile(ctx, file);
    const folders = await ctx.db
      .query("folders")
      .withIndex("by_deletedAt", (q) => q.gt("deletedAt", 0).lt("deletedAt", cutoff))
      .take(LIMITS.purgeBatch);
    for (const folder of folders) {
      const children = await ctx.db
        .query("folders")
        .withIndex("by_space_parent", (q) => q.eq("departmentId", folder.departmentId).eq("parentId", folder._id))
        .first();
      const files = await filesIn(ctx, folder.departmentId, folder._id);
      // Restored children keep their folder; it stays as an empty shell until they move out.
      if (!children && files.length === 0) await ctx.db.delete("folders", folder._id);
    }
    if (files.length === LIMITS.purgeBatch || folders.length === LIMITS.purgeBatch) {
      await ctx.scheduler.runAfter(0, internal.files.purgeTrash, {});
    }
  },
});
