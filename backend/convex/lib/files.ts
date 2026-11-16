import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { BLOCKED_EXTENSIONS, LIMITS, PUBLIC_SPACE } from "./constants";
import { appError } from "./errors";
import { isLeadOf, type ViewerContext } from "./permissions";

export type SpaceAccess = { view: boolean; upload: boolean; manage: boolean };

/** Per-file rights: space rules, owner, grants, and 主席团/部长/系统管理员 read-all. */
export type FilePermission = {
  view: boolean;
  write: boolean;
  /** Uploader (or space manager): can revoke grants and edit the access list. */
  manageAccess: boolean;
  /** Highest level this viewer may grant to someone else. */
  canGrant: "read" | "write" | null;
};

/** A file space: 公共 (no department), 主席团 (the presidium department), or a department. */
export type Space = { departmentId: Id<"departments"> | undefined; department: Doc<"departments"> | null };

const BLOCKED_TYPES = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/vnd.microsoft.portable-executable",
  "application/x-apple-diskimage",
  "application/vnd.android.package-archive",
  "application/x-sh",
]);

/** Who can do what in a space; see doc/features/files.md#spaces. */
export function spaceAccess(viewer: ViewerContext, department: Doc<"departments"> | null): SpaceAccess {
  if (!department) return { view: true, upload: viewer.isAdmin, manage: viewer.isAdmin };
  if (department.kind === "presidium") {
    return { view: viewer.isAdmin, upload: viewer.isAdmin, manage: viewer.isAdmin };
  }
  const writable = !department.archivedAt;
  const manage = writable && (viewer.isAdmin || isLeadOf(viewer, department._id));
  const upload = writable && (manage || viewer.memberDepartmentIds.includes(department._id));
  return { view: true, upload, manage };
}

export function spaceKey(department: Doc<"departments"> | null) {
  return department?.slug ?? PUBLIC_SPACE;
}

export async function loadSpace(ctx: QueryCtx, departmentId: Id<"departments"> | undefined): Promise<Space> {
  return { departmentId, department: departmentId ? await ctx.db.get("departments", departmentId) : null };
}

/** Resolves `?s=` (a department slug, or "public"). */
export async function resolveSpace(ctx: QueryCtx, key: string): Promise<Space | null> {
  if (key === PUBLIC_SPACE) return { departmentId: undefined, department: null };
  const department = await ctx.db
    .query("departments")
    .withIndex("by_slug", (q) => q.eq("slug", key))
    .unique();
  return department ? { departmentId: department._id, department } : null;
}

export async function requireSpace(ctx: QueryCtx, viewer: ViewerContext, key: string) {
  const space = await resolveSpace(ctx, key);
  if (!space) throw appError("NOT_FOUND");
  const access = spaceAccess(viewer, space.department);
  if (!access.view) throw appError("NOT_FOUND");
  return { space, access };
}

export async function spaceUsage(ctx: QueryCtx, departmentId: Id<"departments"> | undefined) {
  const row = await ctx.db
    .query("fileSpaces")
    .withIndex("by_department", (q) => q.eq("departmentId", departmentId))
    .unique();
  return { usedBytes: row?.usedBytes ?? 0, quotaBytes: row?.quotaBytes ?? LIMITS.defaultSpaceQuotaBytes, row };
}

/** Reserves `bytes` of the space's quota, or throws QUOTA_EXCEEDED. */
export async function chargeQuota(ctx: MutationCtx, departmentId: Id<"departments"> | undefined, bytes: number) {
  const { usedBytes, quotaBytes, row } = await spaceUsage(ctx, departmentId);
  if (usedBytes + bytes > quotaBytes) {
    throw appError("QUOTA_EXCEEDED", String(Math.max(0, quotaBytes - usedBytes)));
  }
  if (row) await ctx.db.patch("fileSpaces", row._id, { usedBytes: usedBytes + bytes });
  else await ctx.db.insert("fileSpaces", { departmentId, quotaBytes, usedBytes: bytes });
}

