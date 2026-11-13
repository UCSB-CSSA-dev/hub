import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { snapshotText } from "../convex/lib/docText";
import { addMember, bootstrapAdmin, setup, type TestConvex } from "./helpers";

type ModelCall = { model: string; stream: boolean; messages: { role: string; content: string }[] };
type FakeConfig = {
  filter?: Record<string, unknown>;
  /** The summary JSON, or a function of the prompt (to use ids from it). */
  summary?: (prompt: string) => Record<string, unknown>;
  write?: string;
};

/** Fakes the AI endpoint: JSON for the filter; SSE for summaries, writing and answers. */
function fakeAi(config: FakeConfig = {}) {
  process.env.AI_API_KEY = "test-key";
  const calls: ModelCall[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as ModelCall;
    calls.push(body);
    const system = body.messages[0].content;
    if (!body.stream) {
      const reply = system.includes("gatekeeper") ? (config.filter ?? { relevant: true, keywords: [] }) : { action: "none" };
      return Response.json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
    }
    let content = "好的";
    if (system.includes("You read a CSSA document")) {
      content = JSON.stringify(config.summary?.(body.messages[1].content) ?? { summary: "摘要", tasks: [] });
    } else if (system.includes("writing assistant")) {
      content = config.write ?? "# 会议纪要\n\n- 决定：周五开会";
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
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
});

async function run(t: TestConvex) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function team(t: TestConvex) {
  const admin = await bootstrapAdmin(t);
  const president = await addMember(t, admin.as, "pres@ucsb.edu", "presidium");
  const lead = await addMember(t, admin.as, "lead@ucsb.edu", "events", "lead");
  const alice = await addMember(t, admin.as, "alice@ucsb.edu", "events");
  const bob = await addMember(t, admin.as, "bob@ucsb.edu", "events");
  const channels = await alice.as.query(api.channels.listMine, {});
  const events = channels.departments.find((c) => c.nameEn === "Events")!._id;
  return { admin, president, lead, alice, bob, events };
}

type As = Awaited<ReturnType<typeof bootstrapAdmin>>["as"];

function paragraphs(...lines: string[]) {
  return JSON.stringify({
    type: "doc",
    content: lines.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
  });
}

async function save(as: As, documentId: Id<"documents">, version: number, content: string) {
  await as.mutation(api.prosemirror.submitSnapshot, { id: documentId, version, content });
}

describe("document text", () => {
  test("keeps structure: headings, lists, task items and mentions", () => {
    const text = snapshotText(
      JSON.stringify({
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "议程" }] },
          {
            type: "bulletList",
            content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "海报" }] }] }],
          },
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: true },
                content: [
                  {
                    type: "paragraph",
                    content: [
                      { type: "mention", attrs: { id: "u1", label: "Alice" } },
                      { type: "text", text: " 订场地" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(text).toBe("## 议程\n- 海报\n- [x] @Alice 订场地");
    expect(snapshotText("not json")).toBe("");
  });
});

