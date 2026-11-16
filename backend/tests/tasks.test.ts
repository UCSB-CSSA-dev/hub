import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addMember, bootstrapAdmin, setup, type TestConvex } from "./helpers";

type As = Awaited<ReturnType<typeof bootstrapAdmin>>["as"];
const HOUR = 60 * 60 * 1000;

async function departmentChannel(as: As, nameEn: string) {
  const channels = await as.query(api.channels.listMine, {});
  const channel = channels.departments.find((c) => c.nameEn === nameEn);
  if (!channel) throw new Error(`no channel ${nameEn}`);
  return channel._id;
}

async function team(t: TestConvex) {
  const admin = await bootstrapAdmin(t);
  const lead = await addMember(t, admin.as, "lead@ucsb.edu", "events", "lead");
  const alice = await addMember(t, admin.as, "alice@ucsb.edu", "events");
  const bob = await addMember(t, admin.as, "bob@ucsb.edu", "events");
  const carol = await addMember(t, admin.as, "carol@ucsb.edu", "publicity");
  const events = await departmentChannel(alice.as, "Events");
  return { admin, lead, alice, bob, carol, events };
}

function taskArgs(channelId: Id<"channels">, assigneeIds: Id<"users">[], extra: Record<string, unknown> = {}) {
  return {
    channelId,
    kind: "task" as const,
    title: "Design the poster",
    requiresSubmission: true,
    assigneeIds,
    everyone: false,
    publish: true,
    ...extra,
  };
}

