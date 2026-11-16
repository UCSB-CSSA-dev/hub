import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { addMember, bootstrapAdmin, setup, type TestConvex } from "./helpers";

const page = { numItems: 50, cursor: null };
type As = Awaited<ReturnType<typeof bootstrapAdmin>>["as"];

async function departmentChannel(as: As, nameEn: string) {
  const channels = await as.query(api.channels.listMine, {});
  const channel = channels.departments.find((c) => c.nameEn === nameEn);
  if (!channel) throw new Error(`no channel ${nameEn}`);
  return channel._id;
}

async function messages(as: As, channelId: Awaited<ReturnType<typeof departmentChannel>>) {
  return (await as.query(api.messages.list, { channelId, paginationOpts: page })).page;
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

afterEach(() => {
  vi.useRealTimers();
});

describe("core chat", () => {
  test("recall works within 5 minutes only and erases the content", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { alice, bob, events } = await team(t);
    const first = await alice.as.mutation(api.messages.send, { channelId: events, body: "oops" });
    await bob.as.mutation(api.messages.toggleReaction, { messageId: first, emoji: "👍" });
    await expect(bob.as.mutation(api.messages.recall, { messageId: first })).rejects.toThrow(/FORBIDDEN/);
    await alice.as.mutation(api.messages.recall, { messageId: first });
    const [recalled] = await messages(bob.as, events);
    expect(recalled.state).toBe("recalled");
    expect(recalled.body).toBe("");
    expect(recalled.reactions).toEqual([]);

    const second = await alice.as.mutation(api.messages.send, { channelId: events, body: "too late" });
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
    await expect(alice.as.mutation(api.messages.recall, { messageId: second })).rejects.toThrow(
      /RECALL_EXPIRED/,
    );
  });

  test("edits keep a history visible to everyone in the chat", async () => {
    const t = setup();
    const { alice, bob, events } = await team(t);
    const id = await alice.as.mutation(api.messages.send, { channelId: events, body: "v1" });
    await alice.as.mutation(api.messages.edit, { messageId: id, body: "v2" });
    await expect(bob.as.mutation(api.messages.edit, { messageId: id, body: "hack" })).rejects.toThrow(
      /FORBIDDEN/,
    );
    const [message] = await messages(bob.as, events);
    expect(message.body).toBe("v2");
    expect(message.editedAt).toBeDefined();
    const history = await bob.as.query(api.messages.history, { messageId: id });
    expect(history?.map((h) => h.body)).toEqual(["v1", "v2"]);
  });

  test("only 主席团 and system admins can remove messages, and it is audit logged", async () => {
    const t = setup();
    const { admin, lead, alice, events } = await team(t);
    const id = await alice.as.mutation(api.messages.send, { channelId: events, body: "spam" });
    await expect(lead.as.mutation(api.messages.remove, { messageId: id })).rejects.toThrow(/FORBIDDEN/);
    await admin.as.mutation(api.messages.remove, { messageId: id });
    const [message] = await messages(alice.as, events);
    expect(message.state).toBe("removed");
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_action", (q) => q.eq("action", "message.moderate_remove"))
        .collect(),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].subjectUserId).toBe(alice.userId);
  });

  test("mentions notify participants only; replies notify the original author", async () => {
    const t = setup();
    const { alice, bob, carol, events } = await team(t);
    const body = `hi <@${bob.userId}> and <@${carol.userId}>`;
    const id = await alice.as.mutation(api.messages.send, { channelId: events, body });
    expect(await bob.as.query(api.notifications.unreadCount, {})).toBe(1);
    expect(await carol.as.query(api.notifications.unreadCount, {})).toBe(0);

    await bob.as.mutation(api.messages.send, { channelId: events, body: "sure", replyToId: id });
    const list = await alice.as.query(api.notifications.listMine, { paginationOpts: page });
    expect(list.page.map((n) => n.type)).toEqual(["reply"]);
    expect(list.page[0].people.map((p) => p._id)).toContain(bob.userId);

    await alice.as.mutation(api.notifications.markAllRead, {});
    expect(await alice.as.query(api.notifications.unreadCount, {})).toBe(0);
  });

  test("announcements: 部长 and admins post them in their chats, everyone is notified until they acknowledge", async () => {
    const t = setup();
    const { admin, lead, alice, bob, events } = await team(t);
    const org = (await alice.as.query(api.channels.listMine, {})).org[0]._id;
    const unseen = async (as: As, channelId: typeof events) => {
      const lists = await as.query(api.channels.listMine, {});
      return [...lists.org, ...lists.departments].find((c) => c._id === channelId)!.unseenAnnouncements;
    };

    await expect(
      alice.as.mutation(api.messages.send, { channelId: events, body: "hi", announcement: true }),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      lead.as.mutation(api.messages.send, { channelId: org, body: "hi", announcement: true }),
    ).rejects.toThrow(/FORBIDDEN/);
    expect((await admin.as.query(api.channels.get, { channelId: org }))?.access.canAnnounce).toBe(true);

    await bob.as.mutation(api.channels.setMuted, { channelId: events, muted: true, duration: "1h" });
    const id = await lead.as.mutation(api.messages.send, { channelId: events, body: "周五开会", announcement: true });
    expect(await alice.as.query(api.notifications.unreadCount, {})).toBe(1);
    expect(await bob.as.query(api.notifications.unreadCount, {})).toBe(1);
    expect(await unseen(alice.as, events)).toBe(1);
    expect(await unseen(lead.as, events)).toBe(0);
    const [message] = await messages(alice.as, events);
    expect(message.announcement).toBe(true);

    // Reading the chat doesn't dismiss the announcement; acknowledging it does.
    await alice.as.mutation(api.channels.markRead, { channelId: events });
    const bar = await alice.as.query(api.channels.unseenAnnouncementList, { channelId: events });
    expect(bar.map((m) => m._id)).toEqual([id]);
    await alice.as.mutation(api.channels.markAnnouncementsSeen, { channelId: events });
    expect(await unseen(alice.as, events)).toBe(0);
    expect(await alice.as.query(api.channels.unseenAnnouncementList, { channelId: events })).toEqual([]);
    expect(await unseen(bob.as, events)).toBe(1);

    await alice.as.mutation(api.messages.toggleReaction, { messageId: id, emoji: "✅" });
    await lead.as.mutation(api.messages.recall, { messageId: id });
    expect(await unseen(bob.as, events)).toBe(0);
  });

  test("legacy announcement channels merge into their department chat", async () => {
    const t = setup();
    const { lead, alice, bob, events } = await team(t);
    const departmentId = (await t.run((ctx) => ctx.db.get("channels", events)))!.departmentId!;
    const { legacy, first, second } = await t.run(async (ctx) => {
      const legacy = await ctx.db.insert("channels", { type: "announcement", departmentId });
      const first = await ctx.db.insert("messages", {
        channelId: legacy,
        authorId: lead.userId,
        body: "old news",
        kind: "user",
      });
      await ctx.db.insert("messages", {
        channelId: legacy,
        authorId: lead.userId,
        body: "",
        kind: "system",
        system: { event: "retention_changed", params: {} },
      });
      const second = await ctx.db.insert("messages", {
        channelId: legacy,
        authorId: lead.userId,
        body: "new news",
        kind: "user",
      });
      const firstAt = (await ctx.db.get("messages", first))!._creationTime;
      await ctx.db.insert("channelMembers", { channelId: legacy, userId: alice.userId, lastReadAt: firstAt });
      await ctx.db.insert("notifications", {
        userId: bob.userId,
        type: "announcement",
        params: { actorId: lead.userId, channelId: legacy },
        link: `/chat/?c=${legacy}&m=${second}`,
        messageId: second,
      });
      return { legacy, first, second };
    });

    await t.mutation(internal.maintenance.mergeAnnouncementChannels, {});

    expect(await t.run((ctx) => ctx.db.get("channels", legacy))).toBeNull();
    const merged = await messages(alice.as, events);
    expect(merged.filter((m) => m.announcement).map((m) => m._id)).toEqual([second, first]);
    expect(merged.some((m) => m.kind === "system")).toBe(false);
    // Alice had read up to the first announcement in the old channel.
    const bar = await alice.as.query(api.channels.unseenAnnouncementList, { channelId: events });
    expect(bar.map((m) => m._id)).toEqual([second]);
    const [notification] = (await bob.as.query(api.notifications.listMine, { paginationOpts: page })).page;
    expect(notification.link).toBe(`/chat/?c=${events}&m=${second}`);
  });

  test("messages older than the chat's retention are purged", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { lead, alice, events } = await team(t);
    await alice.as.mutation(api.messages.send, { channelId: events, body: "old" });
    vi.advanceTimersByTime(16 * 24 * 60 * 60 * 1000);
    await alice.as.mutation(api.messages.send, { channelId: events, body: "new" });
    await t.mutation(internal.maintenance.purgeMessages, {});
    expect((await messages(alice.as, events)).map((m) => m.body)).toEqual(["new"]);

    await expect(
      alice.as.mutation(api.channels.setRetention, { channelId: events, days: 90 }),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      lead.as.mutation(api.channels.setRetention, { channelId: events, days: 45 }),
    ).rejects.toThrow(/INVALID/);
    await lead.as.mutation(api.channels.setRetention, { channelId: events, days: 90 });
    expect((await lead.as.query(api.channels.get, { channelId: events }))?.retentionDays).toBe(90);
  });

  test("search finds a Chinese word inside a sentence", async () => {
    const t = setup();
    const { alice, events } = await team(t);
    await alice.as.mutation(api.messages.send, { channelId: events, body: "我们明天活动在图书馆集合" });
    await alice.as.mutation(api.messages.send, { channelId: events, body: "Poster draft is ready" });
    const zh = await alice.as.query(api.messages.search, { channelId: events, query: "活动" });
    expect(zh.map((m) => m.body)).toEqual(["我们明天活动在图书馆集合"]);
    const en = await alice.as.query(api.messages.search, { channelId: events, query: "poster" });
    expect(en).toHaveLength(1);
    expect(await alice.as.query(api.messages.search, { channelId: events, query: "动在图书" })).toHaveLength(1);
    expect(await alice.as.query(api.messages.search, { channelId: events, query: "明后" })).toHaveLength(0);
  });

  test("forwarding sends one chat-record message to each target", async () => {
    const t = setup();
    const { alice, bob, events } = await team(t);
    const ids = [];
    for (let i = 0; i < 10; i++) {
      ids.push(await alice.as.mutation(api.messages.send, { channelId: events, body: `line ${i}` }));
    }
    const dm = await alice.as.mutation(api.channels.getOrCreateDm, { otherUserId: bob.userId });
    await alice.as.mutation(api.messages.forward, {
      sourceChannelId: events,
      messageIds: ids,
      targetChannelIds: [dm],
    });
    const [record] = await messages(bob.as, dm);
    expect(record.kind).toBe("forward");
    expect(record.forward?.items).toHaveLength(10);
    expect(record.forward?.source.nameEn).toBe("Events");
  });

  test("overseers read through a banner-only view and each open is logged once", async () => {
    const t = setup();
    const { lead, alice, bob, carol } = await team(t);
    const dm = await alice.as.mutation(api.channels.getOrCreateDm, { otherUserId: carol.userId });
    const id = await alice.as.mutation(api.messages.send, { channelId: dm, body: "hello" });

    const view = await lead.as.query(api.channels.get, { channelId: dm });
    expect(view?.access.via).toBe("oversight");
    expect(view?.access.canPost).toBe(false);
    await expect(lead.as.mutation(api.messages.send, { channelId: dm, body: "x" })).rejects.toThrow();
    await expect(
      lead.as.mutation(api.messages.toggleReaction, { messageId: id, emoji: "👍" }),
    ).rejects.toThrow();
    expect(await bob.as.query(api.channels.get, { channelId: dm })).toBeNull();

    await lead.as.mutation(api.channels.recordOversightOpen, { channelId: dm });
    await lead.as.mutation(api.channels.recordOversightOpen, { channelId: dm });
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_action", (q) => q.eq("action", "oversight.channel.open"))
        .collect(),
    );
    expect(audit).toHaveLength(1);

    const people = await lead.as.query(api.channels.oversightPeople, {});
    expect(people.map((p) => p._id).sort()).toEqual([alice.userId, bob.userId].sort());
    const chats = await lead.as.query(api.channels.oversightChannels, { userId: alice.userId });
    expect(chats!.map((c) => c._id)).toContain(dm);
    expect(await lead.as.query(api.channels.oversightChannels, { userId: carol.userId })).toBeNull();

    const watchers = await alice.as.query(api.channels.watchers, { channelId: dm });
    expect(watchers.leads.map((l) => l.nameEn)).toEqual(["Events"]);
  });

  test("existing users must re-accept the updated notice", async () => {
    const t = setup();
    const { alice } = await team(t);
    await t.run((ctx) => ctx.db.patch("users", alice.userId, { oversightConsentVersion: 1 }));
    expect((await alice.as.query(api.users.viewer, {}))?.needsOnboarding).toBe(true);
  });
});
