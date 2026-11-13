import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { markSuggestionApplied } from "./lib/ai/suggestions";
import { channelAudience, groupDepartmentIds, touchReadState } from "./lib/channels";
import { LIMITS } from "./lib/constants";
import { appError } from "./lib/errors";
import { deleteTaskDocuments } from "./lib/documents";
import { loadSpace, spaceKey, trashFolderTree } from "./lib/files";
import { notify, notifyMany } from "./lib/notify";
import { getViewer, requireApproved, type ViewerContext } from "./lib/permissions";
import {
  canCreateTaskIn,
  eventEnd,
  isOpenForAssignee,
  taskAccess,
  taskLink,
  taskSpaceOptions,
} from "./lib/tasks";
import { parseMentions, toSearchText } from "./lib/text";
import { getUserSummaries, type UserSummary } from "./lib/users";
import { toFileViews } from "./files";

const kindValidator = v.union(v.literal("task"), v.literal("event"));

const editableFields = {
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  dueAt: v.optional(v.union(v.number(), v.null())),
  startAt: v.optional(v.union(v.number(), v.null())),
  endAt: v.optional(v.union(v.number(), v.null())),
  location: v.optional(v.string()),
  requiresSubmission: v.optional(v.boolean()),
  autoApprove: v.optional(v.boolean()),
  eventId: v.optional(v.union(v.id("assignments"), v.null())),
  departmentId: v.optional(v.union(v.id("departments"), v.null())),
  fileIds: v.optional(v.array(v.id("files"))),
  assigneeIds: v.optional(v.array(v.id("users"))),
  everyone: v.optional(v.boolean()),
};

type ChannelSummary = {
  _id: Id<"channels">;
  type: Doc<"channels">["type"];
  name?: string;
  nameZh?: string;
  nameEn?: string;
};

async function channelSummary(ctx: QueryCtx, channel: Doc<"channels"> | null): Promise<ChannelSummary | null> {
  if (!channel) return null;
  const department = channel.departmentId ? await ctx.db.get("departments", channel.departmentId) : null;
  return {
    _id: channel._id,
    type: channel.type,
    name: channel.name,
    nameZh: department?.nameZh,
    nameEn: department?.nameEn,
  };
}

function cleanText(value: string | undefined, max: number, field: string) {
  const trimmed = (value ?? "").trim();
  if (trimmed.length > max) throw appError("INVALID", field);
  return trimmed || undefined;
}

type Draft = Pick<
  Doc<"assignments">,
  | "kind"
  | "title"
  | "description"
  | "dueAt"
  | "startAt"
  | "endAt"
  | "location"
  | "requiresSubmission"
  | "autoApprove"
  | "eventId"
  | "departmentId"
>;

/** Checks and normalizes task fields for the given chat. */
async function validateDraft(
  ctx: QueryCtx,
  viewer: ViewerContext,
  channel: Doc<"channels">,
  draft: Draft,
  current: Doc<"assignments"> | null,
): Promise<Draft> {
  const title = cleanText(draft.title, LIMITS.taskTitle, "title");
  if (!title) throw appError("INVALID", "title");
  const description = cleanText(draft.description, LIMITS.taskDescription, "description");

  const spaces = await taskSpaceOptions(ctx, viewer, channel);
  let departmentId = draft.departmentId;
  // Keeping the current space is always fine, even if the viewer couldn't pick it themselves.
  if (!(current && current.departmentId === departmentId) && !spaces.includes(departmentId)) {
    if (draft.departmentId !== undefined || spaces.length === 0) throw appError("INVALID", "departmentId");
    departmentId = spaces[0];
  }

  if (draft.kind === "event") {
    if (!draft.startAt) throw appError("INVALID", "startAt");
    if (draft.endAt !== undefined && draft.endAt <= draft.startAt) throw appError("INVALID", "endAt");
    return {
      kind: "event",
      title,
      description,
      startAt: draft.startAt,
      endAt: draft.endAt,
      location: cleanText(draft.location, LIMITS.taskLocation, "location"),
      requiresSubmission: false,
      departmentId,
    };
  }

  if (draft.eventId) {
    const event = await ctx.db.get("assignments", draft.eventId);
    if (!event || event.kind !== "event" || event.channelId !== channel._id || event.status === "draft") {
      throw appError("INVALID", "eventId");
    }
  }
  return {
    kind: "task",
    title,
    description,
    dueAt: draft.dueAt,
    requiresSubmission: draft.requiresSubmission,
    autoApprove: draft.requiresSubmission ? undefined : draft.autoApprove || undefined,
    eventId: draft.eventId,
    departmentId,
  };
}

async function requireAudience(ctx: QueryCtx, channel: Doc<"channels">, userIds: Id<"users">[]) {
  const audience = new Set(await channelAudience(ctx, channel));
  const unique = [...new Set(userIds)];
  if (unique.length > LIMITS.taskAssignees) throw appError("INVALID", "assignees");
  for (const id of unique) if (!audience.has(id)) throw appError("INVALID", "assignees");
  return unique;
}