describe("document summaries", () => {
  test("any reader summarizes for 1 credit; leads turn tasks into drafts and send announcements", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { admin, lead, alice, bob, events } = await team(t);
    const existing = await lead.as.mutation(api.assignments.create, {
      channelId: events,
      kind: "task",
      title: "Book the room",
      requiresSubmission: false,
      assigneeIds: [alice.userId],
      everyone: false,
      publish: true,
    });
    const calls = fakeAi({
      summary: () => ({
        summary: "- 周五迎新，Bob 做海报",
        tasks: [
          { kind: "task", title: "做海报", assigneeIds: [bob.userId, "not-an-id"] },
          { kind: "event", title: "迎新", startAt: new Date(Date.now() + 7 * 86_400_000).toISOString() },
          { kind: "event", title: "No start time" },
        ],
        announcements: [{ body: "周五迎新，欢迎大家参加！" }],
        edits: [{ assignmentId: existing, title: "Book the big room" }],
      }),
    });

    const documentId = await alice.as.mutation(api.documents.createInChat, { channelId: events, title: "Notes" });
    await save(alice.as, documentId, 2, paragraphs("周五迎新", "Bob 做海报"));
    expect((await t.run((ctx) => ctx.db.get("documents", documentId)))?.text).toBe("周五迎新\nBob 做海报");

    await alice.as.mutation(api.aiDocs.summarize, { documentId });
    expect((await alice.as.query(api.aiDocs.summary, { documentId }))?.generatingByMe).toBe(true);
    await expect(bob.as.mutation(api.aiDocs.summarize, { documentId })).rejects.toThrow(/AI_BUSY/);
    await run(t);
    const prompt = calls.find((c) => c.stream)!.messages[1].content;
    expect(prompt).toContain("Bob 做海报");
    expect(prompt).toContain(existing);

    const view = (await bob.as.query(api.aiDocs.summary, { documentId }))!;
    expect(view).toMatchObject({ generating: false, outdated: false, summary: "- 周五迎新，Bob 做海报" });
    // Unknown assignees are dropped; an event without a start becomes a task.
    expect(view.tasks.map((x) => [x.kind, x.title, x.assignees.map((a) => a._id)])).toEqual([
      ["task", "做海报", [bob.userId]],
      ["event", "迎新", []],
      ["task", "No start time", []],
    ]);
    expect(view.taskTargets).toEqual([]);
    expect(view.announceTargets).toEqual([]);
    expect(view.edits).toMatchObject([{ assignment: { _id: existing }, fields: { title: "Book the big room" }, canApply: false }]);
    expect(await alice.as.query(api.ai.myCredits, {})).toMatchObject({ balance: 4 });

    // Members can't create tasks or announce; the lead can.
    await expect(bob.as.mutation(api.aiDocs.createTaskDrafts, { documentId, indexes: [0] })).rejects.toThrow(/FORBIDDEN/);
    const leadView = (await lead.as.query(api.aiDocs.summary, { documentId }))!;
    expect(leadView.taskTargets.map((c) => c._id)).toEqual([events]);
    expect(leadView.edits[0].canApply).toBe(true);
    const drafts = await lead.as.mutation(api.aiDocs.createTaskDrafts, { documentId, indexes: [0, 1, 2, 0] });
    expect(drafts).toHaveLength(3);
    expect(await lead.as.mutation(api.aiDocs.createTaskDrafts, { documentId, indexes: [0, 1, 2] })).toEqual([]);
    const created = await t.run((ctx) => ctx.db.get("assignments", drafts[0]));
    expect(created).toMatchObject({ status: "draft", title: "做海报", draftAssigneeIds: [bob.userId] });
    const bobNotes = await t.run((ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", bob.userId))
        .collect(),
    );
    expect(bobNotes.some((n) => n.type === "assignment_new")).toBe(false);

    const { suggestionId } = await lead.as.mutation(api.aiDocs.editSuggestion, { documentId, index: 0 });
    expect(await lead.as.query(api.ai.getSuggestion, { suggestionId })).toMatchObject({
      action: "edit",
      assignmentId: existing,
      canAct: true,
    });
    await expect(alice.as.mutation(api.aiDocs.editSuggestion, { documentId, index: 0 })).rejects.toThrow(/FORBIDDEN/);

    const body = "周五迎新，欢迎大家参加！";
    await expect(
      alice.as.mutation(api.aiDocs.sendAnnouncement, { documentId, index: 0, channelId: events, body }),
    ).rejects.toThrow(/FORBIDDEN/);
    await lead.as.mutation(api.aiDocs.sendAnnouncement, { documentId, index: 0, channelId: events, body });
    await admin.as.mutation(api.ai.setAiMode, { channelId: events, enabled: true });
    await lead.as.mutation(api.aiDocs.sendAnnouncement, { documentId, index: 0, channelId: events, body: "再次提醒" });
    const announcements = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_channel_announcement", (q) => q.eq("channelId", events).eq("announcement", true))
        .collect(),
    );
    expect(announcements.map((m) => [m.kind, m.authorId === lead.userId, m.ai?.actorId])).toEqual([
      ["user", true, undefined],
      ["ai", false, lead.userId],
    ]);
    expect((await bob.as.query(api.aiDocs.summary, { documentId }))?.announcements[0].sent).toHaveLength(2);

    vi.setSystemTime(Date.now() + 60_000);
    await save(alice.as, documentId, 3, paragraphs("改了"));
    expect((await bob.as.query(api.aiDocs.summary, { documentId }))?.outdated).toBe(true);
  });

  test("people who can't read the document see nothing", async () => {
    const t = setup();
    const { president, alice } = await team(t);
    fakeAi();
    const documentId = await president.as.mutation(api.documents.createInFolder, { space: "presidium", title: "Plan" });
    expect(await alice.as.query(api.aiDocs.summary, { documentId })).toBeNull();
    await expect(alice.as.mutation(api.aiDocs.summarize, { documentId })).rejects.toThrow(/NOT_FOUND/);
  });
});

