import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { creditWeek } from "../convex/lib/ai/credits";
import { worthScanning } from "../convex/lib/ai/prefilter";
import { mentionsSasa } from "../convex/lib/ai/sasa";
import { parseWhen } from "../convex/lib/ai/suggestions";
import { LIMITS } from "../convex/lib/constants";
import { addMember, bootstrapAdmin, setup, type TestConvex } from "./helpers";

type As = Awaited<ReturnType<typeof bootstrapAdmin>>["as"];
type ModelCall = { model: string; stream: boolean; messages: { role: string; content: string }[] };
type FakeConfig = {
  filter?: Record<string, unknown> | "error";
  scan?: Record<string, unknown>;
  answer?: string[] | "error" | "broken";
};

/** Fakes the UCSB AI endpoint: JSON replies for the filter and scan, SSE for answers. */
function fakeAi(config: FakeConfig = {}) {
  process.env.AI_API_KEY = "test-key";
  const calls: ModelCall[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as ModelCall;
    calls.push(body);
    if (!body.stream) {
      const isFilter = body.messages[0].content.includes("gatekeeper");
      const reply = isFilter ? (config.filter ?? { relevant: true, keywords: [] }) : (config.scan ?? { action: "none" });
      if (reply === "error") return new Response("boom", { status: 500 });
      return Response.json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
    }
    if (config.answer === "error") return new Response("down", { status: 503 });
    const chunks = config.answer === "broken" ? ["部分"] : (config.answer ?? ["<think>hmm</think>你好", "，这是答案"]);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const content of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
        }
        if (config.answer === "broken") {
          controller.error(new Error("connection reset"));
        } else {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.AI_API_KEY;
  delete process.env.AI_DRY_RUN;
});

async function departmentChannel(as: As, nameEn: string) {
  const channels = await as.query(api.channels.listMine, {});
  const channel = channels.departments.find((c) => c.nameEn === nameEn);
  if (!channel) throw new Error(`no channel ${nameEn}`);
  return channel._id;
}

async function team(t: TestConvex) {
  const admin = await bootstrapAdmin(t);
  const president = await addMember(t, admin.as, "pres@ucsb.edu", "presidium");
  const lead = await addMember(t, admin.as, "lead@ucsb.edu", "events", "lead");
  const alice = await addMember(t, admin.as, "alice@ucsb.edu", "events");
  const bob = await addMember(t, admin.as, "bob@ucsb.edu", "events");
  const carol = await addMember(t, admin.as, "carol@ucsb.edu", "publicity");
  const events = await departmentChannel(alice.as, "Events");
  return { admin, president, lead, alice, bob, carol, events };
}

async function messagesIn(t: TestConvex, channelId: Id<"channels">) {
  return t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", channelId))
      .collect(),
  );
}

async function sasaMessages(t: TestConvex, channelId: Id<"channels">) {
  return (await messagesIn(t, channelId)).filter((m) => m.kind === "ai");
}

async function run(t: TestConvex) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe("credits", () => {
  test("weeks start Sunday 08:00 Pacific, across daylight saving changes", () => {
    // 2026-03-08 is the Sunday clocks spring forward: 08:00 PDT = 15:00 UTC.
    expect(creditWeek(Date.UTC(2026, 2, 8, 14, 59)).key).toBe("2026-03-01");
    expect(creditWeek(Date.UTC(2026, 2, 8, 15, 0)).key).toBe("2026-03-08");
    // 2026-11-15 is in standard time: 08:00 PST = 16:00 UTC.
    expect(creditWeek(Date.UTC(2026, 10, 15, 15, 59)).key).toBe("2026-11-08");
    const week = creditWeek(Date.UTC(2026, 10, 15, 16, 0));
    expect(week.key).toBe("2026-11-15");
    expect(week.end).toBe(Date.UTC(2026, 10, 22, 16, 0));
  });

  test("allowance follows the highest role; system admins are unlimited", async () => {
    const t = setup();
    const { admin, president, lead, alice } = await team(t);
    expect(await admin.as.query(api.ai.myCredits, {})).toMatchObject({ unlimited: true, balance: 0 });
    expect(await president.as.query(api.ai.myCredits, {})).toMatchObject({ allowance: 25, balance: 25 });
    expect(await lead.as.query(api.ai.myCredits, {})).toMatchObject({ allowance: 15, balance: 15 });
    expect(await alice.as.query(api.ai.myCredits, {})).toMatchObject({ allowance: 5, balance: 5, configured: false });
  });
});