async function notificationsOf(t: TestConvex, userId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("tasks", () => {
  test("only the chat's 部长 or 主席团 can create tasks, for that chat's people", async () => {
    const t = setup();
    const { admin, lead, alice, carol, events } = await team(t);
    await expect(alice.as.mutation(api.assignments.create, taskArgs(events, [alice.userId]))).rejects.toThrow(/FORBIDDEN/);
    await expect(lead.as.mutation(api.assignments.create, taskArgs(events, [carol.userId]))).rejects.toThrow(/INVALID/);
    await lead.as.mutation(api.assignments.create, taskArgs(events, [alice.userId]));

    const org = (await admin.as.query(api.channels.listMine, {})).org[0]._id;
    await expect(lead.as.mutation(api.assignments.create, taskArgs(org, [alice.userId]))).rejects.toThrow(/FORBIDDEN/);
    await admin.as.mutation(api.assignments.create, taskArgs(org, [alice.userId, carol.userId]));

    const creatable = await lead.as.query(api.assignments.creatableChannels, {});
    expect(creatable.map((c) => c._id)).toEqual([events]);
  });

  test("an admin can publish in a group chat without departments; files go to 公共", async () => {
    const t = setup();
    const { admin, alice, bob } = await team(t);
    const channelId = await admin.as.mutation(api.groups.create, {
      name: "Gala crew",
      departmentIds: [],
      memberIds: [alice.userId, bob.userId],
    });
    const creatable = await admin.as.query(api.assignments.creatableChannels, {});
    expect(creatable.find((c) => c._id === channelId)?.spaces.map((s) => s.departmentId)).toEqual([null]);
    const assignmentId = await admin.as.mutation(api.assignments.create, taskArgs(channelId, [], { everyone: true }));
    const assignment = await t.run((ctx) => ctx.db.get("assignments", assignmentId));
    expect(assignment?.status).toBe("open");
    expect(assignment?.departmentId).toBeUndefined();
  });

  test("publishing posts a card in the chat and notifies assignees", async () => {
    const t = setup();
    const { lead, alice, bob, events } = await team(t);
    const assignmentId = await lead.as.mutation(api.assignments.create, taskArgs(events, [], { everyone: true }));
    const page = await bob.as.query(api.messages.list, { channelId: events, paginationOpts: { numItems: 5, cursor: null } });
    const card = page.page.find((m) => m.kind === "task");
    expect(card?.task?._id).toBe(assignmentId);
    expect(card?.task?.assigneeCount).toBe(3);
    expect(card?.task?.myStatus).toBe("assigned");

    const notes = await notificationsOf(t, alice.userId);
    expect(notes.map((n) => n.type)).toContain("assignment_new");
    expect((await notificationsOf(t, lead.userId)).map((n) => n.type)).not.toContain("assignment_new");
    await expect(
      alice.as.mutation(api.messages.forward, {
        sourceChannelId: events,
        messageIds: [card!._id],
        targetChannelIds: [events],
      }),
    ).rejects.toThrow();
  });

  test("drafts stay private to their creator until published", async () => {
    const t = setup();
    const { lead, alice, events } = await team(t);
    const assignmentId = await lead.as.mutation(api.assignments.create, taskArgs(events, [alice.userId], { publish: false }));
    expect(await alice.as.query(api.assignments.get, { assignmentId })).toBeNull();
    expect(await alice.as.query(api.assignments.listMine, {})).toHaveLength(0);
    await lead.as.mutation(api.assignments.publish, { assignmentId });
    expect((await alice.as.query(api.assignments.listMine, {}))[0].myStatus).toBe("assigned");
  });

  test("submit, request changes (comment required), resubmit, approve", async () => {
    const t = setup();
    const { lead, alice, bob, events } = await team(t);
    const assignmentId = await lead.as.mutation(api.assignments.create, taskArgs(events, [alice.userId]));
    await expect(
      bob.as.mutation(api.assignments.submit, { assignmentId, text: "not mine", fileIds: [] }),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(alice.as.mutation(api.assignments.submit, { assignmentId, fileIds: [] })).rejects.toThrow(/INVALID/);
    await alice.as.mutation(api.assignments.submit, { assignmentId, text: "draft v1", fileIds: [] });
    expect((await notificationsOf(t, lead.userId)).map((n) => n.type)).toContain("submission_received");

    const task = await lead.as.query(api.assignments.get, { assignmentId });
    const submissionId = task!.assignees[0].submissionId;
    await expect(
      alice.as.mutation(api.assignments.review, { submissionId, decision: "approve" }),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      lead.as.mutation(api.assignments.review, { submissionId, decision: "request_changes" }),
    ).rejects.toThrow(/INVALID/);
    await lead.as.mutation(api.assignments.review, { submissionId, decision: "request_changes", comment: "bigger logo" });
    expect((await alice.as.query(api.assignments.listMine, {}))[0].myStatus).toBe("changes_requested");

    await alice.as.mutation(api.assignments.submit, { assignmentId, text: "draft v2", fileIds: [] });
    await lead.as.mutation(api.assignments.review, { submissionId, decision: "approve" });
    const comments = await alice.as.query(api.assignments.listComments, { submissionId });
    expect(comments.map((c) => c.body)).toEqual(["bigger logo"]);
    const reviewed = (await notificationsOf(t, alice.userId)).filter((n) => n.type === "submission_reviewed");
    expect(reviewed.map((n) => n.params.decision)).toEqual(["request_changes", "approve"]);
    const list = await lead.as.query(api.assignments.listCreatedByMe, {});
    expect(list[0]).toMatchObject({ total: 1, done: 1, toReview: 0 });
  });

  test("the lead, an admin, or the owner can mark an assignee complete without a submission", async () => {
    const t = setup();
    const { admin, lead, alice, bob, events } = await team(t);
    const assignmentId = await lead.as.mutation(api.assignments.create, taskArgs(events, [alice.userId, bob.userId]));
    const task = await lead.as.query(api.assignments.get, { assignmentId });
    const row = (userId: Id<"users">) => task!.assignees.find((a) => a.userId === userId)!.submissionId;

    await expect(
      bob.as.mutation(api.assignments.review, { submissionId: row(alice.userId), decision: "complete" }),
    ).rejects.toThrow(/NOT_FOUND|FORBIDDEN/);
    await expect(
      alice.as.mutation(api.assignments.review, { submissionId: row(alice.userId), decision: "complete" }),
    ).rejects.toThrow(/FORBIDDEN/);

    await lead.as.mutation(api.assignments.review, { submissionId: row(alice.userId), decision: "complete" });
    expect((await alice.as.query(api.assignments.listMine, {}))[0].myStatus).toBe("approved");
    expect(await alice.as.query(api.assignments.myOpenCount, {})).toBe(0);
    const reviewed = (await notificationsOf(t, alice.userId)).filter((n) => n.type === "submission_reviewed");
    expect(reviewed.map((n) => n.params.decision)).toEqual(["complete"]);
    await expect(
      lead.as.mutation(api.assignments.review, { submissionId: row(alice.userId), decision: "complete" }),
    ).rejects.toThrow(/INVALID/);

    await bob.as.mutation(api.assignments.submit, { assignmentId, text: "done", fileIds: [] });
    await expect(
      admin.as.mutation(api.assignments.review, { submissionId: row(bob.userId), decision: "complete" }),
    ).rejects.toThrow(/INVALID/);
    await lead.as.mutation(api.assignments.close, { assignmentId });
    await admin.as.mutation(api.assignments.review, { submissionId: row(bob.userId), decision: "approve" });
    expect(await lead.as.query(api.assignments.listCreatedByMe, {})).toMatchObject([{ total: 2, done: 2, toReview: 0 }]);
  });

  test("submission files go to the department space's task folder", async () => {
    const t = setup();
    const { lead, alice, events } = await team(t);
    const assignmentId = await lead.as.mutation(api.assignments.create, taskArgs(events, [alice.userId]));
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["poster"], { type: "text/plain" })));
    const saved = await alice.as.mutation(api.files.save, { assignmentId, storageId, name: "poster.txt" });
    if (!saved.ok) throw new Error(saved.code);
    await alice.as.mutation(api.assignments.submit, { assignmentId, fileIds: [saved.fileId] });

    const root = await alice.as.query(api.files.listFolder, { space: "events" });
    const tasksRoot = root!.folders.find((f) => f.name === "任务 Tasks")!;
    const inside = await alice.as.query(api.files.listFolder, { space: "events", folderId: tasksRoot._id });
    expect(inside!.folders.map((f) => f.name)).toEqual(["Design the poster"]);
    const mine = await alice.as.query(api.assignments.get, { assignmentId });
    expect(mine!.mySubmission!.files.map((f) => f.name)).toEqual(["poster.txt"]);
  });

  test("checklist tasks can auto-approve when marked done", async () => {
    const t = setup();
    const { lead, alice, events } = await team(t);
    const assignmentId = await lead.as.mutation(
      api.assignments.create,
      taskArgs(events, [alice.userId], { requiresSubmission: false, autoApprove: true }),
    );
    await alice.as.mutation(api.assignments.markDone, { assignmentId });
    expect((await alice.as.query(api.assignments.listMine, {}))[0].myStatus).toBe("approved");
  });

  test("reminders go out once: due soon, overdue, and event soon", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { lead, alice, events } = await team(t);
    const now = Date.now();
    await lead.as.mutation(api.assignments.create, taskArgs(events, [alice.userId], { dueAt: now + 2 * HOUR }));
    await lead.as.mutation(api.assignments.create, {
      ...taskArgs(events, [alice.userId]),
      kind: "event",
      title: "Gala",
      requiresSubmission: false,
      startAt: now + 5 * HOUR,
      location: "UCen",
    });

    await t.mutation(internal.assignments.sendReminders, {});
    await t.mutation(internal.assignments.sendReminders, {});
    let types = (await notificationsOf(t, alice.userId)).map((n) => n.type);
    expect(types.filter((x) => x === "assignment_due_soon")).toHaveLength(1);
    expect(types.filter((x) => x === "event_soon")).toHaveLength(1);

    vi.advanceTimersByTime(3 * HOUR);
    await t.mutation(internal.assignments.sendReminders, {});
    await t.mutation(internal.assignments.sendReminders, {});
    types = (await notificationsOf(t, alice.userId)).map((n) => n.type);
    expect(types.filter((x) => x === "assignment_overdue")).toHaveLength(1);
  });

  test("events reject an end before the start and never take submissions", async () => {
    const t = setup();
    const { lead, alice, events } = await team(t);
    const start = Date.now() + 24 * HOUR;
    const event = {
      ...taskArgs(events, [alice.userId]),
      kind: "event" as const,
      title: "Gala",
      startAt: start,
    };
    await expect(lead.as.mutation(api.assignments.create, { ...event, endAt: start - HOUR })).rejects.toThrow(/INVALID/);
    const eventId = await lead.as.mutation(api.assignments.create, event);
    await expect(alice.as.mutation(api.assignments.submit, { assignmentId: eventId, text: "hi", fileIds: [] })).rejects.toThrow(
      /INVALID/,
    );
    const prep = await lead.as.mutation(api.assignments.create, taskArgs(events, [alice.userId], { eventId, title: "Book room" }));
    const view = await alice.as.query(api.assignments.get, { assignmentId: eventId });
    expect(view!.prepTasks.map((p) => p._id)).toEqual([prep]);
  });
});