describe("writing with 小飒", () => {
  test("editors write for 2 credits into a private draft", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { alice, bob, events } = await team(t);
    fakeAi();
    const documentId = await alice.as.mutation(api.documents.createInChat, { channelId: events, title: "Notes" });
    await alice.as.mutation(api.aiDocs.write, { documentId, prompt: "整理成会议纪要" });
    expect(await alice.as.query(api.aiDocs.myDraft, { documentId })).toMatchObject({ status: "thinking" });
    await run(t);
    const draft = (await alice.as.query(api.aiDocs.myDraft, { documentId }))!;
    expect(draft).toMatchObject({ status: "done", text: "# 会议纪要\n\n- 决定：周五开会" });
    expect(await bob.as.query(api.aiDocs.myDraft, { documentId })).toBeNull();
    expect(await alice.as.query(api.ai.myCredits, {})).toMatchObject({ balance: 3 });
    await expect(bob.as.mutation(api.aiDocs.closeDraft, { draftId: draft._id })).rejects.toThrow(/NOT_FOUND/);
    await alice.as.mutation(api.aiDocs.closeDraft, { draftId: draft._id });
    expect(await alice.as.query(api.aiDocs.myDraft, { documentId })).toBeNull();
  });

  test("off-topic prompts are refused for 2 credits and can be appealed", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { admin, alice, events } = await team(t);
    fakeAi({ filter: { relevant: false, reason: "这是作业" } });
    const documentId = await alice.as.mutation(api.documents.createInChat, { channelId: events, title: "Notes" });
    const requestId = await alice.as.mutation(api.aiDocs.write, { documentId, prompt: "write my essay" });
    await run(t);
    expect(await alice.as.query(api.aiDocs.myDraft, { documentId })).toMatchObject({
      status: "refused",
      reason: "这是作业",
      canAppeal: true,
    });
    expect(await alice.as.query(api.ai.myCredits, {})).toMatchObject({ balance: 3 });

    await alice.as.mutation(api.ai.appeal, { requestId, note: "it's for CSSA" });
    const [appeal] = await admin.as.query(api.ai.listAppeals, { status: "pending" });
    expect(appeal).toMatchObject({ question: "write my essay", reason: "这是作业", chat: null, document: { _id: documentId } });
    fakeAi();
    await admin.as.mutation(api.ai.reviewAppeal, { appealId: appeal._id, approve: true });
    await run(t);
    expect(await alice.as.query(api.aiDocs.myDraft, { documentId })).toMatchObject({ status: "done" });
    expect(await alice.as.query(api.ai.myCredits, {})).toMatchObject({ balance: 5 });
  });

  test("readers who can't edit can't write", async () => {
    const t = setup();
    const { lead, alice, bob, events } = await team(t);
    fakeAi();
    const assignmentId = await lead.as.mutation(api.assignments.create, {
      channelId: events,
      kind: "task",
      title: "Gala",
      requiresSubmission: false,
      assigneeIds: [bob.userId],
      everyone: false,
      publish: true,
    });
    const documentId = await lead.as.mutation(api.documents.create, { assignmentId, title: "Plan" });
    expect(await alice.as.query(api.documents.get, { documentId })).toMatchObject({ canEdit: false });
    await expect(alice.as.mutation(api.aiDocs.write, { documentId, prompt: "brainstorm" })).rejects.toThrow(/FORBIDDEN/);
  });
});

describe("questions about documents", () => {
  test("shared chats only take documents everyone there can open; the text reaches the model", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { admin, president, alice, events } = await team(t);
    const calls = fakeAi();
    await admin.as.mutation(api.ai.setAiMode, { channelId: events, enabled: true });
    const chatDoc = await alice.as.mutation(api.documents.createInChat, { channelId: events, title: "Run of show" });
    await save(alice.as, chatDoc, 2, paragraphs("18:00 签到"));
    const secret = await president.as.mutation(api.documents.createInFolder, { space: "presidium", title: "Budget" });
    await save(president.as, secret, 2, paragraphs("机密预算"));

    const choices = await alice.as.query(api.aiDocs.documentChoices, { channelId: events });
    expect(choices.map((c) => c._id)).toEqual([chatDoc]);
    await expect(
      alice.as.mutation(api.messages.send, { channelId: events, body: "hello", documentIds: [chatDoc] }),
    ).rejects.toThrow(/INVALID/);

    // The president can read the budget but not share it into the department chat.
    const presidentChoices = await president.as.query(api.aiDocs.documentChoices, { channelId: events });
    expect(presidentChoices.some((c) => c._id === secret)).toBe(false);

    await alice.as.mutation(api.messages.send, { channelId: events, body: "@小飒 几点签到？", documentIds: [chatDoc] });
    await run(t);
    const system = calls.find((c) => c.stream)!.messages[0].content;
    expect(system).toContain('<document title="Run of show">');
    expect(system).toContain("18:00 签到");

    // The private 小飒 chat takes any document the asker can open.
    const assistant = await president.as.mutation(api.ai.ensureAssistantChannel, {});
    const privateChoices = await president.as.query(api.aiDocs.documentChoices, { channelId: assistant });
    expect(privateChoices.some((c) => c._id === secret)).toBe(true);
    await president.as.mutation(api.messages.send, { channelId: assistant, body: "预算多少？", documentIds: [secret] });
    await run(t);
    expect(calls.filter((c) => c.stream).at(-1)!.messages[0].content).toContain("机密预算");
  });
});
