# 10 Open Questions

Decisions still to be made. Each has a **current default** that the docs and code assume until someone decides otherwise.

How to use this file:

- Agents: if your task depends on one of these, either ask the user or implement the default and mention that you did.
- When a question is decided, remove it from here, update the relevant doc, and add a line to the "Decided" log at the bottom.

## Permissions and oversight

### Q1. Cross-department DMs

A member of 活动部 DMs a member of 宣传部. Who can read it through oversight?

- **Default:** leads of **both** departments (each oversees their own member) plus presidium. This follows directly from the `oversees` rule.
- Alternative: presidium only for cross-department DMs.

### Q2. Leads' own DMs and group chats

Who can read messages sent by a department lead?

- **Default:** presidium only. Co-leads and other leads cannot.
- Alternative: co-leads of the same department can read each other's content.

### Q3. Should leads approve accounts?

- **Default:** yes, leads can approve applicants who requested their department, as members only. Presidium can approve anyone.
- Alternative: presidium only.

## Content and retention

### Q6. Officer term handover and old data

What happens to messages, files, and assignments when a school year ends?

- **Default:** keep everything. Department channels and folders carry over to the new leads. Graduated members are deactivated, not deleted.
- Alternative: archive each year's channels and start fresh ones, or auto-delete after N years.

## Features

### Q10. Department list

- **Default:** seed 主席团, 活动部, 国际部, 宣传部. Admins add the rest from the roster page.
- Needed: the full, current list of CSSA departments with official English names.

### Q12. Custom domain and account ownership

Hosting is decided (GitHub Pages static export + Convex Cloud, see Decided below).

- **Default:** `https://ucsb-cssa-dev.github.io/canvas/`, Convex free tier.
- Needed: whether CSSA wants a custom domain, and who owns the GitHub organization and Convex team for continuity across officer terms.

## Accounts and roster (added with Stage 1)

### Q14. Do pre-approvals expire?

- **Default:** no. Unclaimed pre-approvals stay active until revoked. The roster shows them so they can be cleaned up.
- Alternative: expire after N days (for example 30), or at the end of the school year.

### Q15. Do pre-approved users still see the oversight notice?

- **Default:** yes. They skip the approval wait but still complete the short onboarding (names + notice checkbox), because consent must come from the person, not the admin who invited them.
- Alternative: skip onboarding entirely and ask for names and consent later. Not recommended.

### Q16. Titles inside the hierarchy

Should the roster show titles such as 主席, 副主席, 秘书长, or only the role (主席团 member, 部长, 部员)?

- **Default:** role only.
- Alternative: an optional free-text `title` on `departmentMemberships`, edited by admins.

### Q17. Is the system admin visible on the roster?

- **Default:** yes, with a small "系统管理员 / Admin" badge wherever they appear. If they are in no department, they show under "未分配部门 / No department".
- Alternative: hide the system admin from members unless they hold a department role.

### Q18. Can leads also approve pending applicants (not just pre-approve)?

- **Default:** yes, same as Q3: leads can approve applicants who requested their department, as members only.
- Alternative: leads can only pre-approve emails; only admins approve pending applicants.

## Decided

Record decisions here as `YYYY-MM-DD - Qn - decision - where documented`.

