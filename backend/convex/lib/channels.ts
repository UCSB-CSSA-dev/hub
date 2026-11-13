import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { assistantKey, assistantOwner } from "./ai/sasa";
import { LIMITS } from "./constants";
import { appError } from "./errors";
import { isLiveUserContent } from "./messages";
import { findMembership } from "./memberships";
import { buildViewerContext, isLeadOf, type ViewerContext } from "./permissions";

export type Via = "member" | "oversight";
export type ReadOnlyReason = "ended" | "archived" | "deactivated";

export type ChannelAccess = {
  /** How the viewer reads the channel, or null when they can't. */
  via: Via | null;
  readOnly: ReadOnlyReason | null;
  canPost: boolean;
  /** Can post announcements: admins in the org chat, the department's 部长 and admins in a department chat. */
  canAnnounce: boolean;
  /** Can react, reply, recall, and respond to chat apps (participants of writable chats). */
  canInteract: boolean;
  /** Group chats: rename, add or remove members and departments, end. */
  canManage: boolean;
  /** 主席团 and system admins can remove any message they can read. */
  canModerate: boolean;
  canSetRetention: boolean;
  /** Can start chat apps directly and approve proposals. */
  canApproveApps: boolean;
  canProposeApps: boolean;
  canMentionAll: boolean;
};

const NO_ACCESS: ChannelAccess = {
  via: null,
  readOnly: null,
  canPost: false,
  canAnnounce: false,
  canInteract: false,
  canManage: false,
  canModerate: false,
  canSetRetention: false,
  canApproveApps: false,
  canProposeApps: false,
  canMentionAll: false,
};

export function retentionDays(channel: Doc<"channels">) {
  return channel.retentionDays ?? LIMITS.defaultRetentionDays;
}

export async function channelMemberRow(
  ctx: QueryCtx,
  channelId: Id<"channels">,
  userId: Id<"users">,
) {
  return ctx.db
    .query("channelMembers")
    .withIndex("by_channel_user", (q) => q.eq("channelId", channelId).eq("userId", userId))
    .unique();
}

/** Explicit members of a DM (every row), group or private 小飒 chat (rows with joinedAt). */
export async function explicitMembers(ctx: QueryCtx, channel: Doc<"channels">) {
  const rows = await ctx.db
    .query("channelMembers")
    .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
    .collect();
  return channel.type === "dm" ? rows : rows.filter((r) => r.joinedAt !== undefined);
}

export async function groupDepartmentIds(ctx: QueryCtx, channelId: Id<"channels">) {
  const rows = await ctx.db
    .query("groupDepartments")
    .withIndex("by_channel", (q) => q.eq("channelId", channelId))
    .collect();
  return rows.map((r) => r.departmentId);
}

/** Approved 部长 of an active department (empty when archived). */
export async function activeLeadIds(ctx: QueryCtx, departmentId: Id<"departments">) {
  const department = await ctx.db.get("departments", departmentId);
  if (!department || department.archivedAt) return [];
  const rows = await ctx.db
    .query("departmentMemberships")
    .withIndex("by_department", (q) => q.eq("departmentId", departmentId))
    .collect();
  const leads = rows.filter((m) => m.role === "lead");
  const users = await Promise.all(leads.map((m) => ctx.db.get("users", m.userId)));
  return users.filter((u) => u?.status === "approved").map((u) => u!._id);
}

/** Every active 部长 of a regular department; they're members of the 主席团 chat. */
export async function allLeadIds(ctx: QueryCtx): Promise<Id<"users">[]> {
  const departments = await ctx.db
    .query("departments")
    .withIndex("by_kind", (q) => q.eq("kind", "regular"))
    .collect();
  const ids = new Set<Id<"users">>();
  for (const department of departments) {
    for (const id of await activeLeadIds(ctx, department._id)) ids.add(id);
  }
  return [...ids];
}