describe("AI mode", () => {
  test("only 主席团 and system admins who take part can switch it, never in DMs", async () => {
    const t = setup();
    const { admin, president, lead, alice, bob, events } = await team(t);
    await expect(admin.as.mutation(api.ai.setAiMode, { channelId: events, enabled: true })).rejects.toThrow(
      /AI_NOT_CONFIGURED/,
    );
    fakeAi();
    await expect(lead.as.mutation(api.ai.setAiMode, { channelId: events, enabled: true })).rejects.toThrow(/FORBIDDEN/);
    await expect(alice.as.mutation(api.ai.setAiMode, { channelId: events, enabled: true })).rejects.toThrow(/FORBIDDEN/);
    const dm = await alice.as.mutation(api.channels.getOrCreateDm, { otherUserId: bob.userId });
    await expect(admin.as.query(api.channels.get, { channelId: dm })).resolves.toMatchObject({
      access: { via: "oversight" },
    });
    await expect(admin.as.mutation(api.ai.setAiMode, { channelId: dm, enabled: true })).rejects.toThrow(/FORBIDDEN/);

    await alice.as.mutation(api.messages.send, { channelId: events, body: "before AI mode" });
    await president.as.mutation(api.ai.setAiMode, { channelId: events, enabled: true });
    await alice.as.mutation(api.messages.send, { channelId: events, body: "after AI mode" });
    expect(await alice.as.query(api.channels.get, { channelId: events })).toMatchObject({ aiEnabled: true });

    const messages = await messagesIn(t, events);
    expect(messages.find((m) => m.body === "before AI mode")?.aiReadable).toBeUndefined();
    expect(messages.find((m) => m.body === "after AI mode")?.aiReadable).toBe(true);
    expect(messages.find((m) => m.system?.event === "ai_enabled")).toBeTruthy();
    const audit = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audit.some((a) => a.action === "channel.ai_mode" && a.targetId === events)).toBe(true);

    // Sasa shows up in the @ picker only while AI mode is on, and never in the member list.
    const picker = await alice.as.query(api.channels.participants, { channelId: events });
    expect(picker[0]).toMatchObject({ isBot: true, nameZh: "小飒" });
    const members = await alice.as.query(api.channels.members, { channelId: events });
    expect(members.some((m) => m.isBot)).toBe(false);
    await president.as.mutation(api.ai.setAiMode, { channelId: events, enabled: false });
    const after = await alice.as.query(api.channels.participants, { channelId: events });
    expect(after.some((p) => p.isBot)).toBe(false);
  });
});

async function aiTeam(t: TestConvex, config: FakeConfig = {}) {
  const people = await team(t);
  const calls = fakeAi(config);
  await people.admin.as.mutation(api.ai.setAiMode, { channelId: people.events, enabled: true });
  return { ...people, calls };
}