export async function releaseQuota(ctx: MutationCtx, departmentId: Id<"departments"> | undefined, bytes: number) {
  const { row } = await spaceUsage(ctx, departmentId);
  if (row) await ctx.db.patch("fileSpaces", row._id, { usedBytes: Math.max(0, row.usedBytes - bytes) });
}

export function isBlockedFile(name: string, contentType: string) {
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return (BLOCKED_EXTENSIONS as readonly string[]).includes(extension) || BLOCKED_TYPES.has(contentType);
}

export function cleanName(name: string, max: number) {
  // Slashes would confuse breadcrumbs; control characters have no place in a file name.
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  if (!cleaned) throw appError("INVALID", "name");
  return cleaned;
}

function withCounter(name: string, n: number, keepExtension: boolean) {
  const dot = keepExtension ? name.lastIndexOf(".") : -1;
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

async function liveChildren(ctx: QueryCtx, departmentId: Id<"departments"> | undefined, parentId: Id<"folders"> | undefined) {
  const [folders, files] = await Promise.all([
    ctx.db
      .query("folders")
      .withIndex("by_space_parent", (q) => q.eq("departmentId", departmentId).eq("parentId", parentId))
      .collect(),
    ctx.db
      .query("files")
      .withIndex("by_space_folder", (q) => q.eq("departmentId", departmentId).eq("folderId", parentId))
      .collect(),
  ]);
  return { folders: folders.filter((f) => !f.deletedAt), files: files.filter((f) => !f.deletedAt) };
}

export async function listChildren(
  ctx: QueryCtx,
  departmentId: Id<"departments"> | undefined,
  parentId: Id<"folders"> | undefined,
) {
  return liveChildren(ctx, departmentId, parentId);
}

/** Appends " (1)", " (2)"… when the folder already has an item with this name. */
export async function uniqueName(
  ctx: QueryCtx,
  args: {
    departmentId: Id<"departments"> | undefined;
    parentId: Id<"folders"> | undefined;
    name: string;
    kind: "file" | "folder";
    excludeId?: string;
  },
) {
  const { folders, files } = await liveChildren(ctx, args.departmentId, args.parentId);
  const siblings = args.kind === "file" ? files : folders;
  const taken = new Set(siblings.filter((s) => s._id !== args.excludeId).map((s) => s.name.toLowerCase()));
  let name = args.name;
  for (let n = 1; taken.has(name.toLowerCase()); n++) name = withCounter(args.name, n, args.kind === "file");
  return name;
}

/** Live folder in the given space, or NOT_FOUND. */
export async function requireFolder(
  ctx: QueryCtx,
  departmentId: Id<"departments"> | undefined,
  folderId: Id<"folders">,
) {
  const folder = await ctx.db.get("folders", folderId);
  if (!folder || folder.deletedAt || folder.departmentId !== departmentId) throw appError("NOT_FOUND");
  return folder;
}

/** Folders from the top of the space down to `folderId`. */
export async function breadcrumb(ctx: QueryCtx, folderId: Id<"folders"> | undefined) {
  const trail: Doc<"folders">[] = [];
  let current = folderId ? await ctx.db.get("folders", folderId) : null;
  while (current && trail.length < 50) {
    trail.unshift(current);
    current = current.parentId ? await ctx.db.get("folders", current.parentId) : null;
  }
  return trail;
}

/** True when the folder is a task folder or inside one. */
export async function inTaskFolder(ctx: QueryCtx, folderId: Id<"folders"> | undefined) {
  return (await breadcrumb(ctx, folderId)).some((f) => f.assignmentId !== undefined);
}

/** Every folder under `folderId` (not including it), breadth first. */
export async function descendantFolders(ctx: QueryCtx, folder: Doc<"folders">) {
  const result: Doc<"folders">[] = [];
  const queue = [folder];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = await ctx.db
      .query("folders")
      .withIndex("by_space_parent", (q) => q.eq("departmentId", folder.departmentId).eq("parentId", current._id))
      .collect();
    result.push(...children);
    queue.push(...children);
  }
  return result;
}

