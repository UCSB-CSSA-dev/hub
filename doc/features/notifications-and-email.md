# Feature: Notifications and Email (通知与邮件)

## Summary

Three delivery channels:

1. **In-app notifications**: a bell icon with an unread count, plus the `/notifications` page. Real time through Convex.
2. **Push notifications** (Web Push): system notifications on devices where the user turned them on in Settings, even when CSSA Hub is closed. See [Push notifications](#push-notifications).
3. **Email**: one daily digest per person, sent through a dedicated free Gmail account by a Google Apps Script web app. Nothing else is emailed. Transport details are in [06-email-apps-script.md](../06-email-apps-script.md).

## Triggers

Every notification below is in-app and pushed. Email is only the [daily digest](#daily-digest).

| Event | Recipients | Type |
| --- | --- | --- |
| @mention or reply | Mentioned or replied-to user | `mention`, `reply` |
| Announcement posted | Everyone in the chat | `announcement` |
| Added to a department or group | That user | `added_to_department`, `added_to_group` |
| Group and chat-app events | See [chat.md](chat.md) | `group_*`, `app_*` |
| Deactivation request reviewed | The requester | `deactivation_reviewed` |
| Task or event published | Each assignee | `assignment_new` |
| Task or event changed (due date, time, place) | Assignees | `assignment_updated` |
| Task due in 24 hours | Assignees who haven't submitted | `assignment_due_soon` |
| Task overdue (once) | The same | `assignment_overdue` |
| Event starts in 24 hours | Helpers | `event_soon` |
| Submission received | Creator | `submission_received` |
| Submission approved, changes requested, or marked complete by a reviewer | Assignee | `submission_reviewed` (`decision`: `approve`, `request_changes`, `complete`) |
| New comment on a submission | The other side (assignee or reviewers) | `assignment_comment` |
| @mentioned in a document | Newly mentioned people who can open it | `doc_mention` |
| @mentioned in a task or event description | Newly mentioned people in the chat (not those just assigned) | `task_mention` |

Account requests, approvals and invites are not emailed. Approvers see the roster badge, and applicants see the result when they next sign in.

## In-app notifications

- `notifications.listMine` (paginated, newest first) and `notifications.unreadCount`.
- Clicking a notification marks it read and navigates to `link` (prefixed with the current locale).
- "全部标为已读 / Mark all as read".
- The display text is **not stored**. Store `type` + `params`, and render through `next-intl` keys like `notifications.assignment_new` with params `{ title, by }`, so each user sees their own language.
- Keep 90 days. A daily cron deletes older read notifications.

## Push notifications

Standard Web Push (service worker + VAPID), so it works with a static GitHub Pages site and Convex.

**What pushes:** every in-app notification (mentions, replies, announcements, group and app events, review results), plus every new **chat message** (DMs, 全体, department and group chats) to everyone in that chat except the sender and those who muted it. Someone who already got a mention, reply or announcement push for a message doesn't get a second one. Plain messages have no notification row; the chat list's unread count covers them in-app. A DM push is titled with the sender; other chats are titled with the chat name, with "sender: preview" as the body. Editing a message only pushes newly added mentions.

**Turning it on (Settings → 推送通知):**
- Per device. "开启通知" asks for the browser permission, subscribes with the deployment's VAPID public key (`push.config`), saves the subscription (`push.subscribe`) and sends a test push. "发送测试通知" and "在这台设备上关闭" are available afterwards.
- iPhone: Web Push only works in a web app added to the Home Screen (iOS 16.4+). In a Safari tab the card explains this; the "iPhone 设置说明" dialog walks through Share → Add to Home Screen → open from the icon → turn on.
- `app/manifest.ts` (standalone display, phoenix icons) is what makes "Add to Home Screen" open as an app.
- Signing out unsubscribes the device first, so the next person using it doesn't get the previous user's notifications. A subscribed endpoint follows whoever subscribed on it last.
- `PushSync` re-saves the subscription on each app load, since browsers can rotate or drop subscriptions.
- Reminder on the 通知 page (`PushReminder`): while this device can't get pushes (off, an iPhone Safari tab, or blocked), a gold card at the top says so, explains that updating, reinstalling or re-adding the Home Screen app turns notifications off, and offers "开启通知" (when possible), the iPhone guide and a link to Settings. It disappears once push is on, and never shows when the deployment has no VAPID keys or the browser can't do push at all.

**Sending:**
- `lib/notify.ts` and `messages.send` (for plain chat messages) call `queuePush`, which schedules `internal.pushNode.send` only for recipients with at least one device (users without push cost nothing).
- `pushNode.send` (Node action, `web-push`) builds the text server-side in each recipient's `users.locale` (`lib/pushText.ts` mirrors the `notifications.*` strings, since the service worker can't run next-intl), sends to every device, and deletes subscriptions the push service reports as gone (404/410). Deactivated or not-approved users get nothing.
- Payloads are encrypted end to end by the Web Push protocol; Apple, Google and Mozilla relay them without being able to read message previews.
- `public/sw.js` shows the notification and, on tap, focuses an open CSSA Hub window and navigates to the link, or opens one. On Chrome and Firefox it skips the system notification while a CSSA Hub window is focused. Anything on Apple's push service (Safari, every iOS browser, home-screen apps) always shows it, because Apple may revoke subscriptions that receive silent pushes. It detects Apple by WebKit rather than "Safari", since home-screen apps often leave "Safari" out of their user agent.
- `pushNode.send` logs one line per push (`push <type>: x/y delivered, n expired, m failed`), with no names or content, for debugging delivery.
- iPhone: removing and re-adding the Home Screen app (for example to pick up a new icon) creates a fresh app with its own storage, so notifications must be turned on again in its Settings. The old app's subscription is dropped the next time a push to it comes back as expired.

**Configuration:** Convex env `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (generate with `npx web-push generate-vapid-keys` in `backend/`), optional `VAPID_SUBJECT` (`mailto:` address). Without the keys the Settings card says notifications aren't set up and nothing is sent.

## Email

### Principles

- A free Gmail account can send to roughly **100 recipients per day**. One email per person per day keeps the Hub under that until about 90 people have open tasks on the same day.
- Every email is a row in `emailJobs` first (an outbox). User-facing mutations never call Apps Script directly.
- Language: the recipient's `users.locale`.

### Daily digest

Sent every day, weekends included, at **10:00 AM Pacific**.

- **Who gets it:** every approved, active user who has something in it. A day with nothing to report sends nothing. There's no opt-out.
- **Where it goes:** `users.digestEmail` if set, otherwise their sign-in email. Settings → 邮件摘要 has one field, "接收邮箱 / Send my digest to", with a reset to the sign-in address. The address only has to look valid; it isn't verified.
- **What's in it** (only the viewer's own tasks and events, open ones only):
  1. **今天 Today** (highlighted at the top): overdue tasks, tasks due today, and events today with time and place.
  2. **未来一周的活动 Events in the next 7 days**, after today.
  3. **待办 To-do:** every other open task: due later, or no due date. Tasks waiting for review aren't to-dos; tasks with changes requested are.
- Each item links to its task page. The footer says it's a daily summary and that the address can be changed in Settings.
- Rendered on the Convex side in `convex/lib/emailTemplates.ts` (template `daily_digest`, zh and en). The Apps Script stays a thin relay. Escape every user-provided value.

### Pipeline

1. An hourly cron (`internal.email.queueDigests`) does nothing unless the Pacific hour is 10, which handles daylight saving time. It schedules `internal.email.queueDigestFor` for each approved user, so one large mutation never builds everyone's digest.
2. `queueDigestFor` builds the user's digest (`convex/lib/digest.ts`), skips it if empty, and otherwise inserts a `queued` job with `dedupeKey = digest:<userId>:<YYYY-MM-DD>` (a second run the same day does nothing) and schedules `internal.email.send`.
3. `internal.email.send` (action) claims the job (`sending`), POSTs to Apps Script, then records the outcome through `internal.email.finish`: `sent`, or `failed` with `attempts + 1` and `lastError`. Without `APPS_SCRIPT_URL` and `APPS_SCRIPT_SHARED_SECRET` the job is `skipped` as "not configured".
4. A cron every 10 minutes retries `failed` jobs with `attempts < 5`, with backoff (`sendAfter = now + 2^attempts minutes`). Jobs from an earlier day are marked `skipped` instead, since tomorrow's digest replaces them.
5. If Apps Script reports `QUOTA`, all of today's queued jobs become `skipped`. The admin overview shows it.
6. With `EMAIL_DRY_RUN=true` (dev), `send` logs the subject and recipient count and marks the job `sent` without calling the script.

The admin overview has an email card: today's digest counts (sent, failed, skipped) and the last error.

## Acceptance criteria

- [ ] The bell count updates in real time.
- [ ] With push on, a mention or DM shows a system notification on a closed desktop browser, an Android phone, and an iPhone home-screen app; tapping it opens the right chat.
- [ ] After signing out on a device, that device stops getting pushes.
- [ ] Notifications render in the viewer's current language.
- [ ] At 10:00 AM Pacific, everyone with open tasks or upcoming events gets exactly one digest; people with nothing get none.
- [ ] The digest puts today's tasks and events first, then the next week's events, then all other to-dos.
- [ ] A digest goes to the address set in Settings when there is one.
- [ ] Failed emails retry up to 5 times with backoff and never send duplicates.
- [ ] A quota error skips the rest of the day's digests instead of retrying in a loop.
