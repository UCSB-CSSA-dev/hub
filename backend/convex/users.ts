import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { logAudit } from "./lib/audit";
import { CURRENT_CONSENT_VERSION, LIMITS } from "./lib/constants";
import { appError } from "./lib/errors";
import { activeLeadIds, presidiumUserIds } from "./lib/channels";
import { reviewableProposals, trackLeadership } from "./lib/groups";
import { assignMembership } from "./lib/memberships";
import {
  getViewer,
  isLeadOf,
  requireAdmin,
  requireApproved,
  requireSystemAdmin,
  requireViewer,
  type ViewerContext,
} from "./lib/permissions";
import { activePreApprovalsForEmail, claimPreApprovals } from "./lib/preApprovals";
import { deactivateUser, getUserSummaries } from "./lib/users";
import { locale, membershipRole } from "./schema";

function cleanName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > LIMITS.nameLength) throw appError("INVALID", "name");
  return trimmed;
}

/** Items waiting on the viewer: applicants they can review, plus deactivation requests for admins. */
async function reviewCount(ctx: QueryCtx, viewer: ViewerContext) {
  if (viewer.user.status !== "approved") return 0;
  if (!viewer.isAdmin && viewer.ledDepartmentIds.length === 0) return 0;
  const pending = await ctx.db
    .query("users")
    .withIndex("by_status", (q) => q.eq("status", "pending"))
    .collect();
  const applicants = viewer.isAdmin
    ? pending.length
    : pending.filter((u) => (u.requestedDepartmentIds ?? []).some((id) => isLeadOf(viewer, id))).length;
  const requests = viewer.isAdmin
    ? (
        await ctx.db
          .query("deactivationRequests")
          .withIndex("by_status", (q) => q.eq("status", "pending"))
          .collect()
      ).length
    : 0;
  return applicants + requests;
}

/** Everything the client needs to route the user and render the shell. */
export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getViewer(ctx);
    if (!viewer) return null;
    const { user } = viewer;

    const memberships = await Promise.all(
      viewer.memberships.map(async (m) => {
        const department = await ctx.db.get("departments", m.departmentId);
        return department && !department.archivedAt
          ? {
              membershipId: m._id,
              departmentId: department._id,
              role: m.role,
              kind: department.kind,
              nameZh: department.nameZh,
              nameEn: department.nameEn,
            }
          : null;
      }),
    );

    const preApprovals =
      user.status === "approved" || !user.email
        ? []
        : await Promise.all(
            (await activePreApprovalsForEmail(ctx, user.email)).map(async (p) => {
              const department = await ctx.db.get("departments", p.departmentId);
              return {
                departmentId: p.departmentId,
                role: p.role,
                nameZh: department?.nameZh ?? "",
                nameEn: department?.nameEn ?? "",
              };
            }),
          );

    const latestDeactivationRequest = await ctx.db
      .query("deactivationRequests")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .first();

    return {
      _id: user._id,
      email: user.email,
      digestEmail: user.digestEmail,
      digestLocale: user.digestLocale,
      name: user.name,
      image: user.avatarUrl ?? user.image,
      hasCustomAvatar: user.avatarStorageId !== undefined,
      bio: user.bio,
      showEmailPublicly: user.showEmailPublicly ?? false,
      nameZh: user.nameZh,
      nameEn: user.nameEn,
      status: user.status ?? "new",
      locale: user.locale ?? "zh",
      rejectionReason: user.rejectionReason,
      requestedDepartmentIds: user.requestedDepartmentIds ?? [],
      applicationNote: user.applicationNote,
      isSystemAdmin: viewer.isSystemAdmin,
      isPresidium: viewer.isPresidium,
      isAdmin: viewer.isAdmin,
      ledDepartmentIds: viewer.ledDepartmentIds,
      memberships: memberships.filter((m) => m !== null),
      preApprovals,
      deactivationRequest: latestDeactivationRequest
        ? {
            _id: latestDeactivationRequest._id,
            status: latestDeactivationRequest.status,
            createdAt: latestDeactivationRequest._creationTime,
            reviewNote: latestDeactivationRequest.reviewNote,
          }
        : null,
      reviewCount: await reviewCount(ctx, viewer),
      pendingGroupCount:
        user.status === "approved" ? (await reviewableProposals(ctx, viewer)).length : 0,
      consentVersion: user.oversightConsentVersion ?? 0,
      needsOnboarding:
        !user.nameZh ||
        !user.nameEn ||
        (user.oversightConsentVersion ?? 0) < CURRENT_CONSENT_VERSION,
    };
  },
});

/** Who can read the viewer's chats through oversight (settings, "who can see my content"). */
export const whoCanSeeMe = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireApproved(ctx);
    const admins = await ctx.db
      .query("users")
      .withIndex("by_isSystemAdmin", (q) => q.eq("isSystemAdmin", true))
      .collect();
    const adminIds = admins.filter((u) => u.status === "approved").map((u) => u._id);
    const presidiumIds = (await presidiumUserIds(ctx)).filter((id) => !adminIds.includes(id));
    const people = await getUserSummaries(ctx, [...adminIds, ...presidiumIds]);
    const pick = (ids: typeof adminIds) =>
      ids.filter((id) => id !== viewer.user._id).flatMap((id) => people.get(id) ?? []);

    const departments = [];
    for (const membership of viewer.memberships) {
      if (membership.role !== "member") continue;
      const department = await ctx.db.get("departments", membership.departmentId);
      if (!department || department.kind !== "regular" || department.archivedAt) continue;
      const leads = await getUserSummaries(ctx, await activeLeadIds(ctx, department._id));
      departments.push({
        departmentId: department._id,
        nameZh: department.nameZh,
        nameEn: department.nameEn,
        leads: [...leads.values()],
      });
    }
    return { systemAdmins: pick(adminIds), presidium: pick(presidiumIds), departments };
  },
});

export const submitOnboarding = mutation({
  args: {
    nameZh: v.string(),
    nameEn: v.string(),
    consent: v.boolean(),
    requestedDepartmentIds: v.optional(v.array(v.id("departments"))),
    applicationNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireViewer(ctx);
    const status = user.status ?? "new";
    if (status === "rejected" || status === "deactivated") throw appError("FORBIDDEN");
    if (!args.consent) throw appError("INVALID", "consent");

    await ctx.db.patch("users", user._id, {
      nameZh: cleanName(args.nameZh),
      nameEn: cleanName(args.nameEn),
      oversightConsentAt: Date.now(),
      oversightConsentVersion: CURRENT_CONSENT_VERSION,
    });
    if (status === "approved") return { status: "approved" as const };

    const claimed = await claimPreApprovals(ctx, user);
    if (claimed > 0) return { status: "approved" as const };

    const requested = [...new Set(args.requestedDepartmentIds ?? [])];
    if (requested.length === 0) throw appError("INVALID", "requestedDepartmentIds");
    for (const departmentId of requested) {
      const department = await ctx.db.get("departments", departmentId);
      if (!department || department.archivedAt || department.kind !== "regular") {
        throw appError("INVALID", "requestedDepartmentIds");
      }
    }
    const note = args.applicationNote?.trim();
    if (note && note.length > LIMITS.applicationNote) throw appError("INVALID", "applicationNote");

    await ctx.db.patch("users", user._id, {
      status: "pending",
      requestedDepartmentIds: requested,
      applicationNote: note || undefined,
    });
    return { status: "pending" as const };
  },
});

export const reapply = mutation({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireViewer(ctx);
    if (user.status !== "rejected") throw appError("FORBIDDEN");
    await ctx.db.patch("users", user._id, { status: "new", rejectionReason: undefined });
  },
});

export const updateProfile = mutation({
  args: { nameZh: v.string(), nameEn: v.string(), bio: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { user } = await requireApproved(ctx);
    const bio = args.bio?.trim();
    if (bio && bio.length > LIMITS.bio) throw appError("INVALID", "bio");
    await ctx.db.patch("users", user._id, {
      nameZh: cleanName(args.nameZh),
      nameEn: cleanName(args.nameEn),
      ...(args.bio !== undefined ? { bio: bio || undefined } : {}),
    });
  },
});

export const setShowEmailPublicly = mutation({
  args: { show: v.boolean() },
  handler: async (ctx, args) => {
    const { user } = await requireApproved(ctx);
    await ctx.db.patch("users", user._id, { showEmailPublicly: args.show || undefined });
  },
});

export const generateAvatarUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireApproved(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/** Replaces the viewer's avatar with an uploaded image. Invalid uploads are deleted. */
export const setAvatar = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const { user } = await requireApproved(ctx);
    const file = await ctx.db.system.get("_storage", args.storageId);
    if (!file) throw appError("NOT_FOUND");
    if (!file.contentType?.startsWith("image/") || file.size > LIMITS.avatarBytes) {
      await ctx.storage.delete(args.storageId);
      throw appError("INVALID", "avatar");
    }
    const url = await ctx.storage.getUrl(args.storageId);
    if (!url) throw appError("NOT_FOUND");
    if (user.avatarStorageId) await ctx.storage.delete(user.avatarStorageId);
    await ctx.db.patch("users", user._id, { avatarStorageId: args.storageId, avatarUrl: url });
  },
});

/** Falls back to the Google profile photo. */
export const removeAvatar = mutation({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireApproved(ctx);
    if (user.avatarStorageId) await ctx.storage.delete(user.avatarStorageId);
    await ctx.db.patch("users", user._id, { avatarStorageId: undefined, avatarUrl: undefined });
  },
});

export const setLocale = mutation({
  args: { locale },
  handler: async (ctx, args) => {
    const { user } = await requireViewer(ctx);
    await ctx.db.patch("users", user._id, { locale: args.locale });
  },
});

/** Where the daily digest goes; null falls back to the sign-in email. Not verified (doc 10, Q13). */
export const setDigestEmail = mutation({
  args: { email: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const { user } = await requireApproved(ctx);
    const email = args.email?.trim().toLowerCase() || undefined;
    if (email && (email.length > LIMITS.digestEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      throw appError("INVALID", "email");
    }
    await ctx.db.patch("users", user._id, { digestEmail: email === user.email ? undefined : email });
  },
});

export const setDigestLocale = mutation({
  args: { locale: v.union(v.literal("zh"), v.literal("en")) },
  handler: async (ctx, args) => {
    const { user } = await requireApproved(ctx);
    await ctx.db.patch("users", user._id, { digestLocale: args.locale });
  },
});

export const approve = mutation({
  args: {
    userId: v.id("users"),
    memberships: v.array(v.object({ departmentId: v.id("departments"), role: membershipRole })),
  },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const target = await ctx.db.get("users", args.userId);
    if (!target) throw appError("NOT_FOUND");
    if (target.status !== "pending") throw appError("ALREADY_REVIEWED");

    if (!viewer.isAdmin) {
      const requested = target.requestedDepartmentIds ?? [];
      const allowed =
        args.memberships.length > 0 &&
        args.memberships.every(
          (m) =>
            m.role === "member" &&
            isLeadOf(viewer, m.departmentId) &&
            requested.includes(m.departmentId),
        );
      if (!allowed) throw appError("FORBIDDEN");
    }

    await trackLeadership(
      ctx,
      args.memberships.map((m) => m.departmentId),
      viewer.user._id,
      async () => {
        for (const m of args.memberships) {
          const department = await ctx.db.get("departments", m.departmentId);
          if (!department || department.archivedAt) throw appError("INVALID", "departmentId");
          await assignMembership(ctx, {
            userId: target._id,
            department,
            role: m.role,
            addedBy: viewer.user._id,
          });
        }
        await ctx.db.patch("users", target._id, {
          status: "approved",
          reviewedBy: viewer.user._id,
          reviewedAt: Date.now(),
        });
      },
    );
    await logAudit(ctx, {
      actorId: viewer.user._id,
      action: "user.approve",
      targetType: "user",
      targetId: target._id,
      subjectUserId: target._id,
      metadata: { memberships: args.memberships },
    });
  },
});

export const reject = mutation({
  args: { userId: v.id("users"), reason: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    const target = await ctx.db.get("users", args.userId);
    if (!target) throw appError("NOT_FOUND");
    if (target.status !== "pending") throw appError("ALREADY_REVIEWED");
    if (
      !viewer.isAdmin &&
      !(target.requestedDepartmentIds ?? []).some((id) => isLeadOf(viewer, id))
    ) {
      throw appError("FORBIDDEN");
    }
    const reason = args.reason.trim();
    if (!reason || reason.length > LIMITS.rejectionReason) throw appError("INVALID", "reason");

    await ctx.db.patch("users", target._id, {
      status: "rejected",
      rejectionReason: reason,
      reviewedBy: viewer.user._id,
      reviewedAt: Date.now(),
    });
    await logAudit(ctx, {
      actorId: viewer.user._id,
      action: "user.reject",
      targetType: "user",
      targetId: target._id,
      subjectUserId: target._id,
      metadata: { reason },
    });
  },
});

export const setSystemAdmin = mutation({
  args: { userId: v.id("users"), value: v.boolean() },
  handler: async (ctx, args) => {
    const viewer = await requireSystemAdmin(ctx);
    const target = await ctx.db.get("users", args.userId);
    if (!target || target.status !== "approved") throw appError("NOT_FOUND");
    if ((target.isSystemAdmin === true) === args.value) return;

    if (!args.value) {
      const admins = await ctx.db
        .query("users")
        .withIndex("by_isSystemAdmin", (q) => q.eq("isSystemAdmin", true))
        .take(2);
      if (admins.length <= 1) throw appError("LAST_SYSTEM_ADMIN");
    }
    await ctx.db.patch("users", target._id, { isSystemAdmin: args.value ? true : undefined });
    await logAudit(ctx, {
      actorId: viewer.user._id,
      action: args.value ? "user.system_admin_grant" : "user.system_admin_revoke",
      targetType: "user",
      targetId: target._id,
      subjectUserId: target._id,
    });
  },
});

export const deactivate = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const viewer = await requireAdmin(ctx);
    const target = await ctx.db.get("users", args.userId);
    if (!target) throw appError("NOT_FOUND");
    if (target._id === viewer.user._id) throw appError("FORBIDDEN");
    await deactivateUser(ctx, { actorId: viewer.user._id, target });
  },
});

export const reactivate = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const viewer = await requireAdmin(ctx);
    const target = await ctx.db.get("users", args.userId);
    if (!target) throw appError("NOT_FOUND");
    if (target.status !== "deactivated") throw appError("INVALID", "status");
    const ledIds = (
      await ctx.db
        .query("departmentMemberships")
        .withIndex("by_user", (q) => q.eq("userId", target._id))
        .collect()
    )
      .filter((m) => m.role === "lead")
      .map((m) => m.departmentId);
    await trackLeadership(ctx, ledIds, viewer.user._id, () =>
      ctx.db.patch("users", target._id, { status: "approved" }),
    );
    await logAudit(ctx, {
      actorId: viewer.user._id,
      action: "user.reactivate",
      targetType: "user",
      targetId: target._id,
      subjectUserId: target._id,
    });
  },
});
