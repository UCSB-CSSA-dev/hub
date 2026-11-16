import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { logAudit } from "./lib/audit";
import {
  activeLeadIds,
  channelMemberRow,
  explicitMembers,
  groupDepartmentIds,
  isTakenOver,
  presidiumMemberIds,
  presidiumUserIds,
  systemAdminIds,
  requireChannelAccess,
} from "./lib/channels";
import { LIMITS } from "./lib/constants";
import { appError } from "./lib/errors";
import { canReviewProposal, reviewableProposals } from "./lib/groups";
import { postSystemMessage } from "./lib/messages";
import { findMembership } from "./lib/memberships";
import { chatLink, notify, notifyMany } from "./lib/notify";
import { isLeadOf, requireApproved, type ViewerContext } from "./lib/permissions";
import { getUserSummaries, type UserSummary } from "./lib/users";

function cleanName(name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > LIMITS.groupName) throw appError("INVALID", "name");
  return trimmed;
}

function cleanPurpose(purpose: string | undefined, required: boolean) {
  const trimmed = (purpose ?? "").trim();
  if (trimmed.length > LIMITS.groupPurpose || (required && !trimmed)) throw appError("INVALID", "purpose");
  return trimmed || undefined;
}

async function requireDepartments(ctx: QueryCtx, ids: Id<"departments">[]) {
  const unique = [...new Set(ids)];
  const departments: Doc<"departments">[] = [];
  for (const id of unique) {
    const department = await ctx.db.get("departments", id);
    if (!department || department.archivedAt || department.kind !== "regular") {
      throw appError("INVALID", "department");
    }
    departments.push(department);
  }
  return departments;
}

async function requireApprovedUsers(ctx: QueryCtx, ids: Id<"users">[]) {
  const unique = [...new Set(ids)];
  for (const id of unique) {
    const user = await ctx.db.get("users", id);
    if (!user || user.status !== "approved") throw appError("INVALID", "user");
  }
  return unique;
}

/** 部长 can pull in members of departments they lead; admins can pull in anyone. */
async function canPullIn(ctx: QueryCtx, viewer: ViewerContext, userId: Id<"users">) {
  if (viewer.isAdmin) return true;
  for (const departmentId of viewer.ledDepartmentIds) {
    if (await findMembership(ctx, userId, departmentId)) return true;
  }
  return false;
}

async function implicitLeadIds(ctx: QueryCtx, departmentIds: Id<"departments">[]) {
  const ids = new Set<Id<"users">>();
  for (const departmentId of departmentIds) {
    for (const id of await activeLeadIds(ctx, departmentId)) ids.add(id);
  }
  return ids;
}

async function groupSize(ctx: QueryCtx, channel: Doc<"channels">) {
  const ids = new Set((await explicitMembers(ctx, channel)).map((m) => m.userId));
  for (const id of await implicitLeadIds(ctx, await groupDepartmentIds(ctx, channel._id))) ids.add(id);
  return ids;
}