export async function filesIn(ctx: QueryCtx, departmentId: Id<"departments"> | undefined, folderId: Id<"folders">) {
  return ctx.db
    .query("files")
    .withIndex("by_space_folder", (q) => q.eq("departmentId", departmentId).eq("folderId", folderId))
    .collect();
}

/** Whether the stored object is still used by a file row or a live chat attachment. */
export async function storageInUse(ctx: QueryCtx, storageId: Id<"_storage">) {
  const file = await ctx.db
    .query("files")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (file) return true;
  const attachments = await ctx.db
    .query("attachments")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .collect();
  return attachments.some((a) => !a.expiredAt);
}

/**
 * Deletes a file row for good, frees its quota, and deletes the stored object when nothing else uses it.
 * Drive files don't count toward quota; they go to the Drive trash. Documents lose their content.
 */
export async function purgeFile(ctx: MutationCtx, file: Doc<"files">) {
  const grants = await ctx.db
    .query("fileGrants")
    .withIndex("by_file", (q) => q.eq("fileId", file._id))
    .collect();
  for (const grant of grants) await ctx.db.delete("fileGrants", grant._id);
  const events = await ctx.db
    .query("fileEvents")
    .withIndex("by_file", (q) => q.eq("fileId", file._id))
    .collect();
  for (const event of events) await ctx.db.delete("fileEvents", event._id);
  await ctx.db.delete("files", file._id);
  if (file.documentId) {
    await ctx.db.delete("documents", file.documentId);
    await ctx.runMutation(components.prosemirrorSync.lib.deleteDocument, { id: file.documentId });
    return;
  }
  if (file.driveFileId) {
    await ctx.scheduler.runAfter(0, internal.drive.trashFile, { driveFileId: file.driveFileId });
    return;
  }
  await releaseQuota(ctx, file.departmentId, file.size);
  if (file.storageId && !(await storageInUse(ctx, file.storageId))) {
    await ctx.storage.delete(file.storageId);
    if (file.thumbStorageId) await ctx.storage.delete(file.thumbStorageId);
  }
}

/** Soft-deletes a folder and everything in it with one timestamp, so restore brings back exactly that. */
export async function trashFolderTree(ctx: MutationCtx, folder: Doc<"folders">, actorId: Id<"users">) {
  const deleted = { deletedAt: Date.now(), deletedBy: actorId };
  const folders = [folder, ...(await descendantFolders(ctx, folder))].filter((f) => f._id === folder._id || !f.deletedAt);
  for (const f of folders) {
    await ctx.db.patch("folders", f._id, deleted);
    for (const file of await filesIn(ctx, f.departmentId, f._id)) {
      if (!file.deletedAt) await ctx.db.patch("files", file._id, deleted);
    }
  }
}

/** 主席团, 系统管理员, and any 部长 can read every file (space browse rules still apply separately). */
export function canOversightReadFiles(viewer: ViewerContext) {
  return viewer.isAdmin || viewer.ledDepartmentIds.length > 0;
}

export async function getFileGrant(ctx: QueryCtx, fileId: Id<"files">, userId: Id<"users">) {
  return await ctx.db
    .query("fileGrants")
    .withIndex("by_file_user", (q) => q.eq("fileId", fileId).eq("userId", userId))
    .unique();
}

export async function filePermission(
  ctx: QueryCtx,
  viewer: ViewerContext,
  file: Doc<"files">,
): Promise<FilePermission> {
  const space = await loadSpace(ctx, file.departmentId);
  const access = spaceAccess(viewer, space.department);
  const isOwner = file.uploadedBy === viewer.user._id;
  const grant = await getFileGrant(ctx, file._id, viewer.user._id);
  const taskFolder = await inTaskFolder(ctx, file.folderId);

  let view = access.view || canOversightReadFiles(viewer) || isOwner || grant !== null;
  let write =
    access.manage ||
    (isOwner && (access.upload || taskFolder)) ||
    grant?.level === "write" ||
    isOwner;

  // Owner always keeps view + write + access management on their file.
  if (isOwner) {
    view = true;
    write = true;
  }

  const manageAccess = isOwner || access.manage;
  const canGrant: FilePermission["canGrant"] = write ? "write" : view ? "read" : null;
  return { view, write, manageAccess, canGrant };
}

