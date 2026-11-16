import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { uploadTarget, type SaveResult } from "./files";
import { appsScriptConfigured, callAppsScript } from "./lib/appsScript";
import { LIMITS, type ErrorCode } from "./lib/constants";
import { appError } from "./lib/errors";
import { cleanName, ensureTaskFolder, isBlockedFile, loadSpace, requireFolder, spaceKey, uniqueName } from "./lib/files";
import { requireApproved } from "./lib/permissions";

// Files over LIMITS.fileBytes, or uploaded when the space is out of quota, go to the CSSA Google Drive
// through the Apps Script (doc/features/files.md#google-drive). The browser uploads straight to Drive.

const DRIVE_ID = /^[\w-]{10,200}$/;

const uploadArgs = {
  space: v.optional(v.string()),
  folderId: v.optional(v.id("folders")),
  assignmentId: v.optional(v.id("assignments")),
  name: v.string(),
  size: v.number(),
  contentType: v.string(),
};

/** Drive sessions only accept browser uploads from the origin given when the session was created. */
function siteOrigin() {
  try {
    return new URL(process.env.SITE_URL ?? "").origin;
  } catch {
    return undefined;
  }
}

/** Step 1: checks the upload, then asks Apps Script for a Drive upload session URL the browser can PUT to. */
export const startUpload = action({
  args: uploadArgs,
  handler: async (ctx, args): Promise<{ uploadId: Id<"driveUploads">; uploadUrl: string }> => {
    if (!appsScriptConfigured()) throw appError("DRIVE_NOT_CONFIGURED");
    const { uploadId, name, driveFolder } = await ctx.runMutation(internal.drive.prepareUpload, args);
    const result = await callAppsScript("driveSession", {
      name,
      mimeType: args.contentType || "application/octet-stream",
      size: args.size,
      folder: driveFolder,
      origin: siteOrigin(),
    });
    if (!result.ok || typeof result.uploadUrl !== "string") {
      console.error(`drive session failed: ${result.code ?? "?"}: ${result.error ?? ""}`);
      await ctx.runMutation(internal.drive.forget, { uploadId });
      throw appError("DRIVE_FAILED", result.code === "DRIVE_FULL" ? "full" : "session");
    }
    return { uploadId, uploadUrl: result.uploadUrl };
  },
});

/** Step 3, after the browser's PUT: verifies the Drive file through Apps Script and records it in the folder. */
export const finishUpload = action({
  args: { uploadId: v.id("driveUploads"), driveFileId: v.string() },
  handler: async (ctx, args): Promise<SaveResult> => {
    if (!DRIVE_ID.test(args.driveFileId)) throw appError("INVALID", "driveFileId");
    const upload = await ctx.runQuery(internal.drive.getUpload, { uploadId: args.uploadId });
    if (!upload) throw appError("NOT_FOUND");
    const result = await callAppsScript("driveFinalize", { fileId: args.driveFileId, folder: upload.driveFolder });
    if (!result.ok) {
      console.error(`drive finalize failed: ${result.code ?? "?"}: ${result.error ?? ""}`);
      await ctx.runMutation(internal.drive.forget, { uploadId: args.uploadId });
      return { ok: false, code: "DRIVE_FAILED", message: "finalize" };
    }
    const saved: SaveResult = await ctx.runMutation(internal.drive.record, {
      uploadId: args.uploadId,
      driveFileId: args.driveFileId,
      size: Number(result.size) || upload.size,
      contentType: typeof result.mimeType === "string" && result.mimeType ? result.mimeType : upload.contentType,
    });
    if (!saved.ok) await callAppsScript("driveTrash", { fileId: args.driveFileId });
    return saved;
  },
});

export const prepareUpload = internalMutation({
  args: uploadArgs,
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const name = cleanName(args.name, LIMITS.fileName);
    if (!Number.isFinite(args.size) || args.size <= 0) throw appError("INVALID", "size");
    if (args.size > LIMITS.driveFileBytes) throw appError("FILE_TOO_LARGE");
    if (isBlockedFile(name, args.contentType)) throw appError("FILE_TYPE_BLOCKED");
    const target = await uploadTarget(ctx, viewer, args);
    if (!target.assignment && args.folderId) await requireFolder(ctx, target.departmentId, args.folderId);
    const { department } = await loadSpace(ctx, target.departmentId);
    const driveFolder = spaceKey(department);
    const uploadId = await ctx.db.insert("driveUploads", {
      userId: viewer.user._id,
      space: args.space,
      folderId: args.folderId,
      assignmentId: args.assignmentId,
      name,
      size: args.size,
      contentType: args.contentType || "application/octet-stream",
      driveFolder,
    });
    return { uploadId, name, driveFolder };
  },
});

export const getUpload = internalQuery({
  args: { uploadId: v.id("driveUploads") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const upload = await ctx.db.get("driveUploads", args.uploadId);
    return upload && upload.userId === viewer.user._id ? upload : null;
  },
});

export const forget = internalMutation({
  args: { uploadId: v.id("driveUploads") },
  handler: async (ctx, args) => {
    if (await ctx.db.get("driveUploads", args.uploadId)) await ctx.db.delete("driveUploads", args.uploadId);
  },
});

/** Records the finished upload, re-checking rights (they may have changed during a long upload). */
export const record = internalMutation({
  args: {
    uploadId: v.id("driveUploads"),
    driveFileId: v.string(),
    size: v.number(),
    contentType: v.string(),
  },
  handler: async (ctx, args): Promise<SaveResult> => {
    const viewer = await requireApproved(ctx);
    const upload = await ctx.db.get("driveUploads", args.uploadId);
    if (!upload || upload.userId !== viewer.user._id) throw appError("NOT_FOUND");
    await ctx.db.delete("driveUploads", upload._id);
    try {
      if (args.size > LIMITS.driveFileBytes) throw appError("FILE_TOO_LARGE");
      if (isBlockedFile(upload.name, args.contentType)) throw appError("FILE_TYPE_BLOCKED");
      const target = await uploadTarget(ctx, viewer, upload);
      let folderId = upload.folderId;
      if (target.assignment) folderId = await ensureTaskFolder(ctx, target.assignment, viewer.user._id);
      else if (folderId) await requireFolder(ctx, target.departmentId, folderId);
      const fileId = await ctx.db.insert("files", {
        driveFileId: args.driveFileId,
        name: await uniqueName(ctx, {
          departmentId: target.departmentId,
          parentId: folderId,
          name: upload.name,
          kind: "file",
        }),
        contentType: args.contentType,
        size: args.size,
        departmentId: target.departmentId,
        folderId,
        uploadedBy: viewer.user._id,
      });
      return { ok: true, fileId };
    } catch (error) {
      // Report instead of throwing, so the upload row stays deleted and the caller trashes the Drive file.
      if (!(error instanceof ConvexError)) throw error;
      const data = error.data as { code: ErrorCode; message?: string };
      return { ok: false, code: data.code, message: data.message ?? data.code };
    }
  },
});

/** Moves a purged file to the Drive trash (Google empties it after 30 days). */
export const trashFile = internalAction({
  args: { driveFileId: v.string() },
  handler: async (_ctx, args) => {
    const result = await callAppsScript("driveTrash", { fileId: args.driveFileId });
    if (!result.ok) console.error(`drive trash failed for ${args.driveFileId}: ${result.code ?? "?"}`);
  },
});

/** Hourly: forget uploads that never finished. */
export const cleanupUploads = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - LIMITS.driveUploadMs;
    const stale = await ctx.db
      .query("driveUploads")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(200);
    for (const upload of stale) await ctx.db.delete("driveUploads", upload._id);
  },
});
