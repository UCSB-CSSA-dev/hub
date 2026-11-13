import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

/**
 * A document request that didn't produce a result: the summary stops showing "generating" (keeping the
 * previous summary, if any), and the writing draft shows the failure or refusal.
 */
export async function settleDocRequest(
  ctx: MutationCtx,
  request: Doc<"aiRequests">,
  outcome: { status: "failed" } | { status: "refused"; reason: string },
) {
  if (!request.documentId) return;
  if (request.source === "doc_summary") {
    const summary = await ctx.db
      .query("aiDocSummaries")
      .withIndex("by_document", (q) => q.eq("documentId", request.documentId!))
      .unique();
    if (summary?.pendingRequestId === request._id) {
      await ctx.db.patch("aiDocSummaries", summary._id, { pendingRequestId: undefined, error: outcome.status });
    }
    return;
  }
  const draft = await ctx.db
    .query("aiDocDrafts")
    .withIndex("by_request", (q) => q.eq("requestId", request._id))
    .unique();
  if (!draft || draft.status === "closed") return;
  await ctx.db.patch("aiDocDrafts", draft._id, {
    status: outcome.status,
    reason: outcome.status === "refused" ? outcome.reason : undefined,
  });
}