/** Files must be live files in this task's folder. */
async function requireTaskFiles(ctx: QueryCtx, assignment: Doc<"assignments">, fileIds: Id<"files">[], uploader?: Id<"users">) {
  const unique = [...new Set(fileIds)];
  if (unique.length > LIMITS.taskFiles) throw appError("INVALID", "fileIds");
  for (const id of unique) {
    const file = await ctx.db.get("files", id);
    if (!file || file.deletedAt || file.departmentId !== assignment.departmentId) throw appError("INVALID", "fileIds");
    if (uploader && file.uploadedBy !== uploader) throw appError("INVALID", "fileIds");
    const folder = file.folderId ? await ctx.db.get("folders", file.folderId) : null;
    if (folder?.assignmentId !== assignment._id) throw appError("INVALID", "fileIds");
  }
  return unique;
}

function notificationParams(viewer: ViewerContext, assignment: Doc<"assignments">) {
  return { actorId: viewer.user._id, title: assignment.title, kind: assignment.kind, assignmentId: assignment._id };
}

/** Users mentioned in a description, as ids. */
function descriptionMentions(ctx: QueryCtx, description: string | undefined) {
  return parseMentions(description ?? "").userIds.flatMap((id) => {
    const userId = ctx.db.normalizeId("users", id);
    return userId ? [userId] : [];
  });
}

/** Notifies people newly @mentioned in an open task's description who are in its chat. */
async function notifyDescriptionMentions(
  ctx: MutationCtx,
  viewer: ViewerContext,
  assignment: Doc<"assignments">,
  channel: Doc<"channels">,
  opts: { previous?: string; skip?: Id<"users">[] },
) {
  const before = new Set(descriptionMentions(ctx, opts.previous));
  const skip = new Set([viewer.user._id, ...(opts.skip ?? [])]);
  const fresh = descriptionMentions(ctx, assignment.description).filter((id) => !before.has(id) && !skip.has(id));
  if (fresh.length === 0) return;
  const audience = new Set(await channelAudience(ctx, channel));
  await notifyMany(
    ctx,
    fresh.filter((id) => audience.has(id)),
    { type: "task_mention", params: notificationParams(viewer, assignment), link: taskLink(assignment._id) },
  );
}

/** Returns who was newly assigned (and notified). */
async function insertAssignees(ctx: MutationCtx, viewer: ViewerContext, assignment: Doc<"assignments">, userIds: Id<"users">[]) {
  const added: Id<"users">[] = [];
  for (const userId of userIds) {
    const existing = await ctx.db
      .query("assignmentSubmissions")
      .withIndex("by_assignment_assignee", (q) => q.eq("assignmentId", assignment._id).eq("assigneeId", userId))
      .unique();
    if (existing) continue;
    await ctx.db.insert("assignmentSubmissions", {
      assignmentId: assignment._id,
      assigneeId: userId,
      status: "assigned",
      fileIds: [],
    });
    added.push(userId);
  }
  await notifyMany(
    ctx,
    added.filter((id) => id !== viewer.user._id),
    { type: "assignment_new", params: notificationParams(viewer, assignment), link: taskLink(assignment._id) },
  );
  return added;
}

async function publishDraft(ctx: MutationCtx, viewer: ViewerContext, assignment: Doc<"assignments">, channel: Doc<"channels">) {
  const assignees = assignment.draftEveryone
    ? await channelAudience(ctx, channel)
    : await requireAudience(ctx, channel, assignment.draftAssigneeIds ?? []);
  if (assignees.length === 0) throw appError("INVALID", "assignees");
  if (assignees.length > LIMITS.taskAssignees) throw appError("INVALID", "assignees");

  const now = Date.now();
  const messageId = await ctx.db.insert("messages", {
    channelId: channel._id,
    authorId: viewer.user._id,
    body: "",
    kind: "task",
    assignmentId: assignment._id,
    searchText: toSearchText(assignment.title),
  });
  await ctx.db.patch("channels", channel._id, { lastMessageAt: now });
  await touchReadState(ctx, channel._id, viewer.user._id, now);
  await ctx.db.patch("assignments", assignment._id, {
    status: "open",
    publishedAt: now,
    messageId,
    draftAssigneeIds: undefined,
    draftEveryone: undefined,
  });
  const added = await insertAssignees(ctx, viewer, { ...assignment, status: "open" }, assignees);
  // Assignees already get "assigned to you"; a mention would only repeat it.
  await notifyDescriptionMentions(ctx, viewer, assignment, channel, { skip: added });
}

async function requireTask(ctx: QueryCtx, viewer: ViewerContext, assignmentId: Id<"assignments">) {
  const assignment = await ctx.db.get("assignments", assignmentId);
  if (!assignment) throw appError("NOT_FOUND");
  const access = await taskAccess(ctx, viewer, assignment);
  if (!access) throw appError("NOT_FOUND");
  return { assignment, access };
}

async function requireReviewer(ctx: QueryCtx, viewer: ViewerContext, assignmentId: Id<"assignments">) {
  const result = await requireTask(ctx, viewer, assignmentId);
  if (!result.access.review) throw appError("FORBIDDEN");
  return result;
}