describe("@小飒 questions", () => {
  test("answers from what was said while AI mode was on, streaming into one message", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { admin, alice, bob, events, calls } = await aiTeam(t);
    const publicity = await departmentChannel(admin.as, "Publicity");
    await admin.as.mutation(api.ai.setAiMode, { channelId: publicity, enabled: true });
    await t.run(async (ctx) => {
      const author = (await ctx.db.query("users").collect()).find((u) => u.email === "bob@ucsb.edu")!;
      await ctx.db.insert("messages", { channelId: events, authorId: author._id, body: "secret from before", kind: "user" });
    });
    await bob.as.mutation(api.messages.send, { channelId: events, body: "Poster draft is due Friday" });
    await admin.as.mutation(api.messages.send, { channelId: publicity, body: "publicity only note" });

    await alice.as.mutation(api.messages.send, { channelId: events, body: "@小飒 what is due Friday?" });
    const thinking = await sasaMessages(t, events);
    expect(thinking).toHaveLength(1);
    expect(thinking[0].ai?.status).toBe("thinking");
    expect((await alice.as.query(api.ai.myCredits, {})).inFlight).toBe(true);

    await run(t);
    const [reply] = await sasaMessages(t, events);
    expect(reply.ai?.status).toBe("done");
    expect(reply.body).toBe("你好，这是答案");
    const credits = await alice.as.query(api.ai.myCredits, {});
    expect(credits).toMatchObject({ balance: 4, used: 1, inFlight: false });

    const answerCall = calls.find((c) => c.stream)!;
    const system = answerCall.messages[0].content;
    expect(system).toContain("Poster draft is due Friday");
    expect(system).not.toContain("secret from before");
    expect(system).not.toContain("publicity only note");
    expect(answerCall.messages.at(-1)?.content).toContain("what is due Friday?");

    const notifications = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notifications.some((n) => n.userId === alice.userId && n.type === "reply")).toBe(true);
  });

  test("questions are refused while another is in flight, without credits, or with AI mode off", async () => {
    const t = setup();
    const { alice, lead, events } = await aiTeam(t);
    await alice.as.mutation(api.messages.send, { channelId: events, body: "@Sasa first question" });
    await expect(alice.as.mutation(api.messages.send, { channelId: events, body: "@Sasa second" })).rejects.toThrow(
      /AI_BUSY/,
    );
    // A plain message still goes through.
    await alice.as.mutation(api.messages.send, { channelId: events, body: "ok" });

    const week = creditWeek(Date.now()).key;
    await t.run(async (ctx) => {
      const message = (await ctx.db.query("messages").collect())[0];
      await ctx.db.insert("aiRequests", {
        userId: lead.userId,
        channelId: events,
        questionMessageId: message._id,
        source: "mention",
        status: "done",
        cost: 15,
        weekKey: week,
      });
    });
    const before = (await messagesIn(t, events)).length;
    await expect(lead.as.mutation(api.messages.send, { channelId: events, body: "@小飒 hi" })).rejects.toThrow(
      /AI_NO_CREDITS/,
    );
    expect((await messagesIn(t, events)).length).toBe(before);
  });

  test("failed and broken streams are refunded", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { alice, events } = await aiTeam(t, { answer: "broken" });
    await alice.as.mutation(api.messages.send, { channelId: events, body: "@小飒 summarize" });
    await run(t);
    const [reply] = await sasaMessages(t, events);
    expect(reply.ai?.status).toBe("failed");
    expect(await alice.as.query(api.ai.myCredits, {})).toMatchObject({ balance: 5, inFlight: false });

    fakeAi({ answer: "error" });
    await alice.as.mutation(api.messages.send, { channelId: events, body: "@小飒 again" });
    await run(t);
    const requests = await t.run((ctx) => ctx.db.query("aiRequests").collect());
    expect(requests.map((r) => [r.status, r.cost])).toEqual([
      ["failed", 0],
      ["failed", 0],
    ]);
  });
});