async function createGroupChannel(
  ctx: MutationCtx,
  args: {
    actorId: Id<"users">;
    name: string;
    purpose?: string;
    departmentIds: Id<"departments">[];
    memberIds: Id<"users">[];
    proposal?: Doc<"groupProposals">;
  },
) {
  const now = Date.now();
  const implicit = await implicitLeadIds(ctx, args.departmentIds);
  const explicit = new Set(args.memberIds);
  if (args.proposal) explicit.add(args.proposal.proposerId);
  if (!implicit.has(args.actorId)) explicit.add(args.actorId);
  const everyone = new Set([...explicit, ...implicit]);
  if (everyone.size > LIMITS.groupMembers) throw appError("INVALID", "size");

  const channelId = await ctx.db.insert("channels", {
    type: "group",
    name: args.name,
    purpose: args.purpose,
    createdBy: args.proposal?.proposerId ?? args.actorId,
    proposalId: args.proposal?._id,
    lastMessageAt: now,
  });
  for (const departmentId of args.departmentIds) {
    await ctx.db.insert("groupDepartments", { channelId, departmentId });
  }
  for (const userId of explicit) {
    await ctx.db.insert("channelMembers", {
      channelId,
      userId,
      lastReadAt: now,
      joinedAt: now,
      addedBy: args.actorId,
    });
  }
  await postSystemMessage(ctx, {
    channelId,
    actorId: args.actorId,
    event: "group_created",
    params: args.proposal
      ? { proposerId: args.proposal.proposerId, approverId: args.actorId, name: args.name }
      : { actorId: args.actorId, name: args.name },
  });
  await notifyMany(
    ctx,
    [...everyone].filter((id) => id !== args.actorId),
    { type: "added_to_group", params: { actorId: args.actorId, name: args.name }, link: chatLink(channelId) },
  );
  await logAudit(ctx, {
    actorId: args.actorId,
    action: "group.create",
    targetType: "channel",
    targetId: channelId,
    metadata: { departmentIds: args.departmentIds, members: [...explicit], proposalId: args.proposal?._id },
  });
  return channelId;
}

// ---------- Proposals ----------

async function proposalApproverIds(ctx: QueryCtx, departmentIds: Id<"departments">[]) {
  const ids = new Set(await presidiumUserIds(ctx));
  for (const id of await implicitLeadIds(ctx, departmentIds)) ids.add(id);
  return [...ids];
}

export const propose = mutation({
  args: {
    name: v.string(),
    purpose: v.string(),
    departmentIds: v.array(v.id("departments")),
    suggestedUserIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const name = cleanName(args.name);
    const purpose = cleanPurpose(args.purpose, true)!;
    const departments = await requireDepartments(ctx, args.departmentIds);
    if (departments.length === 0) throw appError("INVALID", "department");
    const suggested = (await requireApprovedUsers(ctx, args.suggestedUserIds)).filter(
      (id) => id !== viewer.user._id,
    );
    if (suggested.length + 1 > LIMITS.groupMembers) throw appError("INVALID", "size");

    const departmentIds = departments.map((d) => d._id);
    const proposalId = await ctx.db.insert("groupProposals", {
      proposerId: viewer.user._id,
      name,
      purpose,
      departmentIds,
      suggestedUserIds: suggested,
      status: "pending",
      expiresAt: Date.now() + LIMITS.groupProposalDays * 24 * 60 * 60 * 1000,
    });
    await notifyMany(
      ctx,
      (await proposalApproverIds(ctx, departmentIds)).filter((id) => id !== viewer.user._id),
      { type: "group_proposed", params: { proposerId: viewer.user._id, name }, link: "/chat/?proposals=1" },
    );
    return proposalId;
  },
});

export const cancelProposal = mutation({
  args: { proposalId: v.id("groupProposals") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const proposal = await ctx.db.get("groupProposals", args.proposalId);
    if (!proposal || proposal.proposerId !== viewer.user._id) throw appError("NOT_FOUND");
    if (proposal.status !== "pending") throw appError("ALREADY_REVIEWED");
    await ctx.db.patch("groupProposals", proposal._id, { status: "cancelled" });
  },
});