export async function requireFileView(ctx: QueryCtx, viewer: ViewerContext, fileId: Id<"files">) {
  const file = await ctx.db.get("files", fileId);
  if (!file || file.deletedAt) throw appError("NOT_FOUND");
  const permission = await filePermission(ctx, viewer, file);
  if (!permission.view) throw appError("NOT_FOUND");
  return { file, permission };
}

export async function requireFileWrite(ctx: QueryCtx, viewer: ViewerContext, fileId: Id<"files">) {
  const { file, permission } = await requireFileView(ctx, viewer, fileId);
  if (!permission.write) throw appError("FORBIDDEN");
  return { file, permission };
}

export async function logFileEvent(
  ctx: MutationCtx,
  args: {
    fileId: Id<"files">;
    actorId: Id<"users">;
    action: string;
    metadata?: Record<string, unknown>;
  },
) {
  await ctx.db.insert("fileEvents", {
    fileId: args.fileId,
    actorId: args.actorId,
    action: args.action,
    metadata: args.metadata,
  });
}

/** Upserts a grant; write beats read. Returns whether anything changed. */
export async function upsertFileGrant(
  ctx: MutationCtx,
  args: {
    fileId: Id<"files">;
    userId: Id<"users">;
    level: "read" | "write";
    grantedBy: Id<"users">;
    assignmentId?: Id<"assignments">;
  },
) {
  if (args.userId === args.grantedBy) {
    const file = await ctx.db.get("files", args.fileId);
    if (file?.uploadedBy === args.userId) return false;
  }
  const existing = await getFileGrant(ctx, args.fileId, args.userId);
  if (existing) {
    const nextLevel = existing.level === "write" || args.level === "write" ? "write" : "read";
    const patch: Partial<Doc<"fileGrants">> = {};
    if (nextLevel !== existing.level) patch.level = nextLevel;
    if (args.assignmentId && !existing.assignmentId) patch.assignmentId = args.assignmentId;
    if (Object.keys(patch).length === 0) return false;
    await ctx.db.patch("fileGrants", existing._id, patch);
    return true;
  }
  await ctx.db.insert("fileGrants", {
    fileId: args.fileId,
    userId: args.userId,
    level: args.level,
    grantedBy: args.grantedBy,
    assignmentId: args.assignmentId,
  });
  return true;
}

/** The task's folder ("任务 Tasks / <title>"), created on first use. */
export async function ensureTaskFolder(ctx: MutationCtx, assignment: Doc<"assignments">, actorId: Id<"users">) {
  const existing = (
    await ctx.db
      .query("folders")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", assignment._id))
      .collect()
  ).find((f) => !f.deletedAt);
  if (existing) return existing._id;

  const departmentId = assignment.departmentId;
  const { folders } = await liveChildren(ctx, departmentId, undefined);
  let rootId = folders.find((f) => f.tasksRoot)?._id;
  if (!rootId) {
    rootId = await ctx.db.insert("folders", {
      name: await uniqueName(ctx, { departmentId, parentId: undefined, name: "任务 Tasks", kind: "folder" }),
      departmentId,
      tasksRoot: true,
      createdBy: actorId,
    });
  }
  return await ctx.db.insert("folders", {
    name: await uniqueName(ctx, {
      departmentId,
      parentId: rootId,
      name: cleanName(assignment.title, LIMITS.folderName),
      kind: "folder",
    }),
    departmentId,
    parentId: rootId,
    assignmentId: assignment._id,
    createdBy: actorId,
  });
}