describe("relevance filter and appeals", () => {
  test("off-topic questions cost 2; an approved appeal refunds them and gets an answer", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { admin, alice, events } = await aiTeam(t, {
      filter: { relevant: false, reason: "这是作业问题", keywords: [] },
    });
    await alice.as.mutation(api.messages.send, { channelId: events, body: "@小飒 solve my calculus homework" });
    await run(t);
    const [refusal] = await sasaMessages(t, events);
    expect(refusal.ai?.status).toBe("refused");
    expect(refusal.body).toBe("这是作业问题");
    expect(await alice.as.query(api.ai.myCredits, {})).toMatchObject({ balance: 3 });

    const views = await alice.as.query(api.messages.list, { channelId: events, paginationOpts: { numItems: 20, cursor: null } });
    const view = views.page.find((m) => m._id === refusal._id)!;
    expect(view.ai?.appeal).toEqual({ status: "none", canAppeal: true });
    const requestId = refusal.ai!.requestId!;
    await expect(admin.as.mutation(api.ai.appeal, { requestId })).rejects.toThrow(/NOT_FOUND/);
    await alice.as.mutation(api.ai.appeal, { requestId, note: "It's for the CSSA math tutoring event" });
    await expect(alice.as.mutation(api.ai.appeal, { requestId })).rejects.toThrow(/INVALID/);

    const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notes.some((n) => n.userId === admin.userId && n.type === "ai_appeal")).toBe(true);
    await expect(alice.as.query(api.ai.listAppeals, { status: "pending" })).rejects.toThrow(/FORBIDDEN/);
    const [pending] = await admin.as.query(api.ai.listAppeals, { status: "pending" });
    expect(pending.question).toContain("calculus homework");

    fakeAi();
    await admin.as.mutation(api.ai.reviewAppeal, { appealId: pending._id, approve: true });
    await run(t);
    expect(await alice.as.query(api.ai.myCredits, {})).toMatchObject({ balance: 5 });
    const replies = await sasaMessages(t, events);
    expect(replies.map((m) => m.ai?.status)).toEqual(["refused", "done"]);
    const notesAfter = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notesAfter.some((n) => n.userId === alice.userId && n.type === "ai_appeal_reviewed")).toBe(true);
  });

  test("a refusal never takes the balance below 0; a denied appeal posts 小飒's notice", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { admin, alice, events } = await aiTeam(t, { filter: { relevant: false, reason: "off topic" } });
    const week = creditWeek(Date.now()).key;
    await t.run(async (ctx) => {
      const message = (await ctx.db.query("messages").collect())[0];
      await ctx.db.insert("aiRequests", {
        userId: alice.userId,
        channelId: events,
        questionMessageId: message._id,
        source: "mention",
        status: "done",
        cost: 4,
        weekKey: week,
      });
    });
    await alice.as.mutation(api.messages.send, { channelId: events, body: "@小飒 tell me a joke" });
    await run(t);
    expect(await alice.as.query(api.ai.myCredits, {})).toMatchObject({ balance: 0 });
    const refused = (await t.run((ctx) => ctx.db.query("aiRequests").collect())).find((r) => r.status === "refused")!;
    expect(refused.cost).toBe(1);

    await alice.as.mutation(api.ai.appeal, { requestId: refused._id });
    const [pending] = await admin.as.query(api.ai.listAppeals, { status: "pending" });
    await admin.as.mutation(api.ai.reviewAppeal, { appealId: pending._id, approve: false, note: "Not CSSA work" });
    const notice = (await sasaMessages(t, events)).find((m) => m.ai?.notice === "appeal_denied");
    expect(notice?.body).toBe("Not CSSA work");
  });

  test("appeal decisions can be remembered, and the filter uses the rules right away", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { admin, alice, events } = await aiTeam(t, { filter: { relevant: false, reason: "作业", keywords: [] } });
    await alice.as.mutation(api.messages.send, { channelId: events, body: "@小飒 design a quiz for our trivia night" });
    await run(t);
    const refused = (await t.run((ctx) => ctx.db.query("aiRequests").collect())).find((r) => r.status === "refused")!;
    await alice.as.mutation(api.ai.appeal, { requestId: refused._id });
    const [pending] = await admin.as.query(api.ai.listAppeals, { status: "pending" });

    await expect(
      admin.as.mutation(api.ai.reviewAppeal, { appealId: pending._id, approve: true, remember: "  " }),
    ).rejects.toThrow(/INVALID/);
    const calls = fakeAi();
    await admin.as.mutation(api.ai.reviewAppeal, {
      appealId: pending._id,
      approve: true,
      remember: "Quiz or trivia questions written for a CSSA event",
    });
    await run(t);
    await expect(alice.as.query(api.aiMemory.list, {})).rejects.toThrow(/FORBIDDEN/);
    await expect(alice.as.mutation(api.aiMemory.add, { verdict: "refuse", text: "x" })).rejects.toThrow(/FORBIDDEN/);
    await admin.as.mutation(api.aiMemory.add, { verdict: "refuse", text: "Résumé or job-application help" });
    const { rules } = await admin.as.query(api.aiMemory.list, {});
    expect(rules.map((r) => [r.verdict, r.text, r.fromAppeal])).toEqual([
      ["refuse", "Résumé or job-application help", false],
      ["allow", "Quiz or trivia questions written for a CSSA event", true],
    ]);

    // The approved re-run skips the filter; the next question's filter call carries both rules.
    const filterCalls = (text: string) =>
      calls.filter((c) => c.messages[0].content.includes("gatekeeper") && c.messages[1].content.includes(text));
    expect(filterCalls("design a quiz")).toHaveLength(0);
    await alice.as.mutation(api.messages.send, { channelId: events, body: "@小飒 more trivia ideas" });
    await run(t);
    const filter = filterCalls("more trivia ideas")[0].messages[0].content;
    expect(filter).toMatch(/Always relevant:\n- Quiz or trivia questions written for a CSSA event/);
    expect(filter).toMatch(/Always irrelevant:\n- Résumé or job-application help/);

    const allow = rules.find((r) => r.verdict === "allow")!;
    await admin.as.mutation(api.aiMemory.update, { ruleId: allow._id, verdict: "allow", text: "CSSA trivia night material" });
    await admin.as.mutation(api.aiMemory.remove, { ruleId: rules[0]._id });
    expect((await admin.as.query(api.aiMemory.list, {})).rules.map((r) => r.text)).toEqual(["CSSA trivia night material"]);
    const audit = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audit.filter((a) => a.action === "ai.memory_change").map((a) => a.metadata?.change)).toEqual([
      "add",
      "add",
      "update",
      "remove",
    ]);
  });
});