export const reviewProposal = mutation({
  args: {
    proposalId: v.id("groupProposals"),
    approve: v.boolean(),
    note: v.optional(v.string()),
    name: v.optional(v.string()),
    /** Final explicit members besides the proposer. */
    memberIds: v.optional(v.array(v.id("users"))),
  },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const proposal = await ctx.db.get("groupProposals", args.proposalId);
    if (!proposal || !canReviewProposal(viewer, proposal)) throw appError("NOT_FOUND");
    if (proposal.status !== "pending") throw appError("ALREADY_REVIEWED");
    if (proposal.proposerId === viewer.user._id && !viewer.isAdmin) throw appError("FORBIDDEN");
    const note = (args.note ?? "").trim();
    if (note.length > LIMITS.reviewNote) throw appError("INVALID", "note");
    const now = Date.now();

    if (!args.approve) {
      if (!note) throw appError("INVALID", "note");
      await ctx.db.patch("groupProposals", proposal._id, {
        status: "rejected",
        reviewedBy: viewer.user._id,
        reviewedAt: now,
        reviewNote: note,
      });
      await notify(ctx, proposal.proposerId, {
        type: "group_rejected",
        params: { reviewerId: viewer.user._id, name: proposal.name, note },
        link: "/chat/?proposals=1",
      });
      return null;
    }

    const proposer = await ctx.db.get("users", proposal.proposerId);
    if (!proposer || proposer.status !== "approved") throw appError("INVALID", "proposer");
    const departmentIds: Id<"departments">[] = [];
    for (const id of proposal.departmentIds) {
      const department = await ctx.db.get("departments", id);
      if (department && !department.archivedAt) departmentIds.push(id);
    }
    if (departmentIds.length === 0) throw appError("INVALID", "department");

    const suggested = new Set(proposal.suggestedUserIds);
    const memberIds: Id<"users">[] = [];
    for (const id of new Set(args.memberIds ?? proposal.suggestedUserIds)) {
      const user = await ctx.db.get("users", id);
      if (!user || user.status !== "approved") {
        if (suggested.has(id)) continue;
        throw appError("INVALID", "user");
      }
      if (!suggested.has(id) && !(await canPullIn(ctx, viewer, id))) throw appError("FORBIDDEN");
      memberIds.push(id);
    }

    const name = args.name !== undefined ? cleanName(args.name) : proposal.name;
    const channelId = await createGroupChannel(ctx, {
      actorId: viewer.user._id,
      name,
      purpose: proposal.purpose,
      departmentIds,
      memberIds,
      proposal,
    });
    await ctx.db.patch("groupProposals", proposal._id, {
      status: "approved",
      reviewedBy: viewer.user._id,
      reviewedAt: now,
      reviewNote: note || undefined,
      channelId,
      name,
    });
    await notify(ctx, proposal.proposerId, {
      type: "group_approved",
      params: { reviewerId: viewer.user._id, name },
      link: chatLink(channelId),
    });
    return channelId;
  },
});

export type ProposalView = {
  _id: Id<"groupProposals">;
  _creationTime: number;
  name: string;
  purpose: string;
  status: Doc<"groupProposals">["status"];
  expiresAt: number;
  reviewNote?: string;
  reviewedAt?: number;
  channelId?: Id<"channels">;
  departments: { _id: Id<"departments">; nameZh: string; nameEn: string }[];
  proposer: UserSummary | null;
  reviewer: UserSummary | null;
  suggested: UserSummary[];
  canReview: boolean;
};

async function toProposalView(
  ctx: QueryCtx,
  viewer: ViewerContext,
  proposal: Doc<"groupProposals">,
): Promise<ProposalView> {
  const ids = [proposal.proposerId, ...proposal.suggestedUserIds];
  if (proposal.reviewedBy) ids.push(proposal.reviewedBy);
  const people = await getUserSummaries(ctx, ids);
  const departments = [];
  for (const id of proposal.departmentIds) {
    const department = await ctx.db.get("departments", id);
    if (department) departments.push({ _id: id, nameZh: department.nameZh, nameEn: department.nameEn });
  }
  return {
    _id: proposal._id,
    _creationTime: proposal._creationTime,
    name: proposal.name,
    purpose: proposal.purpose,
    status: proposal.status,
    expiresAt: proposal.expiresAt,
    reviewNote: proposal.reviewNote,
    reviewedAt: proposal.reviewedAt,
    channelId: proposal.channelId,
    departments,
    proposer: people.get(proposal.proposerId) ?? null,
    reviewer: proposal.reviewedBy ? (people.get(proposal.reviewedBy) ?? null) : null,
    suggested: proposal.suggestedUserIds.flatMap((id) => people.get(id) ?? []),
    canReview:
      proposal.status === "pending" &&
      canReviewProposal(viewer, proposal) &&
      (proposal.proposerId !== viewer.user._id || viewer.isAdmin),
  };
}

