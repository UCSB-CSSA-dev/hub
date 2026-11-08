import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { buildDigest } from "../convex/lib/digest";
import { renderDigest } from "../convex/lib/emailTemplates";
import { endOfPacificDay, pacificDay, pacificHour, startOfPacificDay } from "../convex/lib/time";
import { addMember, bootstrapAdmin, setup, type TestConvex } from "./helpers";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** 2026-10-26 10:00 AM Pacific (PDT, UTC-7). */
const TEN_AM = Date.UTC(2026, 9, 26, 17, 0, 0);

async function team(t: TestConvex) {
  const admin = await bootstrapAdmin(t);
  const lead = await addMember(t, admin.as, "lead@ucsb.edu", "events", "lead");
  const alice = await addMember(t, admin.as, "alice@ucsb.edu", "events");
  const bob = await addMember(t, admin.as, "bob@ucsb.edu", "events");
  const channels = await alice.as.query(api.channels.listMine, {});
  const events = channels.departments.find((c) => c.nameEn === "Events")!._id;
  return { admin, lead, alice, bob, events };
}

function task(channelId: Id<"channels">, assigneeIds: Id<"users">[], title: string, dueAt?: number) {
  return {
    channelId,
    kind: "task" as const,
    title,
    dueAt,
    requiresSubmission: true,
    assigneeIds,
    everyone: false,
    publish: true,
  };
}

afterEach(() => {
  vi.useRealTimers();
  delete process.env.EMAIL_DRY_RUN;
});

describe("pacific time", () => {
  test("day boundaries follow Los Angeles, including DST", () => {
    expect(pacificDay(TEN_AM)).toBe("2026-10-26");
    expect(pacificHour(TEN_AM)).toBe(10);
    expect(startOfPacificDay(TEN_AM)).toBe(Date.UTC(2026, 9, 26, 7));
    expect(endOfPacificDay(TEN_AM)).toBe(Date.UTC(2026, 9, 27, 7));
    // 2026-11-01 is the fall-back day: 25 hours long.
    const fallBack = Date.UTC(2026, 10, 1, 20);
    expect(endOfPacificDay(fallBack) - startOfPacificDay(fallBack)).toBe(25 * HOUR);
  });
});