export const create = mutation({
  args: {
    channelId: v.id("channels"),
    kind: kindValidator,
    title: v.string(),
    description: v.optional(v.string()),
    dueAt: v.optional(v.number()),
    startAt: v.optional(v.number()),
    endAt: v.optional(v.number()),
    location: v.optional(v.string()),
    requiresSubmission: v.boolean(),
    autoApprove: v.optional(v.boolean()),
    eventId: v.optional(v.id("assignments")),
    departmentId: v.optional(v.id("departments")),
    assigneeIds: v.array(v.id("users")),
    everyone: v.boolean(),
    publish: v.boolean(),
    /** Created from 小飒's suggestion card. */
    suggestionId: v.optional(v.id("aiSuggestions")),
  },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const channel = await ctx.db.get("channels", args.channelId);
    if (!channel) throw appError("NOT_FOUND");
    if (!(await canCreateTaskIn(ctx, viewer, channel))) throw appError("FORBIDDEN");
    const draft = await validateDraft(ctx, viewer, channel, args, null);
    const assigneeIds = await requireAudience(ctx, channel, args.assigneeIds);
    const assignmentId = await ctx.db.insert("assignments", {
      ...draft,
      createdBy: viewer.user._id,
      channelId: channel._id,
      status: "draft",
      fileIds: [],
      draftAssigneeIds: assigneeIds,
      draftEveryone: args.everyone || undefined,
    });
    if (args.publish) await publishDraft(ctx, viewer, (await ctx.db.get("assignments", assignmentId))!, channel);
    await markSuggestionApplied(ctx, viewer, args.suggestionId, channel._id);
    return assignmentId;
  },
});

/**
 * A draft from a task 小飒 found in a document. Same checks as `create`; assignees outside the chat are
 * dropped. Nobody is notified until the creator publishes it.
 */
export async function createDraftFromDocument(
  ctx: MutationCtx,
  viewer: ViewerContext,
  channel: Doc<"channels">,
  item: Pick<Doc<"assignments">, "kind" | "title" | "description" | "dueAt" | "startAt" | "endAt" | "location"> & {
    assigneeIds: Id<"users">[];
    eventId?: Id<"assignments">;
  },
) {
  if (!(await canCreateTaskIn(ctx, viewer, channel))) throw appError("FORBIDDEN");
  const draft = await validateDraft(
    ctx,
    viewer,
    channel,
    {
      kind: item.kind,
      title: item.title,
      description: item.description?.slice(0, LIMITS.taskDescription),
      dueAt: item.dueAt,
      startAt: item.startAt,
      endAt: item.endAt,
      location: item.location,
      requiresSubmission: false,
      autoApprove: undefined,
      eventId: item.kind === "task" ? item.eventId : undefined,
      departmentId: undefined,
    },
    null,
  );
  const audience = new Set(await channelAudience(ctx, channel));
  const assigneeIds = [...new Set(item.assigneeIds)].filter((id) => audience.has(id)).slice(0, LIMITS.taskAssignees);
  return ctx.db.insert("assignments", {
    ...draft,
    createdBy: viewer.user._id,
    channelId: channel._id,
    status: "draft",
    fileIds: [],
    draftAssigneeIds: assigneeIds,
  });
}

export const update = mutation({
  args: { assignmentId: v.id("assignments"), ...editableFields, suggestionId: v.optional(v.id("aiSuggestions")) },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { assignment, access } = await requireReviewer(ctx, viewer, args.assignmentId);
    const channel = access.channel;
    if (!channel) throw appError("NOT_FOUND");
    await markSuggestionApplied(ctx, viewer, args.suggestionId, channel._id);
    const pick = <T>(value: T | null | undefined, fallback: T | undefined) =>
      value === null ? undefined : value === undefined ? fallback : value;
    const draft = await validateDraft(
      ctx,
      viewer,
      channel,
      {
        kind: assignment.kind,
        title: args.title ?? assignment.title,
        description: args.description ?? assignment.description,
        dueAt: pick(args.dueAt, assignment.dueAt),
        startAt: pick(args.startAt, assignment.startAt),
        endAt: pick(args.endAt, assignment.endAt),
        location: args.location ?? assignment.location,
        // Switching submissions on or off would strand what people already did.
        requiresSubmission:
          assignment.status === "draft" ? (args.requiresSubmission ?? assignment.requiresSubmission) : assignment.requiresSubmission,
        autoApprove: args.autoApprove ?? assignment.autoApprove,
        eventId: pick(args.eventId, assignment.eventId),
        departmentId: assignment.status === "draft" ? pick(args.departmentId, assignment.departmentId) : assignment.departmentId,
      },
      assignment,
    );
    const patch: Partial<Doc<"assignments">> = { ...draft };
    if (args.fileIds) patch.fileIds = await requireTaskFiles(ctx, assignment, args.fileIds);
    if (assignment.status === "draft") {
      if (args.assigneeIds) patch.draftAssigneeIds = await requireAudience(ctx, channel, args.assigneeIds);
      if (args.everyone !== undefined) patch.draftEveryone = args.everyone || undefined;
    }
    await ctx.db.patch("assignments", assignment._id, patch);
    if (assignment.status === "open") {
      await notifyDescriptionMentions(ctx, viewer, { ...assignment, ...draft }, channel, {
        previous: assignment.description,
      });
    }

    const timeChanged =
      draft.dueAt !== assignment.dueAt ||
      draft.startAt !== assignment.startAt ||
      draft.endAt !== assignment.endAt ||
      draft.location !== assignment.location;
    if (assignment.status === "open" && timeChanged) {
      const rows = await ctx.db
        .query("assignmentSubmissions")
        .withIndex("by_assignment", (q) => q.eq("assignmentId", assignment._id))
        .collect();
      for (const row of rows) {
        await ctx.db.patch("assignmentSubmissions", row._id, {
          dueSoonReminderSentAt: undefined,
          overdueReminderSentAt: undefined,
        });
      }
      await notifyMany(
        ctx,
        rows.map((r) => r.assigneeId).filter((id) => id !== viewer.user._id),
        {
          type: "assignment_updated",
          params: notificationParams(viewer, { ...assignment, title: draft.title }),
          link: taskLink(assignment._id),
        },
      );
    }
  },
});