async function isPresidiumDepartment(ctx: QueryCtx, departmentId: Id<"departments">) {
  return (await ctx.db.get("departments", departmentId))?.kind === "presidium";
}

/** 主席团 take over a group while any involved department is archived or has no 部长. */
export async function isTakenOver(ctx: QueryCtx, departmentIds: Id<"departments">[]) {
  for (const departmentId of departmentIds) {
    if ((await activeLeadIds(ctx, departmentId)).length === 0) return true;
  }
  return false;
}

async function isParticipant(
  ctx: QueryCtx,
  viewer: ViewerContext,
  channel: Doc<"channels">,
): Promise<boolean> {
  switch (channel.type) {
    case "org":
      return true;
    case "announcement":
    case "department": {
      if (!channel.departmentId) return true;
      if (viewer.isAdmin || viewer.memberDepartmentIds.includes(channel.departmentId)) return true;
      if (viewer.ledDepartmentIds.length > 0 && (await isPresidiumDepartment(ctx, channel.departmentId))) return true;
      // Former members keep read access to an archived department's channels.
      return (await findMembership(ctx, viewer.user._id, channel.departmentId)) !== null;
    }
    case "dm":
      return (await channelMemberRow(ctx, channel._id, viewer.user._id)) !== null;
    case "group": {
      const row = await channelMemberRow(ctx, channel._id, viewer.user._id);
      if (row?.joinedAt !== undefined) return true;
      const departmentIds = await groupDepartmentIds(ctx, channel._id);
      if (departmentIds.some((id) => viewer.ledDepartmentIds.includes(id))) return true;
      return viewer.isAdmin && (await isTakenOver(ctx, departmentIds));
    }
    case "assistant":
      return assistantOwner(channel) === viewer.user._id;
  }
}

/** People whose content is in the channel, for oversight checks. */
async function contentOwners(ctx: QueryCtx, channel: Doc<"channels">): Promise<Id<"users">[]> {
  if (channel.type === "assistant") {
    const owner = assistantOwner(channel);
    return owner ? [owner] : [];
  }
  if (channel.type === "dm" || channel.type === "group") {
    return (await explicitMembers(ctx, channel)).map((r) => r.userId);
  }
  if (channel.type === "department" && channel.departmentId) {
    const departmentId = channel.departmentId;
    const rows = await ctx.db
      .query("departmentMemberships")
      .withIndex("by_department", (q) => q.eq("departmentId", departmentId))
      .collect();
    return rows.map((r) => r.userId);
  }
  return [];
}

/** Users who are 部员 of a department the viewer leads. */
async function overseenMemberIds(ctx: QueryCtx, viewer: ViewerContext) {
  const ids = new Set<Id<"users">>();
  for (const departmentId of viewer.ledDepartmentIds) {
    const rows = await ctx.db
      .query("departmentMemberships")
      .withIndex("by_department", (q) => q.eq("departmentId", departmentId))
      .collect();
    for (const row of rows) if (row.role === "member") ids.add(row.userId);
  }
  ids.delete(viewer.user._id);
  return ids;
}

/** `oversees(viewer, subject)` from doc/02-roles-and-permissions.md. */
export async function oversees(ctx: QueryCtx, viewer: ViewerContext, subjectId: Id<"users">) {
  if (subjectId === viewer.user._id) return false;
  if (viewer.isAdmin) return true;
  return (await overseenMemberIds(ctx, viewer)).has(subjectId);
}

/** Everyone the viewer oversees: all approved users for admins, 部员 of led departments for 部长. */
export async function overseenUserIds(ctx: QueryCtx, viewer: ViewerContext): Promise<Id<"users">[]> {
  if (viewer.isAdmin) {
    const users = await ctx.db
      .query("users")
      .withIndex("by_status", (q) => q.eq("status", "approved"))
      .collect();
    return users.map((u) => u._id).filter((id) => id !== viewer.user._id);
  }
  return [...(await overseenMemberIds(ctx, viewer))];
}

