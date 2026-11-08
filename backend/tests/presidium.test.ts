import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addMember, bootstrapAdmin, departmentBySlug, setup, type TestConvex } from "./helpers";

async function membershipId(t: TestConvex, userId: Id<"users">, slug: string) {
  const department = await departmentBySlug(t, slug);
  const row = await t.run((ctx) =>
    ctx.db
      .query("departmentMemberships")
      .withIndex("by_user_department", (q) =>
        q.eq("userId", userId).eq("departmentId", department._id),
      )
      .unique(),
  );
  if (!row) throw new Error("missing membership");
  return row._id;
}

async function presidiumSetup() {
  const t = setup();
  const admin = await bootstrapAdmin(t);
  const chair = await addMember(t, admin.as, "chair@ucsb.edu", "presidium", "lead");
  const vice = await addMember(t, admin.as, "vice@ucsb.edu", "presidium", "member");
  return { t, admin, chair, vice };
}

describe("主席 / 副主席", () => {
  test("there is only one 主席", async () => {
    const { t, admin, vice } = await presidiumSetup();
    const presidium = await departmentBySlug(t, "presidium");
    await expect(
      admin.as.mutation(api.memberships.setRole, {
        membershipId: await membershipId(t, vice.userId, "presidium"),
        role: "lead",
      }),
    ).rejects.toThrow(/CHAIR_EXISTS/);
    await expect(
      admin.as.mutation(api.preApprovals.createMany, {
        emails: ["next@ucsb.edu"],
        departmentId: presidium._id,
        role: "lead",
      }),
    ).rejects.toThrow(/CHAIR_EXISTS/);
  });

  test("a 副主席 cannot make themselves 主席", async () => {
    const { vice } = await presidiumSetup();
    await expect(
      vice.as.mutation(api.presidium.transferChair, { userId: vice.userId }),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  test("the 主席 must hand over before retiring, then becomes 前主席", async () => {
    const { t, chair, vice } = await presidiumSetup();
    await expect(
      chair.as.mutation(api.presidium.retire, { userId: chair.userId }),
    ).rejects.toThrow(/CHAIR_REQUIRED/);
    await expect(
      chair.as.mutation(api.memberships.remove, {
        membershipId: await membershipId(t, chair.userId, "presidium"),
      }),
    ).rejects.toThrow(/CHAIR_REQUIRED/);

    await chair.as.mutation(api.presidium.transferChair, { userId: vice.userId });
    let roster = await vice.as.query(api.roster.get, {});
    const presidium = roster.departments.find((d) => d.kind === "presidium")!;
    expect(presidium.leads.map((p) => p._id)).toEqual([vice.userId]);
    expect(presidium.members.find((p) => p._id === chair.userId)?.wasChair).toBe(true);

    await chair.as.mutation(api.presidium.retire, { userId: chair.userId });
    roster = await chair.as.query(api.roster.get, {});
    expect(roster.viewer.isAdmin).toBe(false);
    expect(roster.former).toMatchObject([{ _id: chair.userId, formerRole: "lead" }]);
    expect(roster.noDepartment.some((p) => p._id === chair.userId)).toBe(false);
  });

  test("members cannot retire someone else", async () => {
    const { chair, vice } = await presidiumSetup();
    await expect(
      vice.as.mutation(api.presidium.retire, { userId: chair.userId }),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  test("presidium promotes a 部长 to 副主席, vacating the 部长 seat", async () => {
    const { t, admin, vice } = await presidiumSetup();
    const lead = await addMember(t, admin.as, "lead@ucsb.edu", "events", "lead");
    const member = await addMember(t, admin.as, "member@ucsb.edu", "events");

    await expect(
      vice.as.mutation(api.presidium.promoteToViceChair, { userId: member.userId }),
    ).rejects.toThrow(/INVALID/);
    await expect(
      member.as.mutation(api.presidium.promoteToViceChair, { userId: lead.userId }),
    ).rejects.toThrow(/FORBIDDEN/);

    await vice.as.mutation(api.presidium.promoteToViceChair, { userId: lead.userId });
    const roster = await lead.as.query(api.roster.get, {});
    const presidium = roster.departments.find((d) => d.kind === "presidium")!;
    const events = roster.departments.find((d) => d.slug === "events")!;
    expect(presidium.members.some((p) => p._id === lead.userId)).toBe(true);
    expect(events.leads).toEqual([]);
    expect(roster.viewer.isPresidium).toBe(true);
  });
});

describe("部长 promotions", () => {
  test("a 部长 promotes a 部员 of their department, up to two 部长", async () => {
    const t = setup();
    const admin = await bootstrapAdmin(t);
    const lead = await addMember(t, admin.as, "lead@ucsb.edu", "events", "lead");
    const a = await addMember(t, admin.as, "a@ucsb.edu", "events");
    const b = await addMember(t, admin.as, "b@ucsb.edu", "events");

    await expect(
      b.as.mutation(api.memberships.setRole, {
        membershipId: await membershipId(t, a.userId, "events"),
        role: "lead",
      }),
    ).rejects.toThrow(/FORBIDDEN/);

    await lead.as.mutation(api.memberships.setRole, {
      membershipId: await membershipId(t, a.userId, "events"),
      role: "lead",
    });
    await expect(
      lead.as.mutation(api.memberships.setRole, {
        membershipId: await membershipId(t, b.userId, "events"),
        role: "lead",
      }),
    ).rejects.toThrow(/TOO_MANY_LEADS/);
  });
});

describe("主席团 chat", () => {
  test("every 部长 is a member; regular members aren't", async () => {
    const { t, admin, chair } = await presidiumSetup();
    const lead = await addMember(t, admin.as, "lead@ucsb.edu", "events", "lead");
    const member = await addMember(t, admin.as, "member@ucsb.edu", "events");
    const presidium = await departmentBySlug(t, "presidium");
    const chatOf = async (as: typeof lead.as) =>
      (await as.query(api.channels.listMine, {})).departments.find((c) => c.departmentId === presidium._id);

    const chat = await chatOf(lead.as);
    expect(chat).toBeDefined();
    expect(await chatOf(member.as)).toBeUndefined();
    await lead.as.mutation(api.messages.send, { channelId: chat!._id, body: "部长报到" });
    await expect(
      member.as.query(api.messages.list, { channelId: chat!._id, paginationOpts: { numItems: 10, cursor: null } }),
    ).rejects.toThrow(/NOT_FOUND/);

    const members = await chair.as.query(api.channels.members, { channelId: chat!._id });
    expect(members.find((m) => m._id === chair.userId)?.role).toBe("presidium");
    expect(members.find((m) => m._id === lead.userId)).toMatchObject({
      role: "lead",
      departments: [expect.objectContaining({ nameEn: "Events" })],
    });
    expect(members.some((m) => m._id === member.userId)).toBe(false);
  });
});
