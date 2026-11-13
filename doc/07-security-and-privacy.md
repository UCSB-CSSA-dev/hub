# 07 Security and Privacy

## Threat model (short)

| Risk | Mitigation |
| --- | --- |
| Outsiders signing in | Google OAuth limited to verified `@ucsb.edu` emails, plus manual approval or an explicit pre-approval of that exact email |
| Someone grabbing system admin by signing in first | `BOOTSTRAP_ADMIN_EMAIL` lock in prod; the first-admin check runs inside one transaction |
| Wrong person pre-approved (typo in email) | Pre-approvals only match the exact verified email; unclaimed ones are visible on the roster and can be revoked |
| A member reading content they shouldn't | Server-side permission checks in every Convex function ([02-roles-and-permissions.md](02-roles-and-permissions.md)) |
| Abuse of oversight power | Oversight is read-only, disclosed at signup, and every use is audit logged; only presidium can read the log |
| Leaked file links | Download URLs are only issued after a permission check; files are never listed publicly. Files in Google Drive (over 10 MB, or uploaded to a full space) are viewable by anyone with the link, so a copied link keeps working; keep sensitive large files out of the Hub |
| Email relay abuse | Shared secret on the Apps Script; secret only in Convex environment variables |
| XSS through messages or file names | Render user content as text or sanitized markdown; never inject raw HTML |
| Former members keeping access | Deactivation blocks every function immediately; yearly handover flow |
| Member content leaving the app through 小飒 | Only chats where a 主席团 member or system admin switched AI mode on, and only messages sent while it was on (`aiReadable`), plus the asker's own private chat. Context is built only from chats the asker takes part in (never through oversight), and tasks are filtered by `taskAccess`. AI mode is shown in the chat header and disclosed at signup (consent v3) |
| A document leaking into a chat through 小飒 | Documents attached to a question in a shared chat must be readable by everyone there (`docSharedIn`: the chat's documents, its published tasks' documents, Files outside the 主席团 space), checked in `messages.send` and again when the answer is built. Any readable document is allowed only in the private 小飒 chat. A document summary is shown to the document's readers and is built only from the document and what its audience can see |
| Prompt injection in chat messages or documents | The model has no tools and can't change data. Its answer goes only into the chat the question was asked in, and the context only holds what the asker can already read there. Task suggestions are re-validated on the server (assignees must be in the chat's audience, the edited task must belong to the chat) and only take effect when an allowed person reviews and saves the prefilled form. From a document summary, tasks become private drafts, announcements are shown for editing and sent only when a member who may announce presses Send, and writing results are applied only by the editor |
| Members steering the filter or leaking through its memory | Only system admins can write filter rules (`aiFilterMemory`); members' text never becomes a rule unless an admin saves it, and every change is audited (`ai.memory_change`). Rules are sent with everyone's filter calls, so admins are told to write general rules without personal details; the question is only a starting point for the rule text |
| The AI key leaking | Stored only as a Convex environment variable, read only inside Convex actions, never logged or returned to clients. Locally it sits in the gitignored root `.env`, and `npm run ai:env` passes it to the Convex CLI through stdin (not argv), without printing it |
| Running up AI costs | Weekly credits per role, one request (question, summary or writing prompt) in flight per person, 60 suggestion scans per chat per hour behind a keyword pre-filter, a 90-second timeout for chat answers and 3 minutes for document requests, document text capped at 24,000 characters per request |

## Authentication