export const listProposals = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireApproved(ctx);
    const mine = await ctx.db
      .query("groupProposals")
      .withIndex("by_proposer", (q) => q.eq("proposerId", viewer.user._id))
      .order("desc")
      .take(20);
    const toReview = await reviewableProposals(ctx, viewer);
    return {
      mine: await Promise.all(mine.map((p) => toProposalView(ctx, viewer, p))),
      toReview: await Promise.all(toReview.map((p) => toProposalView(ctx, viewer, p))),
    };
  },
});

/** Hourly: pending proposals nobody acted on expire, and the proposer is told. */
export const expireProposals = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const pending = await ctx.db
      .query("groupProposals")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
    for (const proposal of pending) {
      if (proposal.expiresAt > now) continue;
      await ctx.db.patch("groupProposals", proposal._id, { status: "expired" });
      await notify(ctx, proposal.proposerId, {
        type: "group_expired",
        params: { name: proposal.name },
        link: "/chat/?proposals=1",
      });
    }
  },
});

// ---------- Direct creation and management ----------

export const create = mutation({
  args: {
    name: v.string(),
    purpose: v.optional(v.string()),
    departmentIds: v.array(v.id("departments")),
    memberIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const departments = await requireDepartments(ctx, args.departmentIds);
    const departmentIds = departments.map((d) => d._id);
    if (!viewer.isAdmin && !departmentIds.some((id) => isLeadOf(viewer, id))) throw appError("FORBIDDEN");
    const memberIds = await requireApprovedUsers(ctx, args.memberIds);
    for (const id of memberIds) {
      if (id !== viewer.user._id && !(await canPullIn(ctx, viewer, id))) throw appError("FORBIDDEN");
    }
    return createGroupChannel(ctx, {
      actorId: viewer.user._id,
      name: cleanName(args.name),
      purpose: cleanPurpose(args.purpose, false),
      departmentIds,
      memberIds,
    });
  },
});

async function requireGroup(ctx: QueryCtx, viewer: ViewerContext, channelId: Id<"channels">) {
  const { channel, access } = await requireChannelAccess(ctx, viewer, channelId);
  if (channel.type !== "group") throw appError("NOT_FOUND");
  return { channel, access };
}

async function requireManagedGroup(ctx: QueryCtx, viewer: ViewerContext, channelId: Id<"channels">) {
  const result = await requireGroup(ctx, viewer, channelId);
  if (!result.access.canManage) throw appError("FORBIDDEN");
  return result;
}

export const info = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel, access } = await requireGroup(ctx, viewer, args.channelId);
    const departmentIds = await groupDepartmentIds(ctx, channel._id);
    const takenOver = await isTakenOver(ctx, departmentIds);

    const departments = [];
    for (const id of departmentIds) {
      const department = await ctx.db.get("departments", id);
      if (!department) continue;
      const leadIds = await activeLeadIds(ctx, id);
      departments.push({
        _id: id,
        nameZh: department.nameZh,
        nameEn: department.nameEn,
        archived: department.archivedAt !== undefined,
        leads: [...(await getUserSummaries(ctx, leadIds)).values()],
        canRemove: access.canManage && departmentIds.length > 1,
      });
    }

    const rows = await explicitMembers(ctx, channel);
    const people = await getUserSummaries(ctx, rows.map((r) => r.userId));
    const members = [];
    for (const row of rows) {
      const person = people.get(row.userId);
      if (!person) continue;
      members.push({
        person,
        joinedAt: row.joinedAt,
        canRemove:
          access.canManage && row.userId !== viewer.user._id && (await canPullIn(ctx, viewer, row.userId)),
      });
    }
    const presidiumIds = takenOver ? await presidiumMemberIds(ctx) : [];
    const adminIds = takenOver ? (await systemAdminIds(ctx)).filter((id) => !presidiumIds.includes(id)) : [];
    const managers = await getUserSummaries(ctx, [...presidiumIds, ...adminIds]);
    const presidium = presidiumIds.flatMap((id) => managers.get(id) ?? []);
    const systemAdmins = adminIds.flatMap((id) => managers.get(id) ?? []);
    const isExplicit = rows.some((r) => r.userId === viewer.user._id);
    const proposal = channel.proposalId ? await ctx.db.get("groupProposals", channel.proposalId) : null;

    return {
      _id: channel._id,
      name: channel.name ?? "",
      purpose: channel.purpose,
      endedAt: channel.endedAt,
      takenOver,
      departments,
      members,
      presidium,
      systemAdmins,
      proposerId: proposal?.proposerId,
      approverId: proposal?.reviewedBy,
      viewer: {
        canManage: access.canManage,
        canLeave: isExplicit && access.via === "member",
        isImplicitLead: departmentIds.some((id) => isLeadOf(viewer, id)),
      },
    };
  },
});