describe("daily digest", () => {
  test("sorts items into today, the next 7 days, and other to-dos", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEN_AM - 2 * DAY);
    const t = setup();
    const { lead, alice, events } = await team(t);
    await lead.as.mutation(api.assignments.create, task(events, [alice.userId], "Overdue", TEN_AM - HOUR));
    await lead.as.mutation(api.assignments.create, task(events, [alice.userId], "Due tonight", TEN_AM + 8 * HOUR));
    await lead.as.mutation(api.assignments.create, task(events, [alice.userId], "In two days", TEN_AM + 2 * DAY));
    await lead.as.mutation(api.assignments.create, task(events, [alice.userId], "Next month", TEN_AM + 30 * DAY));
    await lead.as.mutation(api.assignments.create, task(events, [alice.userId], "No date"));
    const done = await lead.as.mutation(api.assignments.create, task(events, [alice.userId], "Done already"));
    await alice.as.mutation(api.assignments.submit, { assignmentId: done, text: "ok", fileIds: [] });
    const event = (title: string, startAt: number) => ({
      ...task(events, [alice.userId], title),
      kind: "event" as const,
      requiresSubmission: false,
      startAt,
      location: "UCen",
    });
    await lead.as.mutation(api.assignments.create, event("Tonight's social", TEN_AM + 9 * HOUR));
    await lead.as.mutation(api.assignments.create, event("Gala", TEN_AM + 3 * DAY));
    await lead.as.mutation(api.assignments.create, event("Far away", TEN_AM + 20 * DAY));

    const digest = await t.run((ctx) => buildDigest(ctx, alice.userId, TEN_AM));
    expect(digest.today.map((i) => i.title)).toEqual(["Overdue", "Due tonight", "Tonight's social"]);
    expect(digest.today[0].overdue).toBe(true);
    expect(digest.week.map((i) => i.title)).toEqual(["In two days", "Gala"]);
    expect(digest.todos.map((i) => i.title)).toEqual(["Next month", "No date"]);

    const email = renderDigest(digest, { locale: "zh", name: "爱丽丝", siteUrl: "https://example.com/canvas/" });
    expect(email.subject).toBe("【CSSA Hub】今日待办：3 项");
    expect(email.html).toContain("https://example.com/canvas/assignments/view/?a=");
    expect(email.text).toContain("Gala");
  });

  test("escapes user content in the HTML", () => {
    const email = renderDigest(
      {
        today: [{ title: "<script>x</script>", kind: "task", chatZh: "活动部", chatEn: "Events", link: "/assignments/" }],
        week: [],
        todos: [],
        announcements: [{ chat: "全体", author: "<b>", text: "<img src=x>", at: TEN_AM, link: "/chat/" }],
        chats: [{ name: "<i>", link: "/chat/", unread: 1, muted: false, messages: [{ author: "x", text: "<a>", at: TEN_AM }] }],
      },
      { locale: "en", name: "A&B", siteUrl: "https://example.com" },
    );
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img src=x>");
    expect(email.html).not.toContain("<i>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("A&amp;B");
  });

  test("queues once a day at 10 AM Pacific, only for people with something to show, and honors digestEmail", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEN_AM - DAY);
    const t = setup();
    const { lead, alice, bob, events } = await team(t);
    await lead.as.mutation(api.assignments.create, task(events, [alice.userId], "Poster", TEN_AM + 2 * DAY));
    await alice.as.mutation(api.users.setDigestEmail, { email: "Alice.Personal@gmail.com" });
    await expect(bob.as.mutation(api.users.setDigestEmail, { email: "not an email" })).rejects.toThrow(/INVALID/);
    process.env.EMAIL_DRY_RUN = "true";

    vi.setSystemTime(TEN_AM - HOUR);
    await t.mutation(internal.email.queueDigests, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query("emailJobs").collect())).toHaveLength(0);

    vi.setSystemTime(TEN_AM + 5 * 60 * 1000);
    await t.mutation(internal.email.queueDigests, {});
    await t.mutation(internal.email.queueDigests, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const jobs = await t.run((ctx) => ctx.db.query("emailJobs").collect());
    expect(new Set(jobs.map((j) => j.userId)).size).toBe(jobs.length);
    expect(jobs.find((j) => j.userId === alice.userId)).toMatchObject({
      to: "alice.personal@gmail.com",
      status: "sent",
      day: "2026-10-26",
    });
    // The lead posted the task card, so nothing is unread for them and they have no open items.
    expect(jobs.some((j) => j.userId === lead.userId)).toBe(false);
  });

  test("lists unread messages per chat and unread announcements, in the chosen language", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEN_AM - DAY);
    const t = setup();
    const { admin, alice, bob, events } = await team(t);
    const org = (await bob.as.query(api.channels.listMine, {})).org[0]._id;
    await alice.as.mutation(api.messages.send, { channelId: events, body: `hi <@${bob.userId}>` });
    await alice.as.mutation(api.messages.send, { channelId: events, body: "second" });
    await admin.as.mutation(api.messages.send, { channelId: org, body: "Gala on Friday", announcement: true });
    await bob.as.mutation(api.users.setDigestLocale, { locale: "en" });

    vi.setSystemTime(TEN_AM);
    const digest = await t.run((ctx) => buildDigest(ctx, bob.userId, TEN_AM, "en"));
    expect(digest.announcements).toEqual([expect.objectContaining({ chat: "General", text: "Gala on Friday" })]);
    expect(digest.chats).toEqual([
      expect.objectContaining({
        name: "Events",
        unread: 2,
        muted: false,
        messages: [
          expect.objectContaining({ author: "alice", text: "hi @bob" }),
          expect.objectContaining({ author: "alice", text: "second" }),
        ],
      }),
    ]);

    await bob.as.mutation(api.channels.markRead, { channelId: events });
    expect((await t.run((ctx) => buildDigest(ctx, bob.userId, TEN_AM, "en"))).chats).toEqual([]);
    await alice.as.mutation(api.messages.send, { channelId: events, body: "third" });
    await bob.as.mutation(api.channels.setMuted, { channelId: events, muted: true });
    expect((await t.run((ctx) => buildDigest(ctx, bob.userId, TEN_AM, "en"))).chats).toEqual([
      expect.objectContaining({ name: "Events", unread: 1, muted: true, messages: [] }),
    ]);

    process.env.EMAIL_DRY_RUN = "true";
    await t.mutation(internal.email.queueDigests, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const job = (await t.run((ctx) => ctx.db.query("emailJobs").collect())).find((j) => j.userId === bob.userId);
    expect(job?.locale).toBe("en");
  });

  test("without the Apps Script settings, jobs are skipped instead of retried", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEN_AM - DAY);
    const t = setup();
    const { lead, alice, events } = await team(t);
    await lead.as.mutation(api.assignments.create, task(events, [alice.userId], "Poster"));
    vi.setSystemTime(TEN_AM);
    await t.mutation(internal.email.queueDigests, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const [job] = await t.run((ctx) => ctx.db.query("emailJobs").collect());
    expect(job).toMatchObject({ status: "skipped", lastError: "not configured" });
  });
});