- Convex Auth with Google. Sessions are managed by Convex Auth (JWT + refresh tokens).
- Server-side domain check: verified email ending in `@ucsb.edu`. The `hd` parameter is only a UI hint.
- `requireApproved(ctx)` at the top of every function except the onboarding ones listed in [features/accounts-and-onboarding.md](features/accounts-and-onboarding.md#account-status-lifecycle).
- The status check runs on every call, so deactivation takes effect on the next request without waiting for the session to expire.

## Authorization rules for implementers

1. Load the viewer once per function with `requireApproved(ctx)`.
2. Load the target document, return `NOT_FOUND` if missing **or** if the viewer cannot read it (don't reveal existence).
3. Check the specific action with a helper (`channelAccess` flags such as `canPost` or `canModerate`, `canWriteFolder`, ...). Throw `FORBIDDEN` when it fails, or `READ_ONLY` for read-only chats.
4. When access is granted through oversight, write an audit log entry (from a mutation; queries can't write).
5. Validate all arguments with Convex validators (`v.*`). Validate lengths and limits (message 4,000 characters, title 120, chat attachment 15 MB, Files 10 MB in Convex and 500 MB in Google Drive). Limits live in `LIMITS` in `convex/lib/constants.ts`.
6. Never accept a `userId` argument to mean "act as this user". The acting user always comes from `ctx.auth`.
7. Use `internalMutation` / `internalAction` for anything the client must not call directly (email, notification fan-out, crons, seed).

## File security

- Upload URLs (`ctx.storage.generateUploadUrl()`) are issued only after checking write access to the target folder, channel, or assignment.
- After upload, `saveFile` re-validates size and content type from `_storage` system metadata rather than trusting the client.
- Download URLs come from `ctx.storage.getUrl()` only after `canReadFile`. These URLs are unguessable but not revocable, so don't log them or put them in emails; emails link to the app page instead.
- Blocked executable types are listed in [features/files.md](features/files.md#uploads).

## Secrets and environment variables

Never commit secrets. `.env.local` is gitignored.

### Convex deployment environment variables

| Variable | Purpose |
| --- | --- |
| `AUTH_GOOGLE_ID` | Google OAuth client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret |
| `SITE_URL` | Public URL of the frontend **including the base path**, no trailing slash (for auth redirects and email links). Dev `http://localhost:3000`, prod `https://ucsb-cssa-dev.github.io/hub` |
| `JWT_PRIVATE_KEY`, `JWKS` | Generated by Convex Auth setup |
| `APPS_SCRIPT_URL` | Email relay URL |
| `APPS_SCRIPT_SHARED_SECRET` | Email relay secret |
| `EMAIL_REPLY_TO` | Optional reply-to address |
| `EMAIL_DRY_RUN` | `true` in dev to skip real sending |
| `ALLOWED_EMAIL_DOMAIN` | `ucsb.edu` (configurable for testing) |
| `BOOTSTRAP_ADMIN_EMAIL` | Optional. If set, only this email can become the first system admin. Strongly recommended in prod |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push key pair (`npx web-push generate-vapid-keys`). The public key is served to browsers by `push.config`; the private key signs pushes and must stay in Convex. Without them push is off |
| `VAPID_SUBJECT` | Optional `mailto:` contact sent to push services. Defaults to `mailto:noreply@ucsb.edu` |
| `AI_API_KEY` | Key for the UCSB L&S AI service (小飒). Without it, AI features are off. Keep it in the gitignored root `.env` and copy it with `npm run ai:env --workspace backend` (`-- --prod` for production); never commit or print it |
| `AI_BASE_URL` | Optional. Defaults to `https://api.ai.college.ucsb.edu/v1` |
| `AI_MODEL_FAST`, `AI_MODEL_ANSWER` | Optional. Relevance filter and suggestions (default `gemma-4-26b-a4b-it`); answers (default `qwen3.8-27b`) |
| `AI_DRY_RUN` | `true` in local development to return canned answers without calling the API |

### Frontend build variables (`frontend/.env.local`, or set by CI)

These are inlined into the static bundle at build time, so they must never hold secrets.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_CONVEX_URL` | Convex deployment URL. Locally: optional, `next.config.ts` falls back to `CONVEX_URL` from `backend/.env.local`. In deploy: injected by `npx convex deploy --cmd` |
| `NEXT_PUBLIC_BASE_PATH` | Empty locally; `/hub` on GitHub Pages (from `actions/configure-pages`) |

### Backend CLI (`backend/.env.local`, written by `npx convex dev`)

| Variable | Purpose |
| --- | --- |
| `CONVEX_DEPLOYMENT`, `CONVEX_URL` | Which dev deployment the Convex CLI talks to |

### GitHub repository secrets

| Secret | Purpose |
| --- | --- |
| `CONVEX_DEPLOY_KEY` | Production deploy key used by `deploy.yml` to run `npx convex deploy` |

## Privacy

- **Disclosure first.** Oversight is explained before the account exists and is always visible in Settings. See the exact text in [02-roles-and-permissions.md](02-roles-and-permissions.md#signup-disclosure-必须同意).
- **Data minimization.** Collect only what is in the onboarding form. No phone numbers or student IDs.
- **Retention defaults:**
  - Chat messages: 15 days by default; admins and 部长 can extend a chat to 30, 90, 180, or 365 days. Purged hourly with their reactions and edit history.
  - Chat attachments: 15 days after sending, regardless of chat retention. Their URLs work for anyone with the link until then, which the notice discloses.
  - Recalled and moderator-removed messages: content erased immediately; only the placeholder row remains.
  - Files (Stage 3): kept until deleted, then 30 days in trash before purge.
  - Notifications: read ones are deleted after 90 days.
  - Email jobs: 30 days after sending. A digest job holds the text of the unread messages it listed, so this also bounds how long those copies live.
  - 小飒 questions and answers are ordinary messages and follow the chat's retention. The credit ledger (`aiRequests`, `aiCreditAdjustments`), settled appeals (which keep a snapshot of the question) and task suggestions are deleted after 35 days. Writing drafts are deleted after 7 days; a document's summary and its plain-text copy (`documents.text`) are deleted with the document.
  - Audit logs: kept indefinitely (at least 2 years).
- **Leaving CSSA.** Deactivated users' content stays for organizational continuity. A user can ask presidium to delete files they uploaded; presidium can delete them from Files.
- **Files kept on a device.** Files opened in the app stay in that browser's IndexedDB until the user deletes them in Settings or signs out. See [files.md](features/files.md#kept-on-this-device).
- **AI processing (Stage 4).** Content sent to 小飒 goes to the UCSB College of Letters & Science AI service (`AI_BASE_URL`) and nowhere else. What is sent, per question: the question, the readable messages of the chat (or, in the private chat, of the AI-mode chats the member takes part in), the relevant tasks, events and 集会, and names as "中文名 (English name)". For document features: the attached documents' text, the document being summarized (with its chat's member names and open tasks), or the document and prompt being written. Details: [features/ai-assistant.md](features/ai-assistant.md).
- **Dictation.** Document dictation uses the browser's Web Speech API, not 小飒. Chrome and Edge send the audio to Google's or Microsoft's speech service; Safari may recognize it on the device. The app never receives or stores audio, only the recognized text typed into the document. Disclosed in the dictation bar, the new-document dialog, the signup notice and the privacy policy.
- No analytics or third-party trackers in v1.

## Operational checklist before launch

- [ ] Google OAuth consent screen configured; authorized redirect URI is `https://<prod-deployment>.convex.site/api/auth/callback/google`.
- [ ] `SITE_URL` on prod is `https://ucsb-cssa-dev.github.io/hub` (or the custom domain), and `CONVEX_DEPLOY_KEY` is set in GitHub.
- [ ] Prod Convex env vars set; `EMAIL_DRY_RUN` unset in prod.
- [ ] Apps Script deployed under the CSSA account with a prod-only secret.
- [ ] `BOOTSTRAP_ADMIN_EMAIL` set in prod, and the system admin signs in first to claim the role.
- [ ] Permission tests pass (see [08-conventions.md](08-conventions.md#testing)).
- [ ] Disclosure text reviewed and approved by presidium.
- [ ] `AI_API_KEY` set on prod (`npm run ai:env --workspace backend -- --prod`) and `AI_DRY_RUN` unset, if 小飒 should be on.