export const addMembers = mutation({
  args: { channelId: v.id("channels"), userIds: v.array(v.id("users")) },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel } = await requireManagedGroup(ctx, viewer, args.channelId);
    const userIds = await requireApprovedUsers(ctx, args.userIds);
    const current = await groupSize(ctx, channel);
    const added: Id<"users">[] = [];
    const now = Date.now();
    for (const userId of userIds) {
      if (!(await canPullIn(ctx, viewer, userId))) throw appError("FORBIDDEN");
      const row = await channelMemberRow(ctx, channel._id, userId);
      if (row?.joinedAt !== undefined) continue;
      if (row) await ctx.db.patch("channelMembers", row._id, { joinedAt: now, addedBy: viewer.user._id });
      else {
        await ctx.db.insert("channelMembers", {
          channelId: channel._id,
          userId,
          lastReadAt: now,
          joinedAt: now,
          addedBy: viewer.user._id,
        });
      }
      if (!current.has(userId)) {
        current.add(userId);
        added.push(userId);
      }
    }
    if (current.size > LIMITS.groupMembers) throw appError("INVALID", "size");
    if (added.length === 0) return;
    await postSystemMessage(ctx, {
      channelId: channel._id,
      actorId: viewer.user._id,
      event: "members_added",
      params: { actorId: viewer.user._id, userIds: added },
    });
    await notifyMany(ctx, added, {
      type: "added_to_group",
      params: { actorId: viewer.user._id, name: channel.name ?? "" },
      link: chatLink(channel._id),
    });
  },
});

async function dropMember(ctx: MutationCtx, channelId: Id<"channels">, userId: Id<"users">) {
  const row = await channelMemberRow(ctx, channelId, userId);
  if (!row || row.joinedAt === undefined) throw appError("NOT_FOUND");
  await ctx.db.patch("channelMembers", row._id, { joinedAt: undefined, addedBy: undefined });
}

export const removeMember = mutation({
  args: { channelId: v.id("channels"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel } = await requireManagedGroup(ctx, viewer, args.channelId);
    if (args.userId === viewer.user._id) throw appError("INVALID", "self");
    if (!(await canPullIn(ctx, viewer, args.userId))) throw appError("FORBIDDEN");
    await dropMember(ctx, channel._id, args.userId);
    await postSystemMessage(ctx, {
      channelId: channel._id,
      actorId: viewer.user._id,
      event: "member_removed",
      params: { actorId: viewer.user._id, userId: args.userId },
    });
  },
});

export const leave = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel } = await requireGroup(ctx, viewer, args.channelId);
    await dropMember(ctx, channel._id, viewer.user._id);
    await postSystemMessage(ctx, {
      channelId: channel._id,
      actorId: viewer.user._id,
      event: "member_left",
      params: { userId: viewer.user._id },
    });
  },
});