describe("private 小飒 chat", () => {
  test("reads only chats the owner takes part in, and is overseeable like a DM", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { admin, lead, alice, carol, events, calls } = await aiTeam(t);
    const gala = await admin.as.mutation(api.groups.create, {
      name: "Gala",
      departmentIds: [],
      memberIds: [admin.userId, alice.userId, carol.userId],
    });
    await admin.as.mutation(api.ai.setAiMode, { channelId: gala, enabled: true });
    await alice.as.mutation(api.messages.send, { channelId: gala, body: "gala venue is the Hub ballroom" });
    await alice.as.mutation(api.messages.send, { channelId: events, body: "events chat: buy snacks" });

    // The lead can read Gala only through oversight of Alice, so it isn't part of their 小飒 context.
    expect(await lead.as.query(api.channels.get, { channelId: gala })).toMatchObject({ access: { via: "oversight" } });
    const leadChat = await lead.as.mutation(api.ai.ensureAssistantChannel, {});
    expect((await lead.as.query(api.channels.listMine, {})).assistant?._id).toBe(leadChat);
    await lead.as.mutation(api.messages.send, { channelId: leadChat, body: "what's happening?" });
    await run(t);
    const leadPrompt = calls.filter((c) => c.stream).at(-1)!.messages[0].content;
    expect(leadPrompt).toContain("buy snacks");
    expect(leadPrompt).not.toContain("Hub ballroom");

    const aliceChat = await alice.as.mutation(api.ai.ensureAssistantChannel, {});
    await alice.as.mutation(api.messages.send, { channelId: aliceChat, body: "where is the gala?" });
    await run(t);
    const alicePrompt = calls.filter((c) => c.stream).at(-1)!.messages[0].content;
    expect(alicePrompt).toContain("Hub ballroom");
    expect(alicePrompt).toContain("buy snacks");

    // Overseers read it; nobody else does, and it can't take files or forwards.
    expect(await lead.as.query(api.channels.get, { channelId: aliceChat })).toMatchObject({ access: { via: "oversight" } });
    expect(await carol.as.query(api.channels.get, { channelId: aliceChat })).toBeNull();
    await expect(
      alice.as.mutation(api.messages.forward, {
        sourceChannelId: events,
        messageIds: [(await messagesIn(t, events)).find((m) => m.body === "events chat: buy snacks")!._id],
        targetChannelIds: [aliceChat],
      }),
    ).rejects.toThrow(/INVALID/);
    const postable = await alice.as.query(api.channels.postable, {});
    expect(postable.some((c) => c._id === aliceChat)).toBe(false);
  });
});

