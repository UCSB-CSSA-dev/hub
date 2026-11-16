import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { pushText } from "../convex/lib/pushText";
import { addMember, bootstrapAdmin, setup, type TestConvex } from "./helpers";

type As = Awaited<ReturnType<typeof bootstrapAdmin>>["as"];

const device = (n: number) => ({ endpoint: `https://push.example.com/${n}`, p256dh: `key${n}`, auth: `auth${n}` });

async function subscriptions(t: TestConvex) {
  return t.run((ctx) => ctx.db.query("pushSubscriptions").collect());
}

/** Args of every scheduled push send, in order. */
async function scheduledPushes(t: TestConvex) {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs
    .filter((job) => job.name.startsWith("pushNode"))
    .map((job) => job.args[0] as { userIds: Id<"users">[]; input: { type: string; tag?: string } });
}

async function eventsChannel(as: As) {
  const lists = await as.query(api.channels.listMine, {});
  return lists.departments.find((c) => c.nameEn === "Events")!._id;
}

async function team(t: TestConvex) {
  const admin = await bootstrapAdmin(t);
  const alice = await addMember(t, admin.as, "alice@ucsb.edu", "events");
  const bob = await addMember(t, admin.as, "bob@ucsb.edu", "events");
  return { admin, alice, bob };
}

describe("push subscriptions", () => {
  test("a device belongs to whoever subscribed last, and only its owner can remove it", async () => {
    const t = setup();
    const { alice, bob } = await team(t);
    await alice.as.mutation(api.push.subscribe, device(1));
    await alice.as.mutation(api.push.subscribe, device(1));
    expect(await subscriptions(t)).toHaveLength(1);

    await bob.as.mutation(api.push.subscribe, device(1));
    const [row] = await subscriptions(t);
    expect(row.userId).toBe(bob.userId);

    await alice.as.mutation(api.push.unsubscribe, { endpoint: device(1).endpoint });
    expect(await subscriptions(t)).toHaveLength(1);
    await bob.as.mutation(api.push.unsubscribe, { endpoint: device(1).endpoint });
    expect(await subscriptions(t)).toHaveLength(0);
  });

  test("rejects endpoints that aren't https", async () => {
    const t = setup();
    const { alice } = await team(t);
    await expect(
      alice.as.mutation(api.push.subscribe, { ...device(1), endpoint: "http://evil.example.com" }),
    ).rejects.toThrow(/INVALID/);
  });
});

describe("push delivery", () => {
  test("DMs push to the other person unless they muted the chat; senders and users without devices get nothing", async () => {
    const t = setup();
    const { alice, bob } = await team(t);
    const dm = await alice.as.mutation(api.channels.getOrCreateDm, { otherUserId: bob.userId });

    await alice.as.mutation(api.messages.send, { channelId: dm, body: "no devices yet" });
    expect(await scheduledPushes(t)).toHaveLength(0);

    await alice.as.mutation(api.push.subscribe, device(1));
    await bob.as.mutation(api.push.subscribe, device(2));
    const messageId = await alice.as.mutation(api.messages.send, { channelId: dm, body: "hi" });
    const pushes = await scheduledPushes(t);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].userIds).toEqual([bob.userId]);
    expect(pushes[0].input).toMatchObject({ type: "dm", tag: messageId });

    await bob.as.mutation(api.channels.setMuted, { channelId: dm, muted: true });
    await alice.as.mutation(api.messages.send, { channelId: dm, body: "muted" });
    expect(await scheduledPushes(t)).toHaveLength(1);
  });

  test("mentions push through the notification they create", async () => {
    const t = setup();
    const { alice, bob } = await team(t);
    await bob.as.mutation(api.push.subscribe, device(2));
    const events = await eventsChannel(alice.as);
    await alice.as.mutation(api.messages.send, { channelId: events, body: `<@${bob.userId}> hello` });
    const pushes = await scheduledPushes(t);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ userIds: [bob.userId], input: { type: "mention" } });
  });

  test("department and group messages push to everyone in the chat except the sender and those who muted it", async () => {
    const t = setup();
    const { admin, alice, bob } = await team(t);
    await alice.as.mutation(api.push.subscribe, device(1));
    await bob.as.mutation(api.push.subscribe, device(2));
    await admin.as.mutation(api.push.subscribe, device(3));
    const events = await eventsChannel(alice.as);

    const messageId = await alice.as.mutation(api.messages.send, { channelId: events, body: "hi team" });
    let pushes = await scheduledPushes(t);
    expect(pushes).toHaveLength(1);
    expect(new Set(pushes[0].userIds)).toEqual(new Set([bob.userId]));
    expect(pushes[0].input).toMatchObject({ type: "chat", tag: messageId });

    await bob.as.mutation(api.channels.setMuted, { channelId: events, muted: true, duration: "1h" });
    await alice.as.mutation(api.messages.send, { channelId: events, body: "muted" });
    expect(await scheduledPushes(t)).toHaveLength(1);

    // Edits don't push the message again.
    await bob.as.mutation(api.channels.setMuted, { channelId: events, muted: false });
    await alice.as.mutation(api.messages.edit, { messageId, body: `hi team <@${bob.userId}>` });
    pushes = await scheduledPushes(t);
    expect(pushes.map((p) => p.input.type)).toEqual(["chat", "mention"]);
  });

  test("push text follows the recipient's language", () => {
    const lookup = { people: { u1: { nameZh: "李华", nameEn: "Hua Li" } }, departments: {} };
    const input = { type: "mention" as const, params: { actorId: "u1", preview: "开会" } };
    expect(pushText(input, "zh", lookup)).toEqual({ title: "李华 提到了你", body: "开会" });
    expect(pushText(input, "en", lookup)).toEqual({ title: "Hua Li mentioned you", body: "开会" });
    expect(pushText({ type: "dm", params: { actorId: "missing" } }, "zh", lookup)).toEqual({
      title: "某人",
      body: "[文件]",
    });
    const chat = { type: "chat" as const, params: { actorId: "u1", preview: "开会" } };
    expect(pushText(chat, "zh", lookup)).toEqual({ title: "全体", body: "李华：开会" });
    expect(pushText({ ...chat, params: { ...chat.params, name: "迎新" } }, "en", lookup)).toEqual({
      title: "迎新",
      body: "Hua Li: 开会",
    });
  });
});