async function canReadViaOversight(ctx: QueryCtx, viewer: ViewerContext, channel: Doc<"channels">) {
  if (!["dm", "group", "department", "assistant"].includes(channel.type)) return false;
  if (viewer.isAdmin) return true;
  if (viewer.ledDepartmentIds.length === 0) return false;
  const overseen = await overseenMemberIds(ctx, viewer);
  return (await contentOwners(ctx, channel)).some((id) => overseen.has(id));
}

async function readOnlyReason(
  ctx: QueryCtx,
  viewer: ViewerContext,
  channel: Doc<"channels">,
): Promise<ReadOnlyReason | null> {
  if (channel.type === "group" && channel.endedAt) return "ended";
  if (channel.departmentId) {
    const department = await ctx.db.get("departments", channel.departmentId);
    if (!department || department.archivedAt) return "archived";
  }
  if (channel.type === "dm") {
    const rows = await explicitMembers(ctx, channel);
    const otherId = rows.find((r) => r.userId !== viewer.user._id)?.userId;
    const other = otherId ? await ctx.db.get("users", otherId) : null;
    if (!other || other.status !== "approved") return "deactivated";
  }
  return null;
}

export async function channelAccess(
  ctx: QueryCtx,
  viewer: ViewerContext,
  channel: Doc<"channels">,
): Promise<ChannelAccess> {
  const participant = await isParticipant(ctx, viewer, channel);
  if (!participant) {
    if (!(await canReadViaOversight(ctx, viewer, channel))) return NO_ACCESS;
    return { ...NO_ACCESS, via: "oversight", canModerate: viewer.isAdmin };
  }

  const readOnly = await readOnlyReason(ctx, viewer, channel);
  const writable = readOnly === null;
  const departmentId = channel.departmentId;
  const leadsChannelDepartment = departmentId !== undefined && isLeadOf(viewer, departmentId);

  let leadsInvolved = false;
  if (channel.type === "group") {
    const departmentIds = await groupDepartmentIds(ctx, channel._id);
    leadsInvolved = departmentIds.some((id) => viewer.ledDepartmentIds.includes(id));
  }

  // Legacy announcement channels stay read-only until the merge migration removes them.
  const canPost = writable && channel.type !== "announcement";
  const leadsOwnChannel =
    viewer.isAdmin || (channel.type === "department" && leadsChannelDepartment);

  let canApproveApps = false;
  switch (channel.type) {
    case "org":
    case "department":
      canApproveApps = leadsOwnChannel;
      break;
    case "group":
      canApproveApps = leadsInvolved || viewer.isAdmin;
      break;
  }

  const assistant = channel.type === "assistant";
  let canSetRetention = viewer.isAdmin && !assistant;
  if (channel.type === "group") canSetRetention ||= viewer.ledDepartmentIds.length > 0;
  if (channel.type === "department") canSetRetention ||= leadsChannelDepartment;

  return {
    via: "member",
    readOnly,
    canPost,
    canAnnounce: canPost && (channel.type === "org" || channel.type === "department") && leadsOwnChannel,
    canInteract: writable,
    canManage: channel.type === "group" && writable && (leadsInvolved || viewer.isAdmin),
    canModerate: viewer.isAdmin,
    canSetRetention: canSetRetention && (channel.type !== "group" || writable),
    canApproveApps: writable && canApproveApps,
    canProposeApps: writable && channel.type !== "dm" && !assistant,
    canMentionAll:
      canPost && !assistant && (viewer.isAdmin || (channel.type === "department" && leadsChannelDepartment)),
  };
}

/** Loads a channel and the viewer's access, throwing NOT_FOUND when they can't read it. */
export async function requireChannelAccess(
  ctx: QueryCtx,
  viewer: ViewerContext,
  channelId: Id<"channels">,
) {
  const channel = await ctx.db.get("channels", channelId);
  if (!channel) throw appError("NOT_FOUND");
  const access = await channelAccess(ctx, viewer, channel);
  if (!access.via) throw appError("NOT_FOUND");
  return { channel, access };
}

/** Whether `userId` reads the channel as a participant (used to validate mentions and notifications). */
export async function userParticipates(ctx: QueryCtx, userId: Id<"users">, channel: Doc<"channels">) {
  const user = await ctx.db.get("users", userId);
  if (!user || user.status !== "approved") return false;
  return isParticipant(ctx, await buildViewerContext(ctx, user), channel);
}

/**
 * Who should get channel-wide notifications (announcements, @all): department members for
 * department channels (plus every 部长 for the 主席团 chat), everyone for org-wide ones,
 * members for groups and DMs.
 */
export async function channelAudience(ctx: QueryCtx, channel: Doc<"channels">): Promise<Id<"users">[]> {
  const ids = new Set<Id<"users">>();
  if (channel.type === "org") {
    const users = await ctx.db
      .query("users")
      .withIndex("by_status", (q) => q.eq("status", "approved"))
      .collect();
    for (const user of users) ids.add(user._id);
    return [...ids];
  }
  if (channel.departmentId) {
    const departmentId = channel.departmentId;
    const rows = await ctx.db
      .query("departmentMemberships")
      .withIndex("by_department", (q) => q.eq("departmentId", departmentId))
      .collect();
    for (const row of rows) ids.add(row.userId);
    if (await isPresidiumDepartment(ctx, departmentId)) {
      for (const id of await allLeadIds(ctx)) ids.add(id);
    }
  } else {
    for (const row of await explicitMembers(ctx, channel)) ids.add(row.userId);
    if (channel.type === "group") {
      const departmentIds = await groupDepartmentIds(ctx, channel._id);
      for (const departmentId of departmentIds) {
        for (const leadId of await activeLeadIds(ctx, departmentId)) ids.add(leadId);
      }
      if (await isTakenOver(ctx, departmentIds)) {
        for (const id of await presidiumUserIds(ctx)) ids.add(id);
      }
    }
  }
  const users = await Promise.all([...ids].map((id) => ctx.db.get("users", id)));
  return users.filter((u) => u?.status === "approved").map((u) => u!._id);
}

/** Approved members of 主席团 plus system admins. */
/** Approved members of 主席团 itself (not system admins who aren't in it). */
export async function presidiumMemberIds(ctx: QueryCtx): Promise<Id<"users">[]> {
  const ids = new Set<Id<"users">>();
  const presidiums = await ctx.db
    .query("departments")
    .withIndex("by_kind", (q) => q.eq("kind", "presidium"))
    .collect();
  for (const presidium of presidiums) {
    const rows = await ctx.db
      .query("departmentMemberships")
      .withIndex("by_department", (q) => q.eq("departmentId", presidium._id))
      .collect();
    for (const row of rows) ids.add(row.userId);
  }
  const users = await Promise.all([...ids].map((id) => ctx.db.get("users", id)));
  return users.filter((u) => u?.status === "approved").map((u) => u!._id);
}

export async function systemAdminIds(ctx: QueryCtx): Promise<Id<"users">[]> {
  const admins = await ctx.db
    .query("users")
    .withIndex("by_isSystemAdmin", (q) => q.eq("isSystemAdmin", true))
    .collect();
  return admins.filter((u) => u.status === "approved").map((u) => u._id);
}

/** Everyone with 主席团-level access: 主席团 members and system admins. */
export async function presidiumUserIds(ctx: QueryCtx): Promise<Id<"users">[]> {
  return [...new Set([...(await presidiumMemberIds(ctx)), ...(await systemAdminIds(ctx))])];
}

/** Messages before this count as read (and announcements as seen) for a channel the user never opened. */
export function readBaseline(user: Doc<"users">) {
  return user.reviewedAt ?? user._creationTime;
}

/** Live announcements by others that the user hasn't acknowledged yet, newest first. */
export async function unseenAnnouncements(
  ctx: QueryCtx,
  channelId: Id<"channels">,
  user: Doc<"users">,
  row: Doc<"channelMembers"> | null,
  limit: number,
) {
  const since = row?.announcementsReadAt ?? readBaseline(user);
  const rows = await ctx.db
    .query("messages")
    .withIndex("by_channel_announcement", (q) =>
      q.eq("channelId", channelId).eq("announcement", true).gt("_creationTime", since),
    )
    .order("desc")
    .take(limit);
  return rows.filter((m) => m.authorId !== user._id && isLiveUserContent(m));
}

/** Sets read state to now, creating the row lazily. Never adds membership. */
export async function touchReadState(
  ctx: MutationCtx,
  channelId: Id<"channels">,
  userId: Id<"users">,
  at = Date.now(),
) {
  const row = await channelMemberRow(ctx, channelId, userId);
  if (row) await ctx.db.patch("channelMembers", row._id, { lastReadAt: at });
  else await ctx.db.insert("channelMembers", { channelId, userId, lastReadAt: at });
}

/** The chats in the viewer's list: the org chat, their departments (every one for admins), groups and DMs. */
export async function myChannels(ctx: QueryCtx, viewer: ViewerContext) {
  const departments = new Map(
    (await ctx.db.query("departments").collect()).map((d) => [d._id, d]),
  );
  const sortOrder = (c: Doc<"channels">) =>
    c.departmentId ? (departments.get(c.departmentId)?.sortOrder ?? 0) : -1;
  const visibleDepartment = (c: Doc<"channels">) => {
    if (!c.departmentId) return true;
    const department = departments.get(c.departmentId);
    return (
      department !== undefined &&
      !department.archivedAt &&
      (viewer.isAdmin ||
        viewer.memberDepartmentIds.includes(department._id) ||
        (department.kind === "presidium" && viewer.ledDepartmentIds.length > 0))
    );
  };

  const org = await ctx.db
    .query("channels")
    .withIndex("by_type", (q) => q.eq("type", "org"))
    .collect();
  const departmentChannels = (
    await ctx.db
      .query("channels")
      .withIndex("by_type", (q) => q.eq("type", "department"))
      .collect()
  )
    .filter((c) => c.departmentId !== undefined && visibleDepartment(c))
    .sort((a, b) => sortOrder(a) - sortOrder(b));

  const myRows = await ctx.db
    .query("channelMembers")
    .withIndex("by_user", (q) => q.eq("userId", viewer.user._id))
    .collect();
  const dmChannels: Doc<"channels">[] = [];
  const groupIds = new Set<Id<"channels">>();
  for (const row of myRows) {
    const channel = await ctx.db.get("channels", row.channelId);
    if (channel?.type === "dm") dmChannels.push(channel);
    if (channel?.type === "group" && row.joinedAt !== undefined) groupIds.add(channel._id);
  }
  for (const departmentId of viewer.ledDepartmentIds) {
    const rows = await ctx.db
      .query("groupDepartments")
      .withIndex("by_department", (q) => q.eq("departmentId", departmentId))
      .collect();
    for (const row of rows) groupIds.add(row.channelId);
  }
  if (viewer.isAdmin) {
    const groups = await ctx.db
      .query("channels")
      .withIndex("by_type", (q) => q.eq("type", "group"))
      .collect();
    for (const group of groups) {
      if (groupIds.has(group._id)) continue;
      if (await isTakenOver(ctx, await groupDepartmentIds(ctx, group._id))) groupIds.add(group._id);
    }
  }
  const groups: Doc<"channels">[] = [];
  for (const id of groupIds) {
    const group = await ctx.db.get("channels", id);
    if (group) groups.push(group);
  }
  const assistant = await ctx.db
    .query("channels")
    .withIndex("by_dmKey", (q) => q.eq("dmKey", assistantKey(viewer.user._id)))
    .unique();
  return { org, departments: departmentChannels, groups, dms: dmChannels, assistant };
}
