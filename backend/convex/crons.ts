import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.hourly("purge expired messages", { minuteUTC: 5 }, internal.maintenance.purgeMessages, {});
crons.hourly("expire attachments", { minuteUTC: 15 }, internal.attachments.expire, {});
crons.hourly("expire group proposals", { minuteUTC: 25 }, internal.groups.expireProposals, {});
crons.hourly("purge finished chat apps", { minuteUTC: 35 }, internal.apps.purge, {});
crons.hourly("ensure seed data", { minuteUTC: 45 }, internal.maintenance.seed, {});
crons.hourly("task and event reminders", { minuteUTC: 50 }, internal.assignments.sendReminders, {});
// Runs every hour; only the run at 10:00 AM Pacific queues digests, which keeps DST changes simple.
crons.hourly("queue daily digests", { minuteUTC: 0 }, internal.email.queueDigests, {});
crons.interval("retry failed emails", { minutes: 10 }, internal.email.retryFailed, {});
crons.daily("clean up notifications", { hourUTC: 11, minuteUTC: 0 }, internal.notifications.cleanup, {});
crons.daily("empty file trash", { hourUTC: 11, minuteUTC: 30 }, internal.files.purgeTrash, {});
crons.hourly("forget unfinished Drive uploads", { minuteUTC: 40 }, internal.drive.cleanupUploads, {});
crons.interval("fail stuck Sasa requests", { minutes: 10 }, internal.ai.sweepStale, {});
crons.daily("clean up Sasa ledger", { hourUTC: 12, minuteUTC: 0 }, internal.ai.cleanup, {});

export default crons;
