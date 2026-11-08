# Feature: Chat (聊天)

## Summary

Real-time messaging similar to GroupMe or WeChat: org-wide and department channels (with announcements posted inside them), group chats that belong to departments, and direct messages. Built on Convex subscriptions, so there is no websocket code. Chats are monitored (see [Oversight](#oversight)) and content expires (see [Retention](#retention)).

The decisions behind this design are in [09-roadmap.md, Stage 2](../09-roadmap.md#stage-2-full-chat-and-oversight-完整聊天与监督).

## Channel types

| Type | Created by | Who reads | Who posts | Name |
| --- | --- | --- | --- | --- |
| `org` | Seed | All approved users (implicit) | All approved users; announcements: admins | "全体 / General" |
| `department` | With the department | That department's members (derived); the 主席团 chat also includes every 部长 of a regular department | Readers; announcements: that department's 部长, admins | Department name |
| `group` | Proposal approved by a 部长, or created directly by a 部长 / admin | Explicit members, plus the 部长 of every involved department (derived), plus 主席团 during a takeover | Readers | Custom name |
| `dm` | Any approved user | Exactly 2 | Both, unless one is deactivated | Other person's name |

"Derived" access is computed on every read from `departmentMemberships`, so roster changes apply immediately. A `channelMembers` row is created lazily the first time someone opens an implicit channel; it holds `lastReadAt`, `announcementsReadAt`, and `muted`. Group and DM members are stored explicitly (`channelMembers.joinedAt` is set for explicit group members).

Every access decision goes through `channelAccess` in `backend/convex/lib/channels.ts`, which returns `{ via: "member" | "oversight", readOnly, canPost, canAnnounce, canInteract, canManage, canModerate, canSetRetention, canApproveApps, canProposeApps, canMentionAll }`.

Until 2026-10 announcements had their own `announcement` channels ("CSSA 公告", "{部门}公告"). `maintenance.mergeAnnouncementChannels` folds them into the org chat and each department's chat: messages move over flagged as announcements, the old read position becomes `announcementsReadAt`, chat apps and notification links follow, and the old channel is deleted. The hourly `maintenance.seed` starts it whenever a legacy channel is left. The `announcement` channel type stays in the schema only for that migration and for old forward snapshots.

## Announcements (公告)

- Admins in 全体, and a department's 部长 and admins in that department's chat, see a megaphone toggle ("发布为公告") next to the attach button. While it's on, the composer turns amber and says everyone will be notified; it switches off after sending.
- `messages.send` with `announcement: true` requires `canAnnounce`. The message is stored with `announcement: true` and notifies everyone who reads the chat except the author (type `announcement`, batches of 200, with push), even if they muted the chat. Mentions and replies inside an announcement add no separate notifications.
- In the timeline an announcement has an amber left border and a "公告" tag next to the author, and never groups with neighboring messages.
- **Unseen until acknowledged:** reading the chat doesn't dismiss an announcement. `channelMembers.announcementsReadAt` tracks acknowledgement separately from `lastReadAt`:
  - The chat list puts an amber megaphone badge on the chat's avatar box and starts the preview with "[N 条公告]". It shows even when the chat is muted.
  - Opening the chat shows a bar under the header with the newest unseen announcement ("N 条未读公告 · 作者：内容"). Tapping it jumps to the message; the arrow steps through older unseen ones; "知道了" acknowledges all of them (`channels.markAnnouncementsSeen`).
- Recalled or removed announcements stop counting.

## Layout

```text
+-------------------+---------------------------------------------+
| 全体              | 活动部                        👁  🔍  ⋮      |
|   全体     (📢2)  |---------------------------------------------|
| 部门              | 📢 2 条未读公告 · Lisa：周五 6 点开会  ⌄ 知道了|
|   活动部      (5) |---------------------------------------------|
|                   | [投票 · 午餐选什么 · 12人] [接龙 · 报名 · 8人] [+]|
|                   |---------------------------------------------|
|                   |  Alice  10:02                               |
|                   |  明天活动的物资清单已上传                    |
| 群聊        📋 +  |  Bob  10:05   (已编辑)                       |
|   迎新海报        |  @Alice 收到                       👍 2      |
| 私信          +   |                                             |
|   Carol      (1)  |---------------------------------------------|
| 监督              | 📎 📢  发送消息到 活动部              [发送] |
|   查看成员聊天 ▸  |                                             |
+-------------------+---------------------------------------------+
```

- Chat list rows are WeChat-style, under the same 全体 / 部门 / 群聊 / 私信 headers: an avatar box on the left (the other person for DMs, a grid of up to 9 member photos for department and group chats, the CSSA mark for 全体), then the name with the latest message's time, and below it the latest message as "sender: text" (DMs leave the sender out unless it's you; recalled and removed messages, forwards, task and doc cards, and attachments get labels). `channels.listMine` returns `preview` and `faces` for this; the oversight list doesn't get previews, so reading message text there still goes through the logged chat view.
- Unread counts are red bubbles on the avatar box; muted chats show a dot instead and a bell-off icon on the row. Every new message pushes to devices with notifications on, except in muted chats (see [Push notifications](notifications-and-email.md#push-notifications)). Unseen announcements replace the badge with an amber megaphone badge (see [Announcements](#announcements-公告)). Ended groups and archived channels are dimmed with a tag.
- The 群聊 header has the proposals button (with a dot when something waits for the viewer) and "+" (propose for 部员, create for 部长 and admins).
- The 监督 section shows only for admins and 部长.
- The people icon in the conversation header (left of the 👁) opens the member list (`channels.members`): a centered dialog on phones, a full-height panel on the right from `md` up. 主席团 come first, then 部长 with their departments, then everyone else; a search box appears from 12 members.
- Below the `lg` breakpoint (1024px), including tablets where the app sidebar is still shown, the channel list and the conversation are separate screens; the conversation header has a back arrow to the list. From `lg` up they sit side by side and the org channel opens by default.
- URL parameters on `/chat/`: `c` (channel), `m` (jump to a message), `app` (open a chat app), `proposals=1` (open the group proposals dialog), `oversee=<userId>` (oversight view of one person).

## Messages

### Content

- Markdown limited to bold, italic, inline code, code blocks, lists, quotes, and auto-linked URLs, rendered by `react-markdown` with an element allow-list and `skipHtml`. No images in markdown.
- Up to 4,000 characters.
- Mentions are stored in the body as `<@userId>` and `<@all>`, so renamed people display correctly. The composer shows "@Name" and encodes on send. `@all` is for admins anywhere they post and 部长 in their own department channels.
- Replies quote another message in the same channel; the quote shows a placeholder if the original was recalled, removed, or purged. Clicking it jumps to the original.
- Reactions: a fixed set (👍 ❤️ 😂 🎉 👀 🙏 ✅ 🔥), including on announcements; the tooltip shows who reacted.

### Actions

| Action | Who | Behavior |
| --- | --- | --- |
| Send | Readers who can post | Mentions and replies notify; announcements notify every reader |
| Edit | Author, any time | Previous version saved to `messageEdits`; shows "(已编辑)"; anyone who can read the chat can open the history |
| Recall (撤回) | Author, within 5 minutes of sending (server time) | Content, reactions, edit history, attachments, and its notifications are erased; shows "{name} 撤回了一条消息" |
| Remove | 主席团 and system admins | Same erasure as recall; shows "该消息已被主席团移除"; audit logged as `message.moderate_remove` |
| React | Participants (not through oversight) | Toggles a `messageReactions` row |
| Forward, select, copy | See [Multi-select](#multi-select) | |

There is no delete. Recall, edit, and react are never available through oversight; removal is the only write allowed there.

- **Desktop:** hovering a message shows a toolbar (react, reply, more).
- **Phones and tablets:** touch and hold a message (about 0.45 s) to open a bottom sheet with the reaction row and the same actions. Text selection and the system callout are off on message rows on touch screens; "复制 / Copy" in the sheet copies the text.

### Composer keys

- Enter sends, on key **up**; Shift+Enter adds a line.
- Enter that confirms an input-method candidate (pinyin and the like) only types it. The key-down is ignored while `isComposing` is set or the key code is 229 (Safari ends the composition before that key-down). The same rule covers @-mention pickers and every one-line dialog that submits on Enter (`lib/keyboard.ts`).

### Read state and loading

- `messages.list` is paginated, 50 per page, newest first; the view loads older pages on demand.
- Members mark a channel read when they view it; announcements stay unseen until acknowledged. Oversight never changes read state.
- `messages.around` loads the messages around one message, for search results, reply quotes, and notification links. A purged target shows "这条消息已超过保留期限".

## Retention

- Messages are deleted from the server after the chat's `retentionDays`: 15 by default, or 30, 90, 180, 365.
- Admins can change it on any chat; 部长 on their own department's chat and on groups they manage; DMs are admin-only. Every change posts a system message and writes `channel.retention_change`.
- An hourly cron (`maintenance.purgeMessages`) deletes expired messages with their reactions and edit history, 500 per run, rescheduling itself. Ended groups are deleted entirely once their retention has passed.
- The bottom of each chat says how long messages are kept.

## Attachments

- Up to 10 files per message, 15 MB each. Larger files are rejected in the browser with a suggestion to upload to Google Drive and send the link.
- Upload flow: `attachments.generateUploadUrl`, then `attachments.register` (server checks the size; unsent uploads expire after 24 hours), then `messages.send` attaches rows the sender owns.
- Images get a ~320 px thumbnail made in the browser. Only the thumbnail loads inline; the full file opens in the viewer dialog on click and is then kept on the device (see [files.md](files.md#previews)). SVG and HTML are never rendered inline.
- Files are deleted 15 days after sending regardless of chat retention (`attachments.expire`, hourly). The message keeps a "文件已过期" card.
- Convex file URLs are bearer links until the file is deleted; the notice says so.

## Group chats

- 部员 propose a group with a name, purpose, involved departments, and suggested members (`groups.propose`). One approval from a 部长 of any involved department, or 主席团 / a system admin, creates it; the approver can rename it and pick the final members (`groups.reviewProposal`). Proposals expire after 14 days.
- 部长 and admins can create a group directly (`groups.create`); a 部长's group must include a department they lead.
- The 部长 of every involved department are members automatically and can't leave while their department is involved. Explicit members can leave.
- **Takeover:** while any involved department is archived or has no 部长, all of 主席团 can read and manage the group. Start and end post system messages and send one `group_takeover` notification per event (`trackLeadership` in `lib/groups.ts`).
- Group info sheet: departments (add, remove), members (add, remove), rename, leave, end. Ending makes the group read-only.

## Chat apps

接龙 (sign-up list), 投票 (vote), and 集会 (weekly meeting finder) run inside org, department, and group chats; at most 5 at a time per chat. Running apps show as chips under the header, up to 3 plus "更多"; a chip opens a side panel. Approvers start apps directly; other participants propose and an approver reviews. Full rules are in [09-roadmap.md, step 2.9](../09-roadmap.md#29-chat-apps-接龙投票集会).

## Shared documents

In department, group and DM chats (not 全体), any participant who can post can start a collaborative document from the document button in the chat header, or the composer's attach menu ("新建协作文档 / New shared document"). It posts a document card in the chat and opens the editor (see [assignments.md](assignments.md#documents)).

- Everyone who can post in the chat can edit it. The author or a chat manager can rename or delete it; moderators can delete it.
- "聊天文档 / Chat documents" under the same header button lists every document of the chat (`documents.listForChat`), including ones whose card has expired with the chat history.
- @mentions suggest the chat's participants. Document cards can't be edited, forwarded or multi-selected.
- Up to 50 documents per chat (`LIMITS.documentsPerChat`).

## Multi-select

- "多选" in the chat menu or a message's menu turns on checkboxes (up to 50 messages) and replaces the composer with an action bar.
- **合并转发:** one `forward` message with a snapshot of the selected messages, sent to up to 5 chats. Forwards nest up to 3 levels and point to the original attachments.
- **在本设备删除:** hides the messages in this browser only (`localStorage` key `cssa-hub:hidden:<userId>`). "恢复在本设备删除的消息" in the chat menu brings them back.
- **复制:** copies name, time, and text of each message.

## Search

`messages.search` searches one channel. `messages.searchText` stores the lowercased body with CJK runs split into overlapping two-character pairs, so a Chinese word inside a sentence is found. Results are re-checked with a substring match; up to 50, newest first.

## Oversight

- Every chat header shows an eye icon; hovering (or tapping) lists who can view it besides its participants, from `channels.watchers`. The `org` chat says it's visible to all members.
- Admins and 部长 pick a person under 监督 (or "查看聊天（监督）" on the roster) to see that person's DMs, groups, and department channels they can only read through oversight (`channels.oversightChannels`).
- Opening such a chat shows a gold read-only banner and calls `channels.recordOversightOpen`, which writes `oversight.channel.open` at most once per 10 minutes per viewer and chat.
- If access ends while the chat is open, `channels.get` returns null and the view says the viewer no longer has access.
- Settings has "谁能查看我的内容" (`users.whoCanSeeMe`).

## Notifications from chat

In-app only in Stage 2 (`/notifications`, with a count on the nav item):
- `mention` (including `@all`) and `reply`;
- `announcement` for every reader of the chat except the author, sent in batches of 200;
- group and chat-app events (`added_to_group`, `group_*`, `app_*`).

Ordinary messages don't notify; unread badges cover them. Notification text is built from `type` and `params` in the viewer's language.

## Convex functions

| Module | Functions |
| --- | --- |
| `channels` | `listMine`, `postable`, `get`, `participants`, `watchers`, `getOrCreateDm`, `markRead`, `unseenAnnouncementList`, `markAnnouncementsSeen`, `setMuted`, `setRetention`, `recordOversightOpen`, `oversightPeople`, `oversightChannels` |
| `messages` | `list`, `around`, `history`, `search`, `send`, `edit`, `recall`, `moderateRemove`, `toggleReaction`, `forward` |
| `attachments` | `generateUploadUrl`, `register`, `discard`; internal `expire` |
| `groups` | `propose`, `cancelProposal`, `reviewProposal`, `listProposals`, `create`, `info`, `addMembers`, `removeMember`, `leave`, `rename`, `addDepartment`, `removeDepartment`, `end`; internal `expireProposals` |
| `apps` | `list`, `get`, `myLastAvailability`, `create`, `review`, `cancelProposal`, `respond`, `withdraw`, `update`, `close`, `reopen`; internal `autoClose`, `dueSoon`, `purge` |
| `notifications` | `listMine`, `unreadCount`, `markRead`, `markAllRead`; internal `fanout`, `cleanup` |

Queries can't write, so oversight audit logging happens in `recordOversightOpen`, which the client calls on open. Every query still checks access on every call.

## Acceptance criteria

See the Stage 2 exit criteria in [09-roadmap.md](../09-roadmap.md#exit-criteria-1).
