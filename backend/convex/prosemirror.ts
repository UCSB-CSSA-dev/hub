import type { DataModel } from "./_generated/dataModel";
import { snapshotText } from "./lib/docText";
import { documentAccess, prosemirrorSync, recordDocumentMentions } from "./lib/documents";
import { appError } from "./lib/errors";
import { logDocumentEdit } from "./lib/files";

/** Sync endpoints for `useTiptapSync(api.prosemirror, documentId)`. */
export const { getSnapshot, submitSnapshot, latestVersion, getSteps, submitSteps } =
  prosemirrorSync.syncApi<DataModel>({
    checkRead: async (ctx, id) => {
      await documentAccess(ctx, id);
    },
    checkWrite: async (ctx, id) => {
      const { canEdit } = await documentAccess(ctx, id);
      if (!canEdit) throw appError("FORBIDDEN");
    },
    onSnapshot: async (ctx, id, snapshot, version) => {
      const access = await documentAccess(ctx, id);
      const text = snapshotText(snapshot);
      if (access.doc.fileId) {
        await logDocumentEdit(ctx, {
          fileId: access.doc.fileId,
          documentId: access.doc._id,
          actorId: access.viewer.user._id,
          afterContent: snapshot,
          afterText: text,
          version,
        });
      }
      await ctx.db.patch("documents", access.doc._id, {
        updatedAt: Date.now(),
        updatedBy: access.viewer.user._id,
        text,
      });
      await recordDocumentMentions(ctx, access, snapshot);
    },
  });
