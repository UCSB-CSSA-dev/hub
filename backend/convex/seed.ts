import { internalMutation } from "./_generated/server";
import { ensureSeed } from "./lib/departments";
import { upsertMembership } from "./lib/memberships";

/** Runs automatically on the first sign-in; can also be run from the Convex dashboard. */
export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ensureSeed(ctx);
  },
});

const DEMO_PEOPLE = [
  { email: "demo.alice@ucsb.edu", nameZh: "演示·爱丽丝", nameEn: "Demo Alice" },
  { email: "demo.bob@ucsb.edu", nameZh: "演示·鲍勃", nameEn: "Demo Bob" },
  { email: "demo.carol@ucsb.edu", nameZh: "演示·卡萝", nameEn: "Demo Carol" },
] as const;

/**
 * Dev helper: creates a few approved dummy members (no Google login) so you can
 * test DMs, group invites, and task assignees locally. Idempotent by email.
 * Run from the Convex dashboard / CLI: `npx convex run seed:ensureDemoPeople`
 */
export const ensureDemoPeople = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ensureSeed(ctx);
    const department =
      (
        await ctx.db
          .query("departments")
          .withIndex("by_kind", (q) => q.eq("kind", "regular"))
          .collect()
      ).find((d) => !d.archivedAt) ?? null;
    const created: string[] = [];
    for (const person of DEMO_PEOPLE) {
      const existing = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", person.email))
        .unique();
      let userId = existing?._id;
      if (!userId) {
        userId = await ctx.db.insert("users", {
          email: person.email,
          nameZh: person.nameZh,
          nameEn: person.nameEn,
          name: person.nameEn,
          status: "approved",
          oversightConsentAt: Date.now(),
          oversightConsentVersion: 3,
          reviewedAt: Date.now(),
          locale: "zh",
        });
        created.push(person.email);
      } else if (existing?.status !== "approved") {
        await ctx.db.patch("users", userId, {
          status: "approved",
          nameZh: person.nameZh,
          nameEn: person.nameEn,
          reviewedAt: Date.now(),
        });
        created.push(person.email);
      }
      if (department) {
        await upsertMembership(ctx, {
          userId,
          departmentId: department._id,
          role: "member",
        });
      }
    }
    return { created, total: DEMO_PEOPLE.length, department: department?.slug ?? null };
  },
});
