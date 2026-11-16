import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { addMember, bootstrapAdmin, departmentBySlug, setup, type TestConvex } from "./helpers";

const page = { numItems: 50, cursor: null };

async function org(t: TestConvex) {
  const admin = await bootstrapAdmin(t);
  const eventsLead = await addMember(t, admin.as, "elead@ucsb.edu", "events", "lead");
  const pubLead = await addMember(t, admin.as, "plead@ucsb.edu", "publicity", "lead");
  const member = await addMember(t, admin.as, "member@ucsb.edu", "events");
  const designer = await addMember(t, admin.as, "designer@ucsb.edu", "publicity");
  const other = await addMember(t, admin.as, "other@ucsb.edu", "publicity");
  const events = await departmentBySlug(t, "events");
  const publicity = await departmentBySlug(t, "publicity");
  return { admin, eventsLead, pubLead, member, designer, other, events, publicity };
}

describe("group chats", () => {
  test("a member proposes, another department's 部长 approves and adds their own members", async () => {
    const t = setup();
    const { admin, eventsLead, pubLead, member, designer, other, events, publicity } = await org(t);

    await expect(
      member.as.mutation(api.groups.create, {
        name: "迎新海报",
        departmentIds: [events._id],
        memberIds: [],
      }),
    ).rejects.toThrow(/FORBIDDEN/);

    const proposalId = await member.as.mutation(api.groups.propose, {
      name: "迎新海报",
      purpose: "做迎新海报",
      departmentIds: [events._id, publicity._id],
      suggestedUserIds: [],
    });
    const forLead = await pubLead.as.query(api.groups.listProposals, {});
    expect(forLead.toReview.map((p) => p._id)).toEqual([proposalId]);
    expect((await pubLead.as.query(api.users.viewer, {}))?.pendingGroupCount).toBe(1);
    expect((await pubLead.as.query(api.notifications.listMine, { paginationOpts: page })).page[0].type).toBe(
      "group_proposed",
    );

    // 部长 can't pull in people outside their departments.
    await expect(
      eventsLead.as.mutation(api.groups.reviewProposal, {
        proposalId,
        approve: true,
        memberIds: [designer.userId],
      }),
    ).rejects.toThrow(/FORBIDDEN/);

    const channelId = (await pubLead.as.mutation(api.groups.reviewProposal, {
      proposalId,
      approve: true,
      memberIds: [designer.userId],
    }))!;
    await expect(
      eventsLead.as.mutation(api.groups.reviewProposal, { proposalId, approve: true }),
    ).rejects.toThrow(/ALREADY_REVIEWED/);

    for (const person of [member, designer, eventsLead, pubLead]) {
      const mine = await person.as.query(api.channels.listMine, {});
      expect(mine.groups.map((g) => g._id)).toContain(channelId);
    }
    expect((await other.as.query(api.channels.listMine, {})).groups).toHaveLength(0);
    // The admin isn't a participant, but reads it through oversight.
    expect((await admin.as.query(api.channels.listMine, {})).groups).toHaveLength(0);
    expect((await admin.as.query(api.channels.get, { channelId }))?.access.via).toBe("oversight");

    const info = await member.as.query(api.groups.info, { channelId });
    expect(info.members.map((m) => m.person._id).sort()).toEqual([member.userId, designer.userId].sort());
    expect(info.departments.flatMap((d) => d.leads.map((l) => l._id)).sort()).toEqual(
      [eventsLead.userId, pubLead.userId].sort(),
    );
    // Proposer is co-owner with the approver after approval.
    expect(info.viewer.canManage).toBe(true);
    expect((await designer.as.query(api.groups.info, { channelId })).viewer.canManage).toBe(false);

    await pubLead.as.mutation(api.groups.addMembers, { channelId, userIds: [other.userId] });
    await expect(
      eventsLead.as.mutation(api.groups.removeMember, { channelId, userId: other.userId }),
    ).rejects.toThrow(/FORBIDDEN/);
    await member.as.mutation(api.groups.leave, { channelId });
    expect((await member.as.query(api.channels.listMine, {})).groups).toHaveLength(0);
    // Automatic 部长 can't leave.
    await expect(pubLead.as.mutation(api.groups.leave, { channelId })).rejects.toThrow(/NOT_FOUND/);
  });

  test("rejecting needs a reason and tells the proposer", async () => {
    const t = setup();
    const { eventsLead, member, events } = await org(t);
    const proposalId = await member.as.mutation(api.groups.propose, {
      name: "x",
      purpose: "y",
      departmentIds: [events._id],
      suggestedUserIds: [],
    });
    await expect(
      eventsLead.as.mutation(api.groups.reviewProposal, { proposalId, approve: false }),
    ).rejects.toThrow(/INVALID/);
    await eventsLead.as.mutation(api.groups.reviewProposal, { proposalId, approve: false, note: "重复了" });
    const list = await member.as.query(api.notifications.listMine, { paginationOpts: page });
    expect(list.page[0].type).toBe("group_rejected");
    expect((await member.as.query(api.groups.listProposals, {})).mine[0].status).toBe("rejected");
  });

  test("主席团 take over when a department loses its last 部长, and hand back", async () => {
    const t = setup();
    const { admin, eventsLead, pubLead, events, publicity } = await org(t);
    const channelId = await eventsLead.as.mutation(api.groups.create, {
      name: "海报",
      departmentIds: [events._id, publicity._id],
      memberIds: [],
    });
    expect((await admin.as.query(api.channels.listMine, {})).groups).toHaveLength(0);

    const membership = await t.run((ctx) =>
      ctx.db
        .query("departmentMemberships")
        .withIndex("by_user_department", (q) => q.eq("userId", pubLead.userId).eq("departmentId", publicity._id))
        .unique(),
    );
    await admin.as.mutation(api.memberships.setRole, { membershipId: membership!._id, role: "member" });

    const adminGroups = (await admin.as.query(api.channels.listMine, {})).groups;
    expect(adminGroups.map((g) => g._id)).toEqual([channelId]);
    const detail = await admin.as.query(api.channels.get, { channelId });
    expect(detail?.access.via).toBe("member");
    expect(detail?.access.canManage).toBe(true);
    expect((await pubLead.as.query(api.channels.listMine, {})).groups).toHaveLength(0);
    const takeover = await admin.as.query(api.notifications.listMine, { paginationOpts: page });
    expect(takeover.page.filter((n) => n.type === "group_takeover")).toHaveLength(1);

    const messages = await admin.as.query(api.messages.list, { channelId, paginationOpts: page });
    expect(messages.page[0].system?.event).toBe("takeover_started");

    await admin.as.mutation(api.memberships.setRole, { membershipId: membership!._id, role: "lead" });
    expect((await admin.as.query(api.channels.listMine, {})).groups).toHaveLength(0);
    const after = await eventsLead.as.query(api.messages.list, { channelId, paginationOpts: page });
    expect(after.page[0].system?.event).toBe("takeover_ended");
  });

  test("archiving a department makes its channels read-only and hands its groups to 主席团", async () => {
    const t = setup();
    const { admin, eventsLead, member, events, publicity } = await org(t);
    const channelId = await eventsLead.as.mutation(api.groups.create, {
      name: "活动",
      departmentIds: [events._id, publicity._id],
      memberIds: [member.userId],
    });
    const eventsChannel = (await member.as.query(api.channels.listMine, {})).departments[0]._id;

    await expect(
      admin.as.mutation(api.departments.archive, { departmentId: events._id, phrase: "wrong" }),
    ).rejects.toThrow(/INVALID/);
    await admin.as.mutation(api.departments.archive, {
      departmentId: events._id,
      phrase: "将活动部设为已归档",
    });

    const detail = await member.as.query(api.channels.get, { channelId: eventsChannel });
    expect(detail?.access.readOnly).toBe("archived");
    await expect(
      member.as.mutation(api.messages.send, { channelId: eventsChannel, body: "hi" }),
    ).rejects.toThrow(/READ_ONLY/);
    expect((await admin.as.query(api.channels.listMine, {})).groups.map((g) => g._id)).toEqual([channelId]);
    // The group itself stays usable for its members.
    await member.as.mutation(api.messages.send, { channelId, body: "still here" });

    const presidium = await departmentBySlug(t, "presidium");
    await expect(
      admin.as.mutation(api.departments.archive, { departmentId: presidium._id, phrase: "将主席团设为已归档" }),
    ).rejects.toThrow(/FORBIDDEN/);
    await admin.as.mutation(api.departments.unarchive, { departmentId: events._id });
    expect((await admin.as.query(api.channels.listMine, {})).groups).toHaveLength(0);
  });
});