export const publish = mutation({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { assignment, access } = await requireReviewer(ctx, viewer, args.assignmentId);
    if (assignment.status !== "draft") throw appError("INVALID", "status");
    if (!access.channel || !(await canCreateTaskIn(ctx, viewer, access.channel))) throw appError("FORBIDDEN");
    await publishDraft(ctx, viewer, assignment, access.channel);
  },
});

export const close = mutation({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { assignment } = await requireReviewer(ctx, viewer, args.assignmentId);
    if (assignment.status !== "open") throw appError("INVALID", "status");
    await ctx.db.patch("assignments", assignment._id, { status: "closed", closedAt: Date.now() });
  },
});

export const reopen = mutation({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { assignment } = await requireReviewer(ctx, viewer, args.assignmentId);
    if (assignment.status !== "closed") throw appError("INVALID", "status");
    await ctx.db.patch("assignments", assignment._id, { status: "open", closedAt: undefined });
  },
});

/** Only drafts can be deleted; their folder goes to the trash. */
export const remove = mutation({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { assignment, access } = await requireTask(ctx, viewer, args.assignmentId);
    if (!access.isCreator || assignment.status !== "draft") throw appError("FORBIDDEN");
    const folders = await ctx.db
      .query("folders")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", assignment._id))
      .collect();
    for (const folder of folders) if (!folder.deletedAt) await trashFolderTree(ctx, folder, viewer.user._id);
    await deleteTaskDocuments(ctx, assignment._id);
    await ctx.db.delete("assignments", assignment._id);
  },
});

export const addAssignees = mutation({
  args: { assignmentId: v.id("assignments"), userIds: v.array(v.id("users")) },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { assignment, access } = await requireReviewer(ctx, viewer, args.assignmentId);
    if (assignment.status !== "open" || !access.channel) throw appError("INVALID", "status");
    const userIds = await requireAudience(ctx, access.channel, args.userIds);
    await insertAssignees(ctx, viewer, assignment, userIds);
  },
});

export const removeAssignee = mutation({
  args: { assignmentId: v.id("assignments"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { assignment } = await requireReviewer(ctx, viewer, args.assignmentId);
    const row = await ctx.db
      .query("assignmentSubmissions")
      .withIndex("by_assignment_assignee", (q) => q.eq("assignmentId", assignment._id).eq("assigneeId", args.userId))
      .unique();
    if (!row) return;
    const comments = await ctx.db
      .query("assignmentComments")
      .withIndex("by_submission", (q) => q.eq("submissionId", row._id))
      .collect();
    for (const comment of comments) await ctx.db.delete("assignmentComments", comment._id);
    await ctx.db.delete("assignmentSubmissions", row._id);
  },
});

function cleanLink(link: string | undefined) {
  const trimmed = (link ?? "").trim();
  if (!trimmed) return undefined;
  if (trimmed.length > LIMITS.submissionLink || !/^https?:\/\/\S+$/i.test(trimmed)) throw appError("INVALID", "link");
  return trimmed;
}

export const submit = mutation({
  args: {
    assignmentId: v.id("assignments"),
    text: v.optional(v.string()),
    link: v.optional(v.string()),
    fileIds: v.array(v.id("files")),
  },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { assignment, access } = await requireTask(ctx, viewer, args.assignmentId);
    const row = access.submission;
    if (!row) throw appError("FORBIDDEN");
    if (assignment.status !== "open" || assignment.kind !== "task" || !assignment.requiresSubmission) {
      throw appError("INVALID", "status");
    }
    if (row.status === "approved") throw appError("ALREADY_REVIEWED");
    const text = cleanText(args.text, LIMITS.submissionText, "text");
    const link = cleanLink(args.link);
    const fileIds = await requireTaskFiles(ctx, assignment, args.fileIds, viewer.user._id);
    if (!text && !link && fileIds.length === 0) throw appError("INVALID", "empty");
    const now = Date.now();
    await ctx.db.patch("assignmentSubmissions", row._id, {
      status: "submitted",
      text,
      link,
      fileIds,
      submittedAt: now,
      late: assignment.dueAt !== undefined && now > assignment.dueAt ? true : undefined,
    });
    if (row.status !== "submitted" && assignment.createdBy !== viewer.user._id) {
      await notify(ctx, assignment.createdBy, {
        type: "submission_received",
        params: notificationParams(viewer, assignment),
        link: `${taskLink(assignment._id)}&s=${row._id}`,
      });
    }
  },
});

