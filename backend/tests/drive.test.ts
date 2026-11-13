import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { LIMITS } from "../convex/lib/constants";
import { addMember, bootstrapAdmin, setup, type TestConvex } from "./helpers";

const MB = 1024 * 1024;

async function team(t: TestConvex) {
  const admin = await bootstrapAdmin(t);
  const alice = await addMember(t, admin.as, "alice@ucsb.edu", "events");
  const carol = await addMember(t, admin.as, "carol@ucsb.edu", "publicity");
  return { admin, alice, carol };
}

/** Fakes the Apps Script relay and records what Convex sent it. */
function fakeRelay(size = 20 * MB) {
  process.env.APPS_SCRIPT_URL = "https://script.example/exec";
  process.env.APPS_SCRIPT_SHARED_SECRET = "secret";
  process.env.SITE_URL = "https://ucsb-cssa-dev.github.io/hub";
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push(body);
    const reply =
      body.action === "driveSession"
        ? { ok: true, uploadUrl: "https://www.googleapis.com/upload/drive/v3/files?upload_id=abc" }
        : body.action === "driveFinalize"
          ? { ok: true, size, mimeType: "video/mp4", name: "recap.mp4" }
          : { ok: true };
    return new Response(JSON.stringify(reply));
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.APPS_SCRIPT_URL;
  delete process.env.APPS_SCRIPT_SHARED_SECRET;
});

const video = { space: "events", name: "recap.mp4", size: 20 * MB, contentType: "video/mp4" };

describe("Google Drive overflow", () => {
  test("needs the Apps Script to be configured", async () => {
    const t = setup();
    const { alice } = await team(t);
    await expect(alice.as.action(api.drive.startUpload, video)).rejects.toThrow(/DRIVE_NOT_CONFIGURED/);
  });

  test("checks rights, size and type before opening a session", async () => {
    const t = setup();
    const { carol, alice } = await team(t);
    const calls = fakeRelay();
    await expect(carol.as.action(api.drive.startUpload, video)).rejects.toThrow(/FORBIDDEN/);
    await expect(
      alice.as.action(api.drive.startUpload, { ...video, size: LIMITS.driveFileBytes + 1 }),
    ).rejects.toThrow(/FILE_TOO_LARGE/);
    await expect(alice.as.action(api.drive.startUpload, { ...video, name: "setup.exe" })).rejects.toThrow(
      /FILE_TYPE_BLOCKED/,
    );
    expect(calls).toHaveLength(0);
  });

  test("records the Drive file without using quota, and trashes it on purge", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { alice, admin } = await team(t);
    const calls = fakeRelay();

    const { uploadId, uploadUrl } = await alice.as.action(api.drive.startUpload, video);
    expect(uploadUrl).toContain("upload_id");
    expect(calls[0]).toMatchObject({
      action: "driveSession",
      secret: "secret",
      folder: "events",
      origin: "https://ucsb-cssa-dev.github.io",
    });

    // Someone else can't finish Alice's upload.
    await expect(
      admin.as.action(api.drive.finishUpload, { uploadId, driveFileId: "1AbCdEfGhIjKlMnOp" }),
    ).rejects.toThrow(/NOT_FOUND/);

    const saved = await alice.as.action(api.drive.finishUpload, { uploadId, driveFileId: "1AbCdEfGhIjKlMnOp" });
    expect(saved.ok).toBe(true);
    const folder = await alice.as.query(api.files.listFolder, { space: "events" });
    expect(folder?.files[0]).toMatchObject({ name: "recap.mp4", drive: true, size: 20 * MB });
    expect(folder?.files[0].previewUrl).toContain("/file/d/1AbCdEfGhIjKlMnOp/preview");
    expect(folder?.space.usedBytes).toBe(0);

    if (!saved.ok) throw new Error();
    await alice.as.mutation(api.files.remove, { fileId: saved.fileId });
    await admin.as.mutation(api.files.purge, { fileId: saved.fileId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(calls.at(-1)).toMatchObject({ action: "driveTrash", fileId: "1AbCdEfGhIjKlMnOp" });
  });

  test("a file Drive reports as too large is trashed instead of recorded", async () => {
    const t = setup();
    const { alice } = await team(t);
    const calls = fakeRelay(LIMITS.driveFileBytes + MB);
    const { uploadId } = await alice.as.action(api.drive.startUpload, video);
    const saved = await alice.as.action(api.drive.finishUpload, { uploadId, driveFileId: "1AbCdEfGhIjKlMnOp" });
    expect(saved).toMatchObject({ ok: false, code: "FILE_TOO_LARGE" });
    expect(calls.at(-1)).toMatchObject({ action: "driveTrash" });
    expect((await alice.as.query(api.files.listFolder, { space: "events" }))?.files).toHaveLength(0);
  });
});
