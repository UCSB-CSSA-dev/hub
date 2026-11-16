import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { LIMITS } from "../convex/lib/constants";
import { addMember, bootstrapAdmin, setup, type TestConvex } from "./helpers";

type As = Awaited<ReturnType<typeof bootstrapAdmin>>["as"];

async function team(t: TestConvex) {
  const admin = await bootstrapAdmin(t);
  const lead = await addMember(t, admin.as, "lead@ucsb.edu", "events", "lead");
  const alice = await addMember(t, admin.as, "alice@ucsb.edu", "events");
  const bob = await addMember(t, admin.as, "bob@ucsb.edu", "events");
  const carol = await addMember(t, admin.as, "carol@ucsb.edu", "publicity");
  return { admin, lead, alice, bob, carol };
}

async function store(t: TestConvex, bytes = 10, type = "text/plain") {
  return await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(bytes)], { type })));
}

async function upload(t: TestConvex, as: As, space: string, name = "plan.txt", extra: { folderId?: Id<"folders"> } = {}) {
  const storageId = await store(t);
  const result = await as.mutation(api.files.save, { space, storageId, name, ...extra });
  if (!result.ok) throw new Error(result.code);
  return result.fileId;
}

describe("file spaces", () => {
  test("department members upload, everyone views, only managers manage others' files", async () => {
    const t = setup();
    const { lead, alice, bob, carol } = await team(t);
    const fileId = await upload(t, alice.as, "events");

    const asCarol = await carol.as.query(api.files.listFolder, { space: "events" });
    expect(asCarol?.files.map((f) => f.name)).toEqual(["plan.txt"]);
    expect(asCarol?.files[0].canEdit).toBe(false);
    await expect(upload(t, carol.as, "events")).rejects.toThrow(/FORBIDDEN/);

    await expect(bob.as.mutation(api.files.rename, { fileId, name: "mine.txt" })).rejects.toThrow(/FORBIDDEN/);
    await alice.as.mutation(api.files.rename, { fileId, name: "final.txt" });
    await lead.as.mutation(api.files.remove, { fileId });
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_action", (q) => q.eq("action", "file.moderate_delete"))
        .collect(),
    );
    expect(audit).toHaveLength(1);
  });

  test("public is read-only for members and 主席团 is private", async () => {
    const t = setup();
    const { admin, alice } = await team(t);
    await upload(t, admin.as, "public");
    await expect(upload(t, alice.as, "public")).rejects.toThrow(/FORBIDDEN/);
    expect((await alice.as.query(api.files.listFolder, { space: "public" }))?.files).toHaveLength(1);

    await upload(t, admin.as, "presidium");
    expect(await alice.as.query(api.files.listFolder, { space: "presidium" })).toBeNull();
    const spaces = await alice.as.query(api.files.listSpaces, {});
    expect(spaces.map((s) => s.key)).not.toContain("presidium");
    expect(spaces[0].key).toBe("events");
  });

  test("duplicate names get a number and blocked types are rejected (and deleted)", async () => {
    const t = setup();
    const { alice } = await team(t);
    await upload(t, alice.as, "events", "plan.txt");
    const second = await upload(t, alice.as, "events", "plan.txt");
    const file = await alice.as.query(api.files.get, { fileId: second });
    expect(file?.file.name).toBe("plan (1).txt");

    const storageId = await store(t);
    const result = await alice.as.mutation(api.files.save, { space: "events", storageId, name: "virus.exe" });
    expect(result).toMatchObject({ ok: false, code: "FILE_TYPE_BLOCKED" });
    expect(await t.run((ctx) => ctx.db.system.get("_storage", storageId))).toBeNull();
  });

  test("uploads beyond the space quota fail with QUOTA_EXCEEDED; admins can raise it", async () => {
    const t = setup();
    const { admin, alice } = await team(t);
    await admin.as.mutation(api.files.setQuota, { space: "events", quotaBytes: 15 });
    await upload(t, alice.as, "events", "a.txt");
    await expect(upload(t, alice.as, "events", "b.txt")).rejects.toThrow(/QUOTA_EXCEEDED/);
    await expect(alice.as.mutation(api.files.setQuota, { space: "events", quotaBytes: 100 })).rejects.toThrow(
      /FORBIDDEN/,
    );
    await admin.as.mutation(api.files.setQuota, { space: "events", quotaBytes: LIMITS.defaultSpaceQuotaBytes });
    await upload(t, alice.as, "events", "b.txt");
    const overview = await admin.as.query(api.admin.overview, {});
    expect(overview.storage?.spaces.find((s) => s.key === "events")?.usedBytes).toBe(20);
  });

  test("trashing a folder and restoring it brings back exactly what was deleted together", async () => {
    const t = setup();
    const { lead, alice } = await team(t);
    const folderId = await lead.as.mutation(api.files.createFolder, { space: "events", name: "Gala" });
    const kept = await upload(t, alice.as, "events", "kept.txt", { folderId });
    const removedEarlier = await upload(t, alice.as, "events", "old.txt", { folderId });
    vi.useFakeTimers();
    await alice.as.mutation(api.files.remove, { fileId: removedEarlier });
    vi.advanceTimersByTime(1000);
    await lead.as.mutation(api.files.removeFolder, { folderId });
    vi.useRealTimers();

    const trash = await lead.as.query(api.files.listTrash, { space: "events" });
    expect(trash.folders.map((f) => f.name)).toEqual(["Gala"]);
    expect(trash.files.map((f) => f.name)).toEqual(["old.txt"]);
    await expect(alice.as.query(api.files.listTrash, { space: "events" })).rejects.toThrow(/FORBIDDEN/);

    await lead.as.mutation(api.files.restoreFolder, { folderId });
    const inside = await alice.as.query(api.files.listFolder, { space: "events", folderId });
    expect(inside?.files.map((f) => f._id)).toEqual([kept]);
  });

  test("purging trash releases quota and deletes storage", async () => {
    const t = setup();
    const { lead, alice } = await team(t);
    const fileId = await upload(t, alice.as, "events");
    await alice.as.mutation(api.files.remove, { fileId });
    await lead.as.mutation(api.files.purge, { fileId });
    const usage = await t.run((ctx) => ctx.db.query("fileSpaces").collect());
    expect(usage.find((u) => u.departmentId)?.usedBytes).toBe(0);
    expect(await t.run((ctx) => ctx.db.query("files").collect())).toHaveLength(0);
    await t.mutation(internal.files.purgeTrash, {});
  });

  test("saving a chat attachment shares the stored object, which survives attachment expiry", async () => {
    const t = setup();
    const { alice } = await team(t);
    const channels = await alice.as.query(api.channels.listMine, {});
    const channelId = channels.departments.find((c) => c.nameEn === "Events")!._id;
    const storageId = await store(t, 12);
    const attachmentId = await alice.as.mutation(api.attachments.register, { storageId, name: "photo.txt" });
    await alice.as.mutation(api.messages.send, { channelId, body: "see file", attachmentIds: [attachmentId] });
    const fileId = await alice.as.mutation(api.files.saveAttachment, { attachmentId, space: "events" });

    await t.run(async (ctx) => {
      await ctx.db.patch("attachments", attachmentId, { expiresAt: Date.now() - 1 });
    });
    await t.mutation(internal.attachments.expire, {});
    expect(await t.run((ctx) => ctx.db.system.get("_storage", storageId))).not.toBeNull();
    const file = await alice.as.query(api.files.get, { fileId });
    expect(file?.file.url).toBeTruthy();
  });

  test("files shared into a chat show as cards", async () => {
    const t = setup();
    const { alice, carol } = await team(t);
    const fileId = await upload(t, alice.as, "events");
    const channels = await carol.as.query(api.channels.listMine, {});
    const channelId = channels.org[0]._id;
    await carol.as.mutation(api.messages.send, { channelId, body: "", fileIds: [fileId] });
    const page = await alice.as.query(api.messages.list, { channelId, paginationOpts: { numItems: 10, cursor: null } });
    expect(page.page[0].files.map((f) => f.name)).toEqual(["plan.txt"]);
  });
});