export const markDone = mutation({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { assignment, access } = await requireTask(ctx, viewer, args.assignmentId);
    const row = access.submission;
    if (!row) throw appError("FORBIDDEN");
    if (assignment.status !== "open" || assignment.kind !== "task" || assignment.requiresSubmission) {
      throw appError("INVALID", "status");
    }
    if (row.status === "submitted" || row.status === "approved") return;
    const now = Date.now();
    const late = assignment.dueAt !== undefined && now > assignment.dueAt ? true : undefined;
    if (assignment.autoApprove) {
      await ctx.db.patch("assignmentSubmissions", row._id, { status: "approved", submittedAt: now, late, reviewedAt: now });
      return;
    }
    await ctx.db.patch("assignmentSubmissions", row._id, { status: "submitted", submittedAt: now, late });
    if (assignment.createdBy !== viewer.user._id) {
      await notify(ctx, assignment.createdBy, {
        type: "submission_received",
        params: notificationParams(viewer, assignment),
        link: `${taskLink(assignment._id)}&s=${row._id}`,
      });
    }
  },
});

async function requireSubmission(ctx: QueryCtx, viewer: ViewerContext, submissionId: Id<"assignmentSubmissions">) {
  const submission = await ctx.db.get("assignmentSubmissions", submissionId);
  if (!submission) throw appError("NOT_FOUND");
  const { assignment, access } = await requireTask(ctx, viewer, submission.assignmentId);
  const own = submission.assigneeId === viewer.user._id;
  if (!own && !access.review) throw appError("NOT_FOUND");
  return { submission, assignment, access, own };
}

const REVIEWABLE: Record<"approve" | "request_changes" | "complete", Doc<"assignmentSubmissions">["status"][]> = {
  approve: ["submitted"],
  request_changes: ["submitted", "approved"],
  // Like grading in without a submission: the reviewer signs off on work done elsewhere.
  complete: ["assigned", "changes_requested"],
};

export const review = mutation({
  args: {
    submissionId: v.id("assignmentSubmissions"),
    decision: v.union(v.literal("approve"), v.literal("request_changes"), v.literal("complete")),
    comment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { submission, assignment, access } = await requireSubmission(ctx, viewer, args.submissionId);
    if (!access.review || assignment.kind !== "task") throw appError("FORBIDDEN");
    if (!REVIEWABLE[args.decision].includes(submission.status)) throw appError("INVALID", "status");
    const comment = cleanText(args.comment, LIMITS.taskComment, "comment");
    if (args.decision === "request_changes" && !comment) throw appError("INVALID", "comment");
    if (comment) {
      await ctx.db.insert("assignmentComments", { submissionId: submission._id, authorId: viewer.user._id, body: comment });
    }
    await ctx.db.patch("assignmentSubmissions", submission._id, {
      status: args.decision === "request_changes" ? "changes_requested" : "approved",
      reviewedBy: viewer.user._id,
      reviewedAt: Date.now(),
    });
    if (submission.assigneeId !== viewer.user._id) {
      await notify(ctx, submission.assigneeId, {
        type: "submission_reviewed",
        params: { ...notificationParams(viewer, assignment), decision: args.decision, note: comment },
        link: taskLink(assignment._id),
      });
    }
  },
});

export const listComments = query({
  args: { submissionId: v.id("assignmentSubmissions") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { submission } = await requireSubmission(ctx, viewer, args.submissionId);
    const comments = await ctx.db
      .query("assignmentComments")
      .withIndex("by_submission", (q) => q.eq("submissionId", submission._id))
      .collect();
    const people = await getUserSummaries(ctx, comments.map((c) => c.authorId));
    return comments.map((c) => ({
      _id: c._id,
      _creationTime: c._creationTime,
      body: c.body,
      author: people.get(c.authorId) ?? null,
    }));
  },
});

export const addComment = mutation({
  args: { submissionId: v.id("assignmentSubmissions"), body: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { submission, assignment, own } = await requireSubmission(ctx, viewer, args.submissionId);
    const body = cleanText(args.body, LIMITS.taskComment, "body");
    if (!body) throw appError("INVALID", "body");
    await ctx.db.insert("assignmentComments", { submissionId: submission._id, authorId: viewer.user._id, body });
    const recipient = own ? assignment.createdBy : submission.assigneeId;
    if (recipient !== viewer.user._id) {
      await notify(ctx, recipient, {
        type: "assignment_comment",
        params: { ...notificationParams(viewer, assignment), preview: body.slice(0, 80) },
        link: own ? `${taskLink(assignment._id)}&s=${submission._id}` : taskLink(assignment._id),
      });
    }
  },
});

async function liveFileViews(ctx: QueryCtx, viewer: ViewerContext, fileIds: Id<"files">[]) {
  const rows = (await Promise.all(fileIds.map((id) => ctx.db.get("files", id)))).filter(
    (f): f is Doc<"files"> => f !== null && !f.deletedAt,
  );
  return { files: await toFileViews(ctx, viewer, rows), missing: fileIds.length - rows.length };
}

