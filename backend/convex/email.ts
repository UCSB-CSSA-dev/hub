import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import { appsScriptConfigured, callAppsScript } from "./lib/appsScript";
import { LIMITS } from "./lib/constants";
import { buildDigest, digestAddress, digestLocale, isEmptyDigest, type Digest } from "./lib/digest";
import { renderDigest } from "./lib/emailTemplates";
import { pacificDay, pacificHour } from "./lib/time";

/** Hourly: at 10:00 AM Pacific, queue one digest per approved user (the hour check handles DST). */
export const queueDigests = internalMutation({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    if (!args.force && pacificHour(now) !== LIMITS.digestHour) return;
    const day = pacificDay(now);
    const users = await ctx.db
      .query("users")
      .withIndex("by_status", (q) => q.eq("status", "approved"))
      .collect();
    for (const user of users) {
      await ctx.scheduler.runAfter(0, internal.email.queueDigestFor, { userId: user._id, day });
    }
  },
});

export const queueDigestFor = internalMutation({
  args: { userId: v.id("users"), day: v.string() },
  handler: async (ctx, args) => {
    const dedupeKey = `digest:${args.userId}:${args.day}`;
    const existing = await ctx.db
      .query("emailJobs")
      .withIndex("by_dedupeKey", (q) => q.eq("dedupeKey", dedupeKey))
      .first();
    if (existing) return;
    const user = await ctx.db.get("users", args.userId);
    if (!user || user.status !== "approved") return;
    const to = digestAddress(user);
    if (!to) return;
    const locale = digestLocale(user);
    const digest = await buildDigest(ctx, user._id, Date.now(), locale);
    if (isEmptyDigest(digest)) return;
    const jobId = await ctx.db.insert("emailJobs", {
      to,
      userId: user._id,
      template: "daily_digest",
      locale,
      params: { digest, name: (locale === "en" ? user.nameEn : user.nameZh) || user.name || "" },
      status: "queued",
      attempts: 0,
      sendAfter: Date.now(),
      dedupeKey,
      day: args.day,
    });
    await ctx.scheduler.runAfter(0, internal.email.send, { jobId });
  },
});

export const claim = internalMutation({
  args: { jobId: v.id("emailJobs") },
  handler: async (ctx, args): Promise<Doc<"emailJobs"> | null> => {
    const job = await ctx.db.get("emailJobs", args.jobId);
    if (!job || job.status !== "queued") return null;
    await ctx.db.patch("emailJobs", job._id, { status: "sending" });
    return job;
  },
});

export const finish = internalMutation({
  args: {
    jobId: v.id("emailJobs"),
    outcome: v.union(v.literal("sent"), v.literal("failed"), v.literal("quota"), v.literal("skipped")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get("emailJobs", args.jobId);
    if (!job) return;
    const now = Date.now();
    const error = args.error?.slice(0, 500);
    switch (args.outcome) {
      case "sent":
        await ctx.db.patch("emailJobs", job._id, { status: "sent", sentAt: now, attempts: job.attempts + 1, lastError: undefined });
        return;
      case "failed":
        await ctx.db.patch("emailJobs", job._id, {
          status: "failed",
          attempts: job.attempts + 1,
          lastError: error,
          sendAfter: now + 2 ** (job.attempts + 1) * 60 * 1000,
        });
        return;
      case "skipped":
        await ctx.db.patch("emailJobs", job._id, { status: "skipped", lastError: error });
        return;
      case "quota": {
        // Gmail's daily limit: today's remaining digests are skipped; tomorrow's replace them.
        await ctx.db.patch("emailJobs", job._id, { status: "skipped", lastError: "QUOTA" });
        const sameDay = await ctx.db
          .query("emailJobs")
          .withIndex("by_day", (q) => q.eq("day", job.day))
          .collect();
        for (const other of sameDay) {
          if (other.status === "queued" || other.status === "failed") {
            await ctx.db.patch("emailJobs", other._id, { status: "skipped", lastError: "QUOTA" });
          }
        }
        return;
      }
    }
  },
});

/** Renders the job and posts it to the Apps Script relay (doc/06-email-apps-script.md). */
export const send = internalAction({
  args: { jobId: v.id("emailJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.runMutation(internal.email.claim, { jobId: args.jobId });
    if (!job) return;
    const params = job.params as { digest: Digest; name: string };
    const siteUrl = process.env.SITE_URL ?? "";
    const { subject, html, text } = renderDigest(params.digest, { locale: job.locale, name: params.name, siteUrl });

    if (process.env.EMAIL_DRY_RUN === "true") {
      console.log(`email dry run: ${job.template} (${job.locale}), ${subject.length} char subject, 1 recipient`);
      await ctx.runMutation(internal.email.finish, { jobId: job._id, outcome: "sent" });
      return;
    }
    if (!appsScriptConfigured()) {
      await ctx.runMutation(internal.email.finish, { jobId: job._id, outcome: "skipped", error: "not configured" });
      return;
    }

    const result = await callAppsScript("sendEmail", {
      jobId: job._id,
      to: job.to,
      subject,
      html,
      text,
      replyTo: process.env.EMAIL_REPLY_TO || undefined,
    });

    if (result.ok) {
      await ctx.runMutation(internal.email.finish, { jobId: job._id, outcome: "sent" });
    } else if (result.code === "QUOTA") {
      await ctx.runMutation(internal.email.finish, { jobId: job._id, outcome: "quota", error: result.error });
    } else {
      console.error(`email ${job.template} failed: ${result.code ?? "?"}`);
      await ctx.runMutation(internal.email.finish, {
        jobId: job._id,
        outcome: "failed",
        error: `${result.code ?? "ERROR"}: ${result.error ?? ""}`,
      });
    }
  },
});

/** Every 10 minutes: retry today's failed emails with backoff; older ones are skipped. */
export const retryFailed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const today = pacificDay(now);
    const due = await ctx.db
      .query("emailJobs")
      .withIndex("by_status_sendAfter", (q) => q.eq("status", "failed").lte("sendAfter", now))
      .take(LIMITS.purgeBatch);
    for (const job of due) {
      if (job.day !== today) {
        await ctx.db.patch("emailJobs", job._id, { status: "skipped" });
      } else if (job.attempts >= LIMITS.emailAttempts) {
        // Out of attempts: stays failed for the admin card, but leaves the retry query.
        await ctx.db.patch("emailJobs", job._id, { sendAfter: Number.MAX_SAFE_INTEGER });
      } else {
        await ctx.db.patch("emailJobs", job._id, { status: "queued" });
        await ctx.scheduler.runAfter(0, internal.email.send, { jobId: job._id });
      }
    }
  },
});