- 2026-10-19 - Stack - Next.js + React + Tailwind + shadcn/ui, Convex backend, Gmail via Google Apps Script - [README](../README.md#tech-stack)
- 2026-10-19 - Sign-in - `@ucsb.edu` Google accounts only, admin approval required - [accounts-and-onboarding.md](features/accounts-and-onboarding.md)
- 2026-10-19 - Roles - 主席团 super admin, 1 to 2 部长 per department, oversight disclosed at signup - [02-roles-and-permissions.md](02-roles-and-permissions.md)
- 2026-10-19 - Language - Chinese primary, English secondary, toggle - [05-i18n.md](05-i18n.md)
- 2026-10-19 - Platform - web app first; email reminders via Gmail - [09-roadmap.md](09-roadmap.md)
- 2026-10-19 - Design - minimal dark theme, white text, gold accent, system fonts - [04-design-system.md](04-design-system.md)
- 2026-10-19 - Stages - Stage 1 = rough UI, hierarchy, Google sign-in, basic messaging; Stage 2 = full chat and oversight; Stage 3 = files + assignments + email; Stage 4 = AI embedding (TBA); Stage 5 = polish - [09-roadmap.md](09-roadmap.md)
- 2026-10-19 - System admin - the first account becomes system admin with full access (optional `BOOTSTRAP_ADMIN_EMAIL` lock) - [accounts-and-onboarding.md](features/accounts-and-onboarding.md#first-account-becomes-system-admin)
- 2026-10-19 - Pre-approvals - admins and leads pre-approve emails into the hierarchy; those users skip the approval queue on first sign-in - [roster.md](features/roster.md#pre-approving-emails)
- 2026-10-19 - Roster - every approved user can see the full hierarchy - [roster.md](features/roster.md)
- 2026-10-19 - Q12 - Hosting: frontend as a Next.js static export on GitHub Pages (`UCSB-CSSA-dev/canvas`), deployed with Convex by GitHub Actions; code split into `frontend/` and `backend/` workspaces - [01-architecture.md](01-architecture.md#deployment)
- 2026-10-19 - Chat access - department channel access is derived from `departmentMemberships`; `channelMembers` holds DM membership and read state only - [03-data-model.md](03-data-model.md#channels-and-channelmembers)
- 2026-10-20 - Q4 - no per-view notice; every monitored chat shows an icon (top right) whose tooltip lists who can view it, and existing users re-accept the updated notice - [09-roadmap.md](09-roadmap.md#stage-2-full-chat-and-oversight-完整聊天与监督)
- 2026-10-20 - Q5 - authors can't delete; they can recall within 5 minutes (content erased, "{name} 撤回了一条消息" kept) and edit with a public edit history; 主席团 can remove any message (content erased, audit logged) - [09-roadmap.md](09-roadmap.md#stage-2-full-chat-and-oversight-完整聊天与监督)
- 2026-10-20 - Retention - messages kept 15 days by default, extendable per chat to 1, 3, 6, or 12 months; attachments (15 MB max) always deleted after 15 days - [09-roadmap.md](09-roadmap.md#stage-2-full-chat-and-oversight-完整聊天与监督)
- 2026-10-20 - Reactions - fixed set of 8 emoji; members can react in announcement channels - [09-roadmap.md](09-roadmap.md#stage-2-full-chat-and-oversight-完整聊天与监督)
- 2026-10-20 - Chat apps - 接龙, 投票 (named or anonymous, result visibility chosen by the starter), and 集会 (weekly availability); leaders start them, members propose for approval by a leader in that chat - [09-roadmap.md](09-roadmap.md#29-chat-apps-接龙-投票-集会)
- 2026-10-20 - Group chats - 部员 propose groups with involved departments; one 部长 of an involved department (or 主席团 / system admin) approves and picks members; involved departments' 部长 are members automatically and add their own members - [09-roadmap.md](09-roadmap.md#22-group-chats-and-announcement-channels)
- 2026-10-20 - Multi-select - combined forward (合并转发) as a snapshot, and delete locally on this browser only - [09-roadmap.md](09-roadmap.md#28-multi-select-forward-delete-locally)
- 2026-10-22 - Announcements - no separate announcement channels; admins (全体) and 部长 (their department chat) post announcements inside the chat, which stay highlighted with their own badge until each reader taps 知道了 - [chat.md](features/chat.md#announcements-公告)
- 2026-10-22 - Q7 - stay on the Convex free plan: 25 MB per file, a quota per file space (default 75 MB, set by 主席团), usage card in the admin console - [files.md](features/files.md#storage-quotas)
- 2026-10-22 - File spaces - 公共 (主席团 edit), 主席团 (private), one per department (everyone views, members upload, 部长 manage); no personal files and no file oversight; files can be shared into chats and attachments saved to Files - [files.md](features/files.md#spaces)
- 2026-10-22 - Q8 - no scores; approve or request changes, plus comments - [assignments.md](features/assignments.md#review)
- 2026-10-22 - Tasks - belong to a chat; 主席团 assign anyone, 部长 within their department and groups involving it; publishing posts a card in the chat - [assignments.md](features/assignments.md#who-can-create-and-for-whom)
- 2026-10-22 - Q13 - events (e.g. 春晚) are a kind of task with a time, place, helpers and prep tasks; no RSVP - [assignments.md](features/assignments.md#tasks-and-events)
- 2026-10-22 - Q11 - a dedicated free Gmail account; the only email is a daily digest at 10:00 AM Pacific to everyone with open tasks or upcoming events, no opt-out, optional alternative address - [notifications-and-email.md](features/notifications-and-email.md#daily-digest)
- 2026-10-26 - Large files - files over 10 MB (up to 500 MB), or uploads to a full space, go to the CSSA Google Drive through the Apps Script, viewable by anyone with the link - [files.md](features/files.md#google-drive)
- 2026-10-26 - Q9 - tasks and events can have collaborative markdown documents (live editing, rendered as you type, .md and PDF export) - [assignments.md](features/assignments.md#documents)
- 2026-10-26 - Documents everywhere - documents can also be created in a Files folder and in department, group and DM chats (not 全体, by anyone who can post); `@` mentions work in documents and task descriptions and notify the person - [files.md](features/files.md#documents), [chat.md](features/chat.md#shared-documents)
- 2026-11-13 - Stage 4 - the AI assistant 小飒 (Sasa) on the UCSB L&S AI service: `@小飒` questions and task suggestions in chats with AI mode on, plus a private chat for everyone; no embeddings or vector search - [ai-assistant.md](features/ai-assistant.md)
- 2026-11-13 - AI mode - per chat, off by default, only in 全体, department and group chats (never DMs); switched by 主席团 and system admins taking part in the chat; only messages sent while it's on are readable; the header always shows 小飒 with an "readable by an LLM" popover - [ai-assistant.md](features/ai-assistant.md#ai-mode)
- 2026-11-13 - Private 小飒 chat - pinned in the chat list and a floating button on every page; answers from the member's tasks, events, meetings and AI-mode chats they take part in, never from oversight; overseeable like a DM - [ai-assistant.md](features/ai-assistant.md#private-chat)
- 2026-11-13 - Task suggestions - every message in an AI-mode chat is checked (free); the card mentions the assignees and opens the prefilled task form for people who can create (or review, for edits) tasks there - [ai-assistant.md](features/ai-assistant.md#task-suggestions)
- 2026-11-13 - AI credits - weekly: system admins unlimited, 主席团 25, 部长 15, others 5; 1 per question, 2 in total for an off-topic one (never below 0), failures refunded; refresh Sunday 08:00 Pacific - [ai-assistant.md](features/ai-assistant.md#credits)
- 2026-11-13 - AI appeals - the asker appeals an off-topic refusal once within 7 days; a system admin approves (+2 credits and a free answer) or denies (小飒 replies "这不是小飒该处理的事") - [ai-assistant.md](features/ai-assistant.md#appeals)
- 2026-11-13 - Consent v3 - the signup notice adds an AI bullet; existing users accept again - [02-roles-and-permissions.md](02-roles-and-permissions.md#signup-disclosure-必须同意)
- 2026-11-13 - 小飒 and documents - any reader can have 小飒 summarize a document (1 credit) and find its tasks, announcements and task changes; editors can have it write from a prompt (2 credits, filtered and appealable); the summary is saved under the document for everyone who can read it; the consent text stays version 3 (amended before Stage 4 ships) - [ai-assistant.md](features/ai-assistant.md#document-summaries)
- 2026-11-13 - Tasks from documents - "create all" makes drafts; assignees are notified only when the creator publishes - [ai-assistant.md](features/ai-assistant.md#document-summaries)
- 2026-11-13 - Announcements from documents - announcements a document says should be sent are found by the summary and sent by a member who may announce there; in chats with AI mode on (including group chats the member manages) 小飒 posts them on the member's behalf - [ai-assistant.md](features/ai-assistant.md#document-summaries)
- 2026-11-13 - Documents in questions - shared chats only allow documents everyone there can open (the chat's documents, its tasks' documents, Files outside the 主席团 space); the private 小飒 chat allows any readable document - [ai-assistant.md](features/ai-assistant.md#questions-about-documents)
- 2026-11-13 - Filter memory - appeal reviews can save a general rule ("should answer" / "shouldn't answer") that the relevance filter reads on every call; system admins manage the rules on /admin/ai; no fine-tuning or embeddings - [ai-assistant.md](features/ai-assistant.md#relevance-filter)
- 2026-11-13 - System admin labels - system admins are labeled "系统管理员", and 主席团 only when they're actually in 主席团 - [02-roles-and-permissions.md](02-roles-and-permissions.md)
- 2026-11-13 - Dictation - the browser's Web Speech API, no AI and no new packages; disclosed that Chrome and Edge send audio to Google or Microsoft - [ai-assistant.md](features/ai-assistant.md#dictation)