/** Everything the task page needs, shaped by what the viewer may see. */
export const get = query({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const assignment = await ctx.db.get("assignments", args.assignmentId);
    if (!assignment) return null;
    const access = await taskAccess(ctx, viewer, assignment);
    if (!access) return null;

    const rows = await ctx.db
      .query("assignmentSubmissions")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", assignment._id))
      .collect();
    const space = await loadSpace(ctx, assignment.departmentId);
    const folder = (
      await ctx.db
        .query("folders")
        .withIndex("by_assignment", (q) => q.eq("assignmentId", assignment._id))
        .collect()
    ).find((f) => !f.deletedAt);

    let mySubmission = null;
    if (access.submission) {
      const own = access.submission;
      mySubmission = {
        _id: own._id,
        status: own.status,
        text: own.text,
        link: own.link,
        submittedAt: own.submittedAt,
        late: own.late === true,
        ...(await liveFileViews(ctx, viewer, own.fileIds)),
      };
    }

    const event = assignment.eventId ? await ctx.db.get("assignments", assignment.eventId) : null;
    const prepTasks = [];
    if (assignment.kind === "event") {
      const tasks = await ctx.db
        .query("assignments")
        .withIndex("by_event", (q) => q.eq("eventId", assignment._id))
        .collect();
      for (const task of tasks) {
        if (task.status === "draft" && task.createdBy !== viewer.user._id) continue;
        const taskRows = await ctx.db
          .query("assignmentSubmissions")
          .withIndex("by_assignment", (q) => q.eq("assignmentId", task._id))
          .collect();
        prepTasks.push({
          _id: task._id,
          title: task.title,
          status: task.status,
          dueAt: task.dueAt,
          total: taskRows.length,
          done: taskRows.filter((r) => r.status === "submitted" || r.status === "approved").length,
        });
      }
    }

    const people = await getUserSummaries(ctx, [
      assignment.createdBy,
      ...rows.map((r) => r.assigneeId),
      ...(assignment.draftAssigneeIds ?? []),
      ...descriptionMentions(ctx, assignment.description),
    ]);
    return {
      assignment: {
        _id: assignment._id,
        _creationTime: assignment._creationTime,
        kind: assignment.kind,
        title: assignment.title,
        description: assignment.description,
        status: assignment.status,
        dueAt: assignment.dueAt,
        startAt: assignment.startAt,
        endAt: assignment.endAt,
        location: assignment.location,
        requiresSubmission: assignment.requiresSubmission,
        autoApprove: assignment.autoApprove === true,
        departmentId: assignment.departmentId ?? null,
        eventId: assignment.eventId ?? null,
        publishedAt: assignment.publishedAt,
        closedAt: assignment.closedAt,
        createdBy: assignment.createdBy,
        draftAssigneeIds: assignment.draftAssigneeIds ?? [],
        draftEveryone: assignment.draftEveryone === true,
        ended: assignment.kind === "event" && eventEnd(assignment) <= Date.now(),
      },
      channel: await channelSummary(ctx, access.channel),
      space: { key: spaceKey(space.department), nameZh: space.department?.nameZh ?? "公共", nameEn: space.department?.nameEn ?? "Public" },
      folderId: folder?._id ?? null,
      creator: people.get(assignment.createdBy) ?? null,
      ...(await liveFileViews(ctx, viewer, assignment.fileIds)),
      assignees: rows.map((r) => ({
        submissionId: r._id,
        userId: r.assigneeId,
        status: r.status,
        submittedAt: r.submittedAt,
        late: r.late === true,
      })),
      people: [...people.values()],
      mySubmission,
      event: event ? { _id: event._id, title: event.title } : null,
      prepTasks,
      access: {
        review: access.review,
        isCreator: access.isCreator,
        canEdit: access.review && access.channel !== null,
      },
    };
  },
});

/** One submission with its files, for the assignee or a reviewer. */
export const getSubmission = query({
  args: { submissionId: v.id("assignmentSubmissions") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const submission = await ctx.db.get("assignmentSubmissions", args.submissionId);
    if (!submission) return null;
    const assignment = await ctx.db.get("assignments", submission.assignmentId);
    if (!assignment) return null;
    const access = await taskAccess(ctx, viewer, assignment);
    if (!access || (!access.review && submission.assigneeId !== viewer.user._id)) return null;
    const people = await getUserSummaries(ctx, [submission.assigneeId, ...(submission.reviewedBy ? [submission.reviewedBy] : [])]);
    return {
      _id: submission._id,
      status: submission.status,
      text: submission.text,
      link: submission.link,
      submittedAt: submission.submittedAt,
      late: submission.late === true,
      reviewedAt: submission.reviewedAt,
      assignee: people.get(submission.assigneeId) ?? null,
      reviewer: submission.reviewedBy ? (people.get(submission.reviewedBy) ?? null) : null,
      ...(await liveFileViews(ctx, viewer, submission.fileIds)),
    };
  },
});

