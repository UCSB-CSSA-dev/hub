import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { addMember, bootstrapAdmin, setup } from "./helpers";

const page = { numItems: 50, cursor: null };

async function departmentChannelId(
  as: Awaited<ReturnType<typeof bootstrapAdmin>>["as"],
  nameEn: string,
) {
  const channels = await as.query(api.channels.listMine, {});
  const channel = channels.departments.find((c) => c.nameEn === nameEn);
  if (!channel) throw new Error(`no channel ${nameEn}`);
  return channel._id;
}

describe("chat", () => {
  test("department channel is visible only to its members and admins", async () => {
    const t = setup();
    const admin = await bootstrapAdmin(t);
    const alice = await addMember(t, admin.as, "alice@ucsb.edu", "events");
    const bob = await addMember(t, admin.as, "bob@ucsb.edu", "events");
    const carol = await addMember(t, admin.as, "carol@ucsb.edu", "publicity");

    const aliceChannels = await alice.as.query(api.channels.listMine, {});
    expect(aliceChannels.org).toHaveLength(1);
    expect(aliceChannels.departments.map((c) => c.nameEn)).toEqual(["Events"]);

    const adminChannels = await admin.as.query(api.channels.listMine, {});
    expect(adminChannels.departments).toHaveLength(4);

    const eventsId = await departmentChannelId(alice.as, "Events");
    await alice.as.mutation(api.messages.send, { channelId: eventsId, body: "  明天见  " });

    const bobView = await bob.as.query(api.messages.list, { channelId: eventsId, paginationOpts: page });
    expect(bobView.page.map((m) => m.body)).toEqual(["明天见"]);
    const first = bobView.page[0];
    expect(first.people.find((p) => p._id === first.authorId)?.email).toBe("alice@ucsb.edu");

    const bobChannels = await bob.as.query(api.channels.listMine, {});
    expect(bobChannels.departments[0].unread).toBe(1);
    await bob.as.mutation(api.channels.markRead, { channelId: eventsId });
    expect((await bob.as.query(api.channels.listMine, {})).departments[0].unread).toBe(0);

    await expect(
      carol.as.query(api.messages.list, { channelId: eventsId, paginationOpts: page }),
    ).rejects.toThrow(/NOT_FOUND/);
    await expect(
      carol.as.mutation(api.messages.send, { channelId: eventsId, body: "hi" }),
    ).rejects.toThrow(/NOT_FOUND/);

    await admin.as.mutation(api.messages.send, { channelId: eventsId, body: "admin here" });
  });

  test("DMs are unique per pair and private to the two people", async () => {
    const t = setup();
    const admin = await bootstrapAdmin(t);
    const alice = await addMember(t, admin.as, "alice@ucsb.edu", "events");
    const bob = await addMember(t, admin.as, "bob@ucsb.edu", "events");
    const carol = await addMember(t, admin.as, "carol@ucsb.edu", "events");

    const dm = await alice.as.mutation(api.channels.getOrCreateDm, { otherUserId: bob.userId });
    const again = await bob.as.mutation(api.channels.getOrCreateDm, { otherUserId: alice.userId });
    expect(again).toBe(dm);

    await alice.as.mutation(api.messages.send, { channelId: dm, body: "hello bob" });
    const bobChannels = await bob.as.query(api.channels.listMine, {});
    expect(bobChannels.dms[0].otherUser?.email).toBe("alice@ucsb.edu");
    expect(bobChannels.dms[0].unread).toBe(1);

    await expect(
      carol.as.query(api.messages.list, { channelId: dm, paginationOpts: page }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  test("the chat list previews the latest message and shows team members' photos", async () => {
    const t = setup();
    const admin = await bootstrapAdmin(t);
    const alice = await addMember(t, admin.as, "alice@ucsb.edu", "events");
    const bob = await addMember(t, admin.as, "bob@ucsb.edu", "events");
    const eventsId = await departmentChannelId(alice.as, "Events");

    let events = (await bob.as.query(api.channels.listMine, {})).departments[0];
    expect(events.preview).toBeNull();
    expect(events.faces?.map((f) => f.email).sort()).toEqual(["alice@ucsb.edu", "bob@ucsb.edu"]);

    await alice.as.mutation(api.messages.send, { channelId: eventsId, body: `hi <@${bob.userId}>` });
    events = (await bob.as.query(api.channels.listMine, {})).departments[0];
    expect(events.preview).toMatchObject({ authorId: alice.userId, state: "normal", body: `hi <@${bob.userId}>` });
    expect(events.preview?.people.map((p) => p.email).sort()).toEqual(["alice@ucsb.edu", "bob@ucsb.edu"]);

    const [message] = (await alice.as.query(api.messages.list, { channelId: eventsId, paginationOpts: page })).page;
    await alice.as.mutation(api.messages.recall, { messageId: message._id });
    events = (await bob.as.query(api.channels.listMine, {})).departments[0];
    expect(events.preview).toMatchObject({ authorId: alice.userId, state: "recalled", body: "" });
  });

  test("rejects empty and oversized messages", async () => {
    const t = setup();
    const admin = await bootstrapAdmin(t);
    const channels = await admin.as.query(api.channels.listMine, {});
    const orgId = channels.org[0]._id;
    await expect(
      admin.as.mutation(api.messages.send, { channelId: orgId, body: "   " }),
    ).rejects.toThrow(/INVALID/);
    await expect(
      admin.as.mutation(api.messages.send, { channelId: orgId, body: "x".repeat(4001) }),
    ).rejects.toThrow(/INVALID/);
  });
});