describe("task suggestions", () => {
  test("suggests a task for chat members only; task creators act on it", async () => {
    vi.useFakeTimers();
    const t = setup();
    const people = await team(t);
    const { admin, lead, alice, bob, carol, events } = people;
    fakeAi({
      scan: {
        action: "create_task",
        title: "Design the poster",
        assigneeIds: [bob.userId, carol.userId],
        dueAt: "2099-01-01T17:00",
        summary: "要不要把海报设计建成任务？",
        confidence: 0.9,
      },
    });
    await admin.as.mutation(api.ai.setAiMode, { channelId: events, enabled: true });
    await alice.as.mutation(api.messages.send, { channelId: events, body: "哈哈" });
    await alice.as.mutation(api.messages.send, { channelId: events, body: `<@${bob.userId}> 周五之前把海报做完` });
    await run(t);

    const [card] = await sasaMessages(t, events);
    expect(card.mentionUserIds).toEqual([bob.userId]);
    const suggestion = await t.run((ctx) => ctx.db.get("aiSuggestions", card.ai!.suggestionId!));
    // carol isn't in the Events chat; the 2099 date is out of range.
    expect(suggestion?.fields).toMatchObject({ title: "Design the poster", assigneeIds: [bob.userId] });
    expect(suggestion?.fields.dueAt).toBeUndefined();

    const forAlice = await alice.as.query(api.ai.getSuggestion, { suggestionId: suggestion!._id });
    expect(forAlice?.canAct).toBe(false);
    await expect(alice.as.mutation(api.ai.dismissSuggestion, { suggestionId: suggestion!._id })).rejects.toThrow(
      /FORBIDDEN/,
    );
    expect((await lead.as.query(api.ai.getSuggestion, { suggestionId: suggestion!._id }))?.canAct).toBe(true);
    await lead.as.mutation(api.assignments.create, {
      channelId: events,
      kind: "task",
      title: "Design the poster",
      requiresSubmission: false,
      assigneeIds: [bob.userId],
      everyone: false,
      publish: true,
      suggestionId: suggestion!._id,
    });
    expect((await t.run((ctx) => ctx.db.get("aiSuggestions", suggestion!._id)))?.status).toBe("applied");

    const bobNotes = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(bobNotes.some((n) => n.userId === bob.userId && n.type === "mention" && n.messageId === card._id)).toBe(true);
  });

  test("keyword prefilter, Sasa mentions and model dates", () => {
    expect(worthScanning("哈哈")).toBe(false);
    expect(worthScanning("明天下午三点开会")).toBe(true);
    expect(worthScanning("Can you finish the slides by Friday?")).toBe(true);
    expect(mentionsSasa("@小飒 帮我看看", null)).toBe(true);
    expect(mentionsSasa("hey @sasa", null)).toBe(true);
    expect(mentionsSasa("email sasa@ucsb.edu", null)).toBe(false);

    const now = Date.UTC(2026, 10, 13, 20, 0);
    expect(parseWhen("2026-11-20T17:00", now, false)).toBe(Date.UTC(2026, 10, 21, 1, 0));
    expect(parseWhen("2026-11-20", now, true)).toBe(Date.UTC(2026, 10, 21, 7, 59));
    expect(parseWhen("2026-11-20", now, false)).toBeUndefined();
    expect(parseWhen("2026-11-20T17:00:00Z", now, false)).toBe(Date.UTC(2026, 10, 20, 17, 0));
    expect(parseWhen("2030-01-01T10:00", now, false)).toBeUndefined();
  });

  test("scans are rate limited per chat", async () => {
    const t = setup();
    const { alice, events } = await aiTeam(t);
    await t.run((ctx) =>
      ctx.db.patch("channels", events, { aiScanWindowStart: Date.now(), aiScanCount: LIMITS.aiScansPerChannelHour }),
    );
    await alice.as.mutation(api.messages.send, { channelId: events, body: "明天之前交海报" });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((s) => s.name.includes("scan"))).toBe(false);
  });
});