export type TaskListItem = {
  _id: Id<"assignments">;
  kind: "task" | "event";
  title: string;
  status: Doc<"assignments">["status"];
  dueAt?: number;
  startAt?: number;
  endAt?: number;
  location?: string;
  requiresSubmission: boolean;
  channel: ChannelSummary | null;
  ended: boolean;
  myStatus: Doc<"assignmentSubmissions">["status"] | null;
  late: boolean;
  total: number;
  done: number;
  toReview: number;
};

async function listItem(
  ctx: QueryCtx,
  assignment: Doc<"assignments">,
  mine: Doc<"assignmentSubmissions"> | null,
  channels: Map<Id<"channels">, ChannelSummary | null>,
): Promise<TaskListItem> {
  if (!channels.has(assignment.channelId)) {
    channels.set(assignment.channelId, await channelSummary(ctx, await ctx.db.get("channels", assignment.channelId)));
  }
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
    channel: channels.get(assignment.channelId) ?? null,
    ended: assignment.kind === "event" && eventEnd(assignment) <= Date.now(),
    myStatus: mine?.status ?? null,
    late: mine?.late === true,
    total: rows.length,
    done: rows.filter((r) => r.status === "submitted" || r.status === "approved").length,
    toReview: rows.filter((r) => r.status === "submitted").length,
  };
}

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireApproved(ctx);
    const rows = await ctx.db
      .query("assignmentSubmissions")
      .withIndex("by_assignee", (q) => q.eq("assigneeId", viewer.user._id))
      .order("desc")
      .take(LIMITS.taskListLimit);
    const channels = new Map<Id<"channels">, ChannelSummary | null>();
    const items: TaskListItem[] = [];
    for (const row of rows) {
      const assignment = await ctx.db.get("assignments", row.assignmentId);
      if (!assignment || assignment.status === "draft") continue;
      items.push(await listItem(ctx, assignment, row, channels));
    }
    return items;
  },
});

/** Open tasks the viewer still has to do, for the nav badge. */
export const myOpenCount = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getViewer(ctx);
    if (!viewer || viewer.user.status !== "approved") return 0;
    const rows = await ctx.db
      .query("assignmentSubmissions")
      .withIndex("by_assignee", (q) => q.eq("assigneeId", viewer.user._id))
      .collect();
    let count = 0;
    for (const row of rows) {
      if (row.status !== "assigned" && row.status !== "changes_requested") continue;
      const assignment = await ctx.db.get("assignments", row.assignmentId);
      if (assignment?.status === "open" && assignment.kind === "task") count++;
    }
    return count;
  },
});

export const listCreatedByMe = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireApproved(ctx);
    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_creator", (q) => q.eq("createdBy", viewer.user._id))
      .order("desc")
      .take(LIMITS.taskListLimit);
    const channels = new Map<Id<"channels">, ChannelSummary | null>();
    const items: TaskListItem[] = [];
    for (const assignment of assignments) {
      const mine = await ctx.db
        .query("assignmentSubmissions")
        .withIndex("by_assignment_assignee", (q) => q.eq("assignmentId", assignment._id).eq("assigneeId", viewer.user._id))
        .unique();
      items.push(await listItem(ctx, assignment, mine, channels));
    }
    return items;
  },
});

/** Chats where the viewer manages tasks: every one for 主席团, led departments and their groups for 部长. */
async function managedChannelIds(ctx: QueryCtx, viewer: ViewerContext): Promise<Id<"channels">[] | "all"> {
  if (viewer.isAdmin) return "all";
  const ids = new Set<Id<"channels">>();
  for (const departmentId of viewer.ledDepartmentIds) {
    const channels = await ctx.db
      .query("channels")
      .withIndex("by_department", (q) => q.eq("departmentId", departmentId))
      .collect();
    for (const channel of channels) if (channel.type === "department") ids.add(channel._id);
    const groups = await ctx.db
      .query("groupDepartments")
      .withIndex("by_department", (q) => q.eq("departmentId", departmentId))
      .collect();
    for (const group of groups) ids.add(group.channelId);
  }
  return [...ids];
}

export const listManaged = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireApproved(ctx);
    if (!viewer.isAdmin && viewer.ledDepartmentIds.length === 0) return [];
    const scope = await managedChannelIds(ctx, viewer);
    let assignments: Doc<"assignments">[];
    if (scope === "all") {
      assignments = await ctx.db.query("assignments").order("desc").take(LIMITS.taskListLimit * 2);
    } else {
      assignments = [];
      for (const channelId of scope) {
        assignments.push(
          ...(await ctx.db
            .query("assignments")
            .withIndex("by_channel", (q) => q.eq("channelId", channelId))
            .collect()),
        );
      }
      assignments.sort((a, b) => b._creationTime - a._creationTime);
    }
    const channels = new Map<Id<"channels">, ChannelSummary | null>();
    const items: TaskListItem[] = [];
    for (const assignment of assignments) {
      if (assignment.status === "draft") continue;
      if (items.length >= LIMITS.taskListLimit) break;
      items.push(await listItem(ctx, assignment, null, channels));
    }
    return items;
  },
});