export const rename = mutation({
  args: { channelId: v.id("channels"), name: v.string(), purpose: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel } = await requireManagedGroup(ctx, viewer, args.channelId);
    const name = cleanName(args.name);
    const purpose = args.purpose === undefined ? channel.purpose : cleanPurpose(args.purpose, false);
    if (name === channel.name && purpose === channel.purpose) return;
    await ctx.db.patch("channels", channel._id, { name, purpose });
    if (name !== channel.name) {
      await postSystemMessage(ctx, {
        channelId: channel._id,
        actorId: viewer.user._id,
        event: "renamed",
        params: { actorId: viewer.user._id, name },
      });
    }
  },
});

export const addDepartment = mutation({
  args: { channelId: v.id("channels"), departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel } = await requireManagedGroup(ctx, viewer, args.channelId);
    await requireDepartments(ctx, [args.departmentId]);
    const departmentIds = await groupDepartmentIds(ctx, channel._id);
    if (departmentIds.includes(args.departmentId)) return;
    const size = await groupSize(ctx, channel);
    for (const id of await activeLeadIds(ctx, args.departmentId)) size.add(id);
    if (size.size > LIMITS.groupMembers) throw appError("INVALID", "size");

    const wasTakenOver = await isTakenOver(ctx, departmentIds);
    await ctx.db.insert("groupDepartments", { channelId: channel._id, departmentId: args.departmentId });
    await postSystemMessage(ctx, {
      channelId: channel._id,
      actorId: viewer.user._id,
      event: "department_added",
      params: { actorId: viewer.user._id, departmentId: args.departmentId },
    });
    const newLeads = (await activeLeadIds(ctx, args.departmentId)).filter((id) => id !== viewer.user._id);
    await notifyMany(ctx, newLeads, {
      type: "added_to_group",
      params: { actorId: viewer.user._id, name: channel.name ?? "" },
      link: chatLink(channel._id),
    });
    if (wasTakenOver !== (await isTakenOver(ctx, [...departmentIds, args.departmentId]))) {
      // Only possible when the added department has no 部长 — requireDepartments allows that.
      await postSystemMessage(ctx, {
        channelId: channel._id,
        actorId: viewer.user._id,
        event: "takeover_started",
        params: { departmentId: args.departmentId },
      });
    }
  },
});

export const removeDepartment = mutation({
  args: { channelId: v.id("channels"), departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel } = await requireManagedGroup(ctx, viewer, args.channelId);
    const rows = await ctx.db
      .query("groupDepartments")
      .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
      .collect();
    const row = rows.find((r) => r.departmentId === args.departmentId);
    if (!row) throw appError("NOT_FOUND");
    if (rows.length <= 1) throw appError("INVALID", "lastDepartment");

    const before = rows.map((r) => r.departmentId);
    const wasTakenOver = await isTakenOver(ctx, before);
    await ctx.db.delete("groupDepartments", row._id);
    await postSystemMessage(ctx, {
      channelId: channel._id,
      actorId: viewer.user._id,
      event: "department_removed",
      params: { actorId: viewer.user._id, departmentId: args.departmentId },
    });
    const after = before.filter((id) => id !== args.departmentId);
    if (wasTakenOver && !(await isTakenOver(ctx, after))) {
      await postSystemMessage(ctx, {
        channelId: channel._id,
        actorId: viewer.user._id,
        event: "takeover_ended",
        params: { departmentId: args.departmentId },
      });
    }
  },
});

export const end = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel } = await requireManagedGroup(ctx, viewer, args.channelId);
    await postSystemMessage(ctx, {
      channelId: channel._id,
      actorId: viewer.user._id,
      event: "group_ended",
      params: { actorId: viewer.user._id },
    });
    await ctx.db.patch("channels", channel._id, { endedAt: Date.now() });
    await logAudit(ctx, {
      actorId: viewer.user._id,
      action: "group.end",
      targetType: "channel",
      targetId: channel._id,
    });
  },
});