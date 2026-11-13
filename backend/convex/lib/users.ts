import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { logAudit } from "./audit";
import { ensureSeed } from "./departments";
import { isAllowedEmail, normalizeEmail } from "./email";
import { appError } from "./errors";
import { cancelProposalsOf, trackLeadership } from "./groups";
import { findMembership, getPresidium } from "./memberships";

export type UserSummary = {
  _id: Id<"users">;
  name?: string;
  nameZh?: string;
  nameEn?: string;
  email?: string;
  image?: string;
  bio?: string;
  isSystemAdmin: boolean;
  status?: Doc<"users">["status"];
  /** 小飒 */
  isBot?: boolean;
};

export function toUserSummary(user: Doc<"users">): UserSummary {
  return {
    _id: user._id,
    name: user.name,
    nameZh: user.nameZh,
    nameEn: user.nameEn,
    email: user.email,
    image: user.avatarUrl ?? user.image,
    bio: user.bio,
    isSystemAdmin: user.isSystemAdmin === true,
    status: user.status,
    ...(user.isBot ? { isBot: true } : {}),
  };
}

export async function getUserSummaries(
  ctx: QueryCtx,
  ids: Id<"users">[],
): Promise<Map<Id<"users">, UserSummary>> {
  const unique = [...new Set(ids)];
  const users = await Promise.all(unique.map((id) => ctx.db.get("users", id)));
  const map = new Map<Id<"users">, UserSummary>();
  for (const user of users) if (user) map.set(user._id, toUserSummary(user));
  return map;
}

/**
 * Deactivates an approved user and closes any pending self-deactivation request.
 * System admins and the 主席 must hand over their roles first.
 */
export async function deactivateUser(
  ctx: MutationCtx,
  args: { actorId: Id<"users">; target: Doc<"users">; requestId?: Id<"deactivationRequests"> },
) {
  const { target } = args;
  if (target.isSystemAdmin) throw appError("FORBIDDEN");
  if (target.status !== "approved") throw appError("INVALID", "status");
  const presidium = await getPresidium(ctx);
  if (presidium && (await findMembership(ctx, target._id, presidium._id))?.role === "lead") {
    throw appError("CHAIR_REQUIRED");
  }

  const ledIds = (
    await ctx.db
      .query("departmentMemberships")
      .withIndex("by_user", (q) => q.eq("userId", target._id))
      .collect()
  )
    .filter((m) => m.role === "lead")
    .map((m) => m.departmentId);
  await trackLeadership(ctx, ledIds, args.actorId, () =>
    ctx.db.patch("users", target._id, { status: "deactivated" }),
  );
  await cancelProposalsOf(ctx, target._id);
  const pending = await ctx.db
    .query("deactivationRequests")
    .withIndex("by_user", (q) => q.eq("userId", target._id))
    .collect();
  for (const request of pending) {
    if (request.status !== "pending") continue;
    await ctx.db.patch("deactivationRequests", request._id, {
      status: "approved",
      reviewedBy: args.actorId,
      reviewedAt: Date.now(),
    });
  }
  await logAudit(ctx, {
    actorId: args.actorId,
    action: "user.deactivate",
    targetType: "user",
    targetId: target._id,
    subjectUserId: target._id,
    metadata: args.requestId ? { requestId: args.requestId } : undefined,
  });
}

export type OAuthProfile = {
  email?: string;
  name?: unknown;
  image?: unknown;
  emailVerified?: boolean;
};

/**
 * Called by Convex Auth on every OAuth sign-in. Enforces the email domain and makes the
 * first account the system admin (optionally locked to BOOTSTRAP_ADMIN_EMAIL).
 */
export async function upsertUserFromOAuth(
  ctx: MutationCtx,
  args: { existingUserId: Id<"users"> | null; profile: OAuthProfile },
): Promise<Id<"users">> {
  const email = normalizeEmail(args.profile.email ?? "");
  if (!isAllowedEmail(email) || args.profile.emailVerified === false) {
    throw appError("DOMAIN_NOT_ALLOWED");
  }
  const name = typeof args.profile.name === "string" ? args.profile.name : undefined;
  const image = typeof args.profile.image === "string" ? args.profile.image : undefined;

  const existing = args.existingUserId
    ? await ctx.db.get("users", args.existingUserId)
    : await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .first();
  await ensureSeed(ctx);
  if (existing) {
    await ctx.db.patch("users", existing._id, { name, image, email });
    return existing._id;
  }

  const existingAdmin = await ctx.db
    .query("users")
    .withIndex("by_isSystemAdmin", (q) => q.eq("isSystemAdmin", true))
    .first();
  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL
    ? normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL)
    : null;
  const becomesSystemAdmin = !existingAdmin && (!bootstrapEmail || bootstrapEmail === email);

  const now = Date.now();
  const userId = await ctx.db.insert("users", {
    email,
    name,
    image,
    emailVerificationTime: now,
    status: becomesSystemAdmin ? "approved" : "new",
    locale: "zh",
    ...(becomesSystemAdmin ? { isSystemAdmin: true, reviewedAt: now } : {}),
  });

  if (becomesSystemAdmin) {
    await logAudit(ctx, {
      actorId: userId,
      action: "user.system_admin_bootstrap",
      targetType: "user",
      targetId: userId,
      subjectUserId: userId,
    });
  }
  return userId;
}
