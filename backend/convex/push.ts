import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { appError } from "./lib/errors";
import { requireApproved, requireViewer } from "./lib/permissions";
import { pushInputValidator, queuePush } from "./lib/push";
import type { PushLocale, PushLookup } from "./lib/pushText";

const MAX_DEVICES_PER_USER = 10;
const USER_PARAMS = ["actorId", "proposerId", "reviewerId"] as const;

/** The VAPID public key browsers need to subscribe; null until the deployment is configured. */
export const config = query({
  args: {},
  handler: async () => ({ publicKey: process.env.VAPID_PUBLIC_KEY || null }),
});

export const subscribe = mutation({
  args: { endpoint: v.string(), p256dh: v.string(), auth: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireApproved(ctx);
    if (!args.endpoint.startsWith("https://") || args.endpoint.length > 2000) throw appError("INVALID", "endpoint");
    if (args.p256dh.length > 200 || args.auth.length > 100) throw appError("INVALID", "keys");

    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .unique();
    if (existing) {
      // The same browser can switch accounts; the device follows whoever subscribed last.
      await ctx.db.patch("pushSubscriptions", existing._id, { userId: viewer.user._id, p256dh: args.p256dh, auth: args.auth });
      return;
    }
    await ctx.db.insert("pushSubscriptions", { userId: viewer.user._id, ...args });

    const devices = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_user", (q) => q.eq("userId", viewer.user._id))
      .collect();
    for (const old of devices.slice(0, Math.max(0, devices.length - MAX_DEVICES_PER_USER))) {
      await ctx.db.delete("pushSubscriptions", old._id);
    }
  },
});

export const unsubscribe = mutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireViewer(ctx);
    const row = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .unique();
    if (row && row.userId === viewer.user._id) await ctx.db.delete("pushSubscriptions", row._id);
  },
});

/** Sends a test notification to every device the viewer has subscribed. */
export const sendTest = mutation({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireApproved(ctx);
    await queuePush(ctx, [viewer.user._id], { type: "test", params: {}, link: "/settings/?tab=notifications", tag: "test" });
  },
});

export const targets = internalQuery({
  args: { userIds: v.array(v.id("users")), input: pushInputValidator },
  handler: async (ctx, args) => {
    const devices: { endpoint: string; p256dh: string; auth: string; locale: PushLocale }[] = [];
    for (const userId of args.userIds) {
      const user = await ctx.db.get("users", userId);
      if (!user || user.status !== "approved") continue;
      const rows = await ctx.db
        .query("pushSubscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      for (const row of rows) {
        devices.push({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth, locale: user.locale ?? "zh" });
      }
    }

    const params = (args.input.params ?? {}) as Record<string, unknown>;
    const lookup: PushLookup = { people: {}, departments: {} };
    for (const key of USER_PARAMS) {
      const id = typeof params[key] === "string" ? ctx.db.normalizeId("users", params[key]) : null;
      const person = id ? await ctx.db.get("users", id) : null;
      if (person) {
        lookup.people[person._id] = { name: person.name, nameZh: person.nameZh, nameEn: person.nameEn, email: person.email };
      }
    }
    const departmentId =
      typeof params.departmentId === "string" ? ctx.db.normalizeId("departments", params.departmentId) : null;
    const department = departmentId ? await ctx.db.get("departments", departmentId) : null;
    if (department) lookup.departments[department._id] = { nameZh: department.nameZh, nameEn: department.nameEn };

    return { devices, lookup };
  },
});

/** Drops subscriptions the push service reported as expired or unsubscribed. */
export const removeEndpoints = internalMutation({
  args: { endpoints: v.array(v.string()) },
  handler: async (ctx, args) => {
    for (const endpoint of args.endpoints) {
      const row = await ctx.db
        .query("pushSubscriptions")
        .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
        .unique();
      if (row) await ctx.db.delete("pushSubscriptions", row._id);
    }
  },
});