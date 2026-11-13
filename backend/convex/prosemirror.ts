import type { DataModel } from "./_generated/dataModel";
import { snapshotText } from "./lib/docText";
import { documentAccess, prosemirrorSync, recordDocumentMentions } from "./lib/documents";
import { appError } from "./lib/errors";

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
    onSnapshot: async (ctx, id, snapshot) => {
      const access = await documentAccess(ctx, id);
      await ctx.db.patch("documents", access.doc._id, {
        updatedAt: Date.now(),
        updatedBy: access.viewer.user._id,
        text: snapshotText(snapshot),
      });
      await recordDocumentMentions(ctx, access, snapshot);
    },
  });