/** Chats the viewer can create tasks in. */
export async function taskChannelsFor(ctx: QueryCtx, viewer: ViewerContext): Promise<Doc<"channels">[]> {
  if (!viewer.isAdmin && viewer.ledDepartmentIds.length === 0) return [];
  const candidates = new Map<Id<"channels">, Doc<"channels">>();
  const add = (channel: Doc<"channels"> | null) => {
    if (channel) candidates.set(channel._id, channel);
  };
  if (viewer.isAdmin) {
    add(await ctx.db.query("channels").withIndex("by_type", (q) => q.eq("type", "org")).first());
    for (const channel of await ctx.db.query("channels").withIndex("by_type", (q) => q.eq("type", "department")).collect()) {
      add(channel);
    }
    const memberships = await ctx.db
      .query("channelMembers")
      .withIndex("by_user", (q) => q.eq("userId", viewer.user._id))
      .collect();
    for (const row of memberships) if (row.joinedAt !== undefined) add(await ctx.db.get("channels", row.channelId));
  }
  const scope = await managedChannelIds(ctx, { ...viewer, isAdmin: false });
  if (scope !== "all") for (const id of scope) add(await ctx.db.get("channels", id));

  const result: Doc<"channels">[] = [];
  for (const channel of candidates.values()) {
    if (channel.type !== "org" && channel.type !== "department" && channel.type !== "group") continue;
    if (await canCreateTaskIn(ctx, viewer, channel)) result.push(channel);
  }
  return result;
}

/** Chats the viewer can create tasks in, with the file spaces each allows. */
export const creatableChannels = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireApproved(ctx);
    const result = [];
    for (const channel of await taskChannelsFor(ctx, viewer)) {
      const spaces = [];
      for (const departmentId of await taskSpaceOptions(ctx, viewer, channel)) {
        const department = departmentId ? await ctx.db.get("departments", departmentId) : null;
        spaces.push({
          departmentId: departmentId ?? null,
          nameZh: department?.nameZh ?? "公共",
          nameEn: department?.nameEn ?? "Public",
        });
      }
      const summary = (await channelSummary(ctx, channel))!;
      const department = channel.departmentId ? await ctx.db.get("departments", channel.departmentId) : null;
      result.push({ ...summary, spaces, sortOrder: channel.type === "org" ? -1 : (department?.sortOrder ?? 1000) });
    }
    return result.sort((a, b) => a.sortOrder - b.sortOrder);
  },
});

/** People who can be assigned in a chat, plus its open events for "part of event". */
export const audience = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const channel = await ctx.db.get("channels", args.channelId);
    if (!channel) return null;
    const manages =
      (await canCreateTaskIn(ctx, viewer, channel)) ||
      (viewer.isAdmin && channel.type !== "dm");
    if (!manages) return null;
    const people = await getUserSummaries(ctx, await channelAudience(ctx, channel));
    const events = (
      await ctx.db
        .query("assignments")
        .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
        .collect()
    )
      .filter((a) => a.kind === "event" && a.status === "open")
      .map((a) => ({ _id: a._id, title: a.title, startAt: a.startAt }));
    const groupDepartments = channel.type === "group" ? await groupDepartmentIds(ctx, channel._id) : [];
    return {
      people: [...people.values()] as UserSummary[],
      events,
      groupDepartmentIds: groupDepartments,
    };
  },
});

/** Hourly: due-soon, overdue, and event reminders (in-app and push), each once per assignee. */
export const sendReminders = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const soon = now + LIMITS.taskDueSoonMs;
    const notifyRows = async (
      assignment: Doc<"assignments">,
      type: "assignment_due_soon" | "assignment_overdue" | "event_soon",
      flag: "dueSoonReminderSentAt" | "overdueReminderSentAt",
    ) => {
      const rows = await ctx.db
        .query("assignmentSubmissions")
        .withIndex("by_assignment", (q) => q.eq("assignmentId", assignment._id))
        .collect();
      for (const row of rows) {
        if (row[flag] !== undefined) continue;
        if (type !== "event_soon" && !isOpenForAssignee(assignment, row, now)) continue;
        await ctx.db.patch("assignmentSubmissions", row._id, { [flag]: now });
        await notify(ctx, row.assigneeId, {
          type,
          params: { title: assignment.title, kind: assignment.kind, assignmentId: assignment._id },
          link: taskLink(assignment._id),
        });
      }
    };

    const dueSoon = await ctx.db
      .query("assignments")
      .withIndex("by_status_due", (q) => q.eq("status", "open").gt("dueAt", now).lte("dueAt", soon))
      .collect();
    for (const assignment of dueSoon) await notifyRows(assignment, "assignment_due_soon", "dueSoonReminderSentAt");

    const overdue = await ctx.db
      .query("assignments")
      .withIndex("by_status_due", (q) =>
        q.eq("status", "open").gt("dueAt", now - 7 * 24 * 60 * 60 * 1000).lte("dueAt", now),
      )
      .collect();
    for (const assignment of overdue) await notifyRows(assignment, "assignment_overdue", "overdueReminderSentAt");

    const events = await ctx.db
      .query("assignments")
      .withIndex("by_status_start", (q) => q.eq("status", "open").gt("startAt", now).lte("startAt", soon))
      .collect();
    for (const event of events) await notifyRows(event, "event_soon", "dueSoonReminderSentAt");
  },
});