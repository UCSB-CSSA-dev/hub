import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { logAudit } from "./lib/audit";
import {
  activeLeadIds,
  channelAccess,
  channelAudience,
  channelMemberRow,
  explicitMembers,
  groupDepartmentIds,
  isTakenOver,
  oversees,
  overseenUserIds,
  readBaseline,
  requireChannelAccess,
  retentionDays,
  touchReadState,
  unseenAnnouncements,
  type ChannelAccess,
} from "./lib/channels";
import { LIMITS, RETENTION_OPTIONS } from "./lib/constants";
import { appError } from "./lib/errors";
import { isLiveUserContent, messageState, postSystemMessage, type MessageState } from "./lib/messages";
import { toMessageViews } from "./lib/messageViews";
import { requireApproved, type ViewerContext } from "./lib/permissions";
import { getUserSummaries, toUserSummary, type UserSummary } from "./lib/users";

export type ChannelView = {
  _id: Id<"channels">;
  type: Doc<"channels">["type"];
  departmentId?: Id<"departments">;
  nameZh?: string;
  nameEn?: string;
  /** Group chats */
  name?: string;
  otherUser?: UserSummary;
  /** DMs: both people (an overseer is neither). */
  dmUsers?: UserSummary[];
  lastMessageAt?: number;
  unread: number;
  /** Announcements not yet acknowledged; they ignore mute. */
  unseenAnnouncements: number;
  muted: boolean;
  ended: boolean;
  archived: boolean;
  /** Chat list only: the latest non-system message. */
  preview?: ChannelPreview | null;
  /** Chat list only: up to 9 member photos for department and group chats. */
  faces?: UserSummary[];
};

export type ChannelPreview = {
  authorId: Id<"users">;
  kind: "user" | "forward" | "task" | "doc";
  state: MessageState;
  /** Empty unless the message is still there. */
  body: string;
  announcement: boolean;
  at: number;
  /** The author and anyone mentioned in `body`. */
  people: UserSummary[];
};

const PREVIEW_BODY_CHARS = 200;
const PREVIEW_SCAN = 20;
const MAX_FACES = 9;

async function channelPreview(ctx: QueryCtx, channel: Doc<"channels">): Promise<ChannelPreview | null> {
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
    .order("desc")
    .take(PREVIEW_SCAN);
  const message = recent.find((m) => (m.kind ?? "user") !== "system");
  if (!message) return null;
  const state = messageState(message);
  const body = state === "normal" ? message.body.slice(0, PREVIEW_BODY_CHARS) : "";
  const people = await getUserSummaries(ctx, [message.authorId, ...(message.mentionUserIds ?? [])]);
  return {
    authorId: message.authorId,
    kind: (message.kind ?? "user") as ChannelPreview["kind"],
    state,
    body,
    announcement: message.announcement === true,
    at: message._creationTime,
    people: [...people.values()],
  };
}

/** Adds what the chat list shows beyond the name: the latest message and, for team chats, member photos. */
async function withListDetails(ctx: QueryCtx, channel: Doc<"channels">, view: ChannelView): Promise<ChannelView> {
  view.preview = await channelPreview(ctx, channel);
  if (channel.type === "department" || channel.type === "group") {
    const ids = (await channelAudience(ctx, channel)).slice(0, MAX_FACES);
    const people = await getUserSummaries(ctx, ids);
    view.faces = ids.flatMap((id) => people.get(id) ?? []);
  }
  return view;
}

async function toChannelView(
  ctx: QueryCtx,
  viewer: ViewerContext,
  channel: Doc<"channels">,
  countUnread = true,
): Promise<ChannelView> {
  const state = await channelMemberRow(ctx, channel._id, viewer.user._id);
  const view: ChannelView = {
    _id: channel._id,
    type: channel.type,
    departmentId: channel.departmentId,
    name: channel.name,
    lastMessageAt: channel.lastMessageAt,
    unread: 0,
    unseenAnnouncements: 0,
    muted: state?.muted === true,
    ended: channel.endedAt !== undefined,
    archived: false,
  };

  if (countUnread) {
    const lastReadAt = state?.lastReadAt ?? readBaseline(viewer.user);
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", channel._id).gt("_creationTime", lastReadAt))
      .take(LIMITS.unreadCountCap + 20);
    view.unread = recent.filter(
      (m) => m.authorId !== viewer.user._id && isLiveUserContent(m),
    ).length;
    if (channel.type === "org" || channel.type === "department") {
      view.unseenAnnouncements = (
        await unseenAnnouncements(ctx, channel._id, viewer.user, state, LIMITS.unreadCountCap + 20)
      ).length;
    }
  }

  if (channel.departmentId) {
    const department = await ctx.db.get("departments", channel.departmentId);
    view.nameZh = department?.nameZh;
    view.nameEn = department?.nameEn;
    view.archived = !department || department.archivedAt !== undefined;
  } else if (channel.type === "dm") {
    const members = await explicitMembers(ctx, channel);
    const summaries = await getUserSummaries(ctx, members.map((m) => m.userId));
    view.dmUsers = [...summaries.values()];
    const otherId = members.find((m) => m.userId !== viewer.user._id)?.userId;
    const other = otherId ? await ctx.db.get("users", otherId) : null;
    if (other) view.otherUser = toUserSummary(other);
  }
  return view;
}

function byRecent(a: ChannelView, b: ChannelView) {
  return (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
}

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireApproved(ctx);
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
        (viewer.isAdmin || viewer.memberDepartmentIds.includes(department._id))
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

    const views = (list: Doc<"channels">[]) =>
      Promise.all(list.map(async (c) => withListDetails(ctx, c, await toChannelView(ctx, viewer, c))));
    return {
      org: await views(org),
      departments: await views(departmentChannels),
      groups: (await views(groups)).sort(byRecent),
      dms: (await views(dmChannels)).sort(byRecent),
    };
  },
});

/** Chats the viewer can post in, for the forward picker. */
export const postable = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireApproved(ctx);
    const ids = new Set<Id<"channels">>();
    for (const type of ["org", "department", "group"] as const) {
      const channels = await ctx.db
        .query("channels")
        .withIndex("by_type", (q) => q.eq("type", type))
        .collect();
      for (const channel of channels) ids.add(channel._id);
    }
    const myRows = await ctx.db
      .query("channelMembers")
      .withIndex("by_user", (q) => q.eq("userId", viewer.user._id))
      .collect();
    for (const row of myRows) ids.add(row.channelId);

    const result: ChannelView[] = [];
    for (const id of ids) {
      const channel = await ctx.db.get("channels", id);
      if (!channel) continue;
      const access = await channelAccess(ctx, viewer, channel);
      if (access.via === "member" && access.canPost) {
        result.push(await toChannelView(ctx, viewer, channel, false));
      }
    }
    return result.sort(byRecent);
  },
});

export type ChannelDetail = ChannelView & {
  access: ChannelAccess;
  retentionDays: number;
};

/** One channel with the viewer's access, or null when they can't read it. */
export const get = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args): Promise<ChannelDetail | null> => {
    const viewer = await requireApproved(ctx);
    const channel = await ctx.db.get("channels", args.channelId);
    if (!channel) return null;
    const access = await channelAccess(ctx, viewer, channel);
    if (!access.via) return null;
    const view = await toChannelView(ctx, viewer, channel, access.via === "member");
    return { ...view, access, retentionDays: retentionDays(channel) };
  },
});

/** People who read the chat as participants, for the @ picker. */
export const participants = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel, access } = await requireChannelAccess(ctx, viewer, args.channelId);
    if (access.via !== "member") return [];
    const summaries = await getUserSummaries(ctx, await channelAudience(ctx, channel));
    return [...summaries.values()].sort((a, b) => (a.nameEn ?? "").localeCompare(b.nameEn ?? ""));
  },
});

/** Who can view a chat beyond its participants, for the monitored icon. */
export const watchers = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel } = await requireChannelAccess(ctx, viewer, args.channelId);
    if (channel.type === "org") return { visibleToAll: true, leads: [] };

    let ownerIds: Id<"users">[] = [];
    if (channel.type === "department" && channel.departmentId) {
      const departmentId = channel.departmentId;
      ownerIds = (
        await ctx.db
          .query("departmentMemberships")
          .withIndex("by_department", (q) => q.eq("departmentId", departmentId))
          .collect()
      ).map((m) => m.userId);
    } else {
      ownerIds = (await explicitMembers(ctx, channel)).map((m) => m.userId);
    }

    // 部长 of every regular department where a participant is a 部员.
    const departmentIds = new Set<Id<"departments">>();
    for (const userId of ownerIds) {
      const memberships = await ctx.db
        .query("departmentMemberships")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      for (const m of memberships) if (m.role === "member") departmentIds.add(m.departmentId);
    }
    const leads: { departmentId: Id<"departments">; nameZh: string; nameEn: string; people: UserSummary[] }[] = [];
    for (const departmentId of departmentIds) {
      const department = await ctx.db.get("departments", departmentId);
      if (!department || department.kind !== "regular" || department.archivedAt) continue;
      const leadIds = await activeLeadIds(ctx, departmentId);
      if (leadIds.length === 0) continue;
      const summaries = await getUserSummaries(ctx, leadIds);
      leads.push({
        departmentId,
        nameZh: department.nameZh,
        nameEn: department.nameEn,
        people: [...summaries.values()],
      });
    }
    return { visibleToAll: false, leads };
  },
});

export const getOrCreateDm = mutation({
  args: { otherUserId: v.id("users") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    if (args.otherUserId === viewer.user._id) throw appError("INVALID", "self");
    const other = await ctx.db.get("users", args.otherUserId);
    if (!other || other.status !== "approved") throw appError("NOT_FOUND");

    const dmKey = [viewer.user._id, other._id].sort().join(":");
    const existing = await ctx.db
      .query("channels")
      .withIndex("by_dmKey", (q) => q.eq("dmKey", dmKey))
      .unique();
    if (existing) return existing._id;

    const now = Date.now();
    const channelId = await ctx.db.insert("channels", {
      type: "dm",
      dmKey,
      createdBy: viewer.user._id,
    });
    for (const userId of [viewer.user._id, other._id]) {
      await ctx.db.insert("channelMembers", { channelId, userId, lastReadAt: now, joinedAt: now });
    }
    return channelId;
  },
});

/** Participants only; reading through oversight never changes read state. */
export const markRead = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel, access } = await requireChannelAccess(ctx, viewer, args.channelId);
    if (access.via !== "member") return;
    await touchReadState(ctx, channel._id, viewer.user._id);
  },
});

/** Unacknowledged announcements for the bar at the top of a chat, newest first. */
export const unseenAnnouncementList = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel, access } = await requireChannelAccess(ctx, viewer, args.channelId);
    if (access.via !== "member") return [];
    const row = await channelMemberRow(ctx, channel._id, viewer.user._id);
    const messages = await unseenAnnouncements(ctx, channel._id, viewer.user, row, LIMITS.announcementBar);
    return toMessageViews(ctx, viewer.user._id, messages);
  },
});

/** Acknowledges every announcement in the chat up to now. */
export const markAnnouncementsSeen = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel, access } = await requireChannelAccess(ctx, viewer, args.channelId);
    if (access.via !== "member") return;
    const now = Date.now();
    const row = await channelMemberRow(ctx, channel._id, viewer.user._id);
    if (row) await ctx.db.patch("channelMembers", row._id, { announcementsReadAt: now });
    else {
      await ctx.db.insert("channelMembers", {
        channelId: channel._id,
        userId: viewer.user._id,
        lastReadAt: readBaseline(viewer.user),
        announcementsReadAt: now,
      });
    }
  },
});

export const setMuted = mutation({
  args: { channelId: v.id("channels"), muted: v.boolean() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel, access } = await requireChannelAccess(ctx, viewer, args.channelId);
    if (access.via !== "member") throw appError("FORBIDDEN");
    const row = await channelMemberRow(ctx, channel._id, viewer.user._id);
    if (row) await ctx.db.patch("channelMembers", row._id, { muted: args.muted });
    else {
      await ctx.db.insert("channelMembers", {
        channelId: channel._id,
        userId: viewer.user._id,
        lastReadAt: Date.now(),
        muted: args.muted,
      });
    }
  },
});

export const setRetention = mutation({
  args: { channelId: v.id("channels"), days: v.number() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    if (!(RETENTION_OPTIONS as readonly number[]).includes(args.days)) throw appError("INVALID", "days");
    const { channel, access } = await requireChannelAccess(ctx, viewer, args.channelId);
    if (!access.canSetRetention) throw appError("FORBIDDEN");
    const from = retentionDays(channel);
    if (from === args.days) return;
    await ctx.db.patch("channels", channel._id, { retentionDays: args.days });
    await postSystemMessage(ctx, {
      channelId: channel._id,
      actorId: viewer.user._id,
      event: "retention_changed",
      params: { actorId: viewer.user._id, from, to: args.days },
    });
    await logAudit(ctx, {
      actorId: viewer.user._id,
      action: "channel.retention_change",
      targetType: "channel",
      targetId: channel._id,
      metadata: { from, to: args.days },
    });
  },
});

/**
 * Called by the client when it opens a channel. Writes one oversight audit row per open;
 * repeats within LIMITS.oversightLogWindowMs (re-renders, reconnects) are ignored.
 */
export const recordOversightOpen = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const { channel, access } = await requireChannelAccess(ctx, viewer, args.channelId);
    if (access.via !== "oversight") return;
    const since = Date.now() - LIMITS.oversightLogWindowMs;
    const recent = await ctx.db
      .query("auditLogs")
      .withIndex("by_actor", (q) => q.eq("actorId", viewer.user._id).gt("_creationTime", since))
      .collect();
    if (recent.some((r) => r.action === "oversight.channel.open" && r.targetId === channel._id)) return;

    const owners =
      channel.type === "department"
        ? []
        : (await explicitMembers(ctx, channel)).map((m) => m.userId);
    await logAudit(ctx, {
      actorId: viewer.user._id,
      action: "oversight.channel.open",
      targetType: "channel",
      targetId: channel._id,
      subjectUserId: owners.find((id) => id !== viewer.user._id),
      metadata: { type: channel.type, participants: owners },
    });
  },
});

/** People the viewer oversees, for the oversight section. Empty for 部员. */
export const oversightPeople = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireApproved(ctx);
    if (!viewer.isAdmin && viewer.ledDepartmentIds.length === 0) return [];
    const ids = await overseenUserIds(ctx, viewer);
    const summaries = await getUserSummaries(ctx, ids);
    return [...summaries.values()].filter((p) => p.status === "approved");
  },
});

/** A person's chats the viewer can read only through oversight; null if the viewer doesn't oversee them. */
export const oversightChannels = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    if (!(await oversees(ctx, viewer, args.userId))) return null;
    const candidates = new Map<Id<"channels">, Doc<"channels">>();
    const rows = await ctx.db
      .query("channelMembers")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const row of rows) {
      const channel = await ctx.db.get("channels", row.channelId);
      if (!channel) continue;
      if (channel.type === "dm" || (channel.type === "group" && row.joinedAt !== undefined)) {
        candidates.set(channel._id, channel);
      }
    }
    const memberships = await ctx.db
      .query("departmentMemberships")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const membership of memberships) {
      const channels = await ctx.db
        .query("channels")
        .withIndex("by_department", (q) => q.eq("departmentId", membership.departmentId))
        .collect();
      for (const channel of channels) if (channel.type === "department") candidates.set(channel._id, channel);
    }

    const result: ChannelView[] = [];
    for (const channel of candidates.values()) {
      const access = await channelAccess(ctx, viewer, channel);
      if (access.via === "oversight") result.push(await toChannelView(ctx, viewer, channel, false));
    }
    return result.sort(byRecent);
  },
});
