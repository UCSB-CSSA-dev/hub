# Feature: Files (文件)

## Summary

A simple Google Drive replacement. There's one shared space for everyone (公共), one private space for 主席团, and one space per department. There are no personal files. Files are stored in Convex file storage, and every space has a storage quota, because the whole organization shares the Convex free plan's 1 GB.

## Spaces

| Space | URL (`/files/?s=`) | Who can view | Who can upload | Who can manage (folders, others' files, trash) |
| --- | --- | --- | --- | --- |
| 公共 Public | `public` | Everyone approved | 主席团 | 主席团 |
| 主席团 Presidium | `presidium` | 主席团 | 主席团 | 主席团 |
| Each department (e.g. 活动部) | its slug, e.g. `events` | Everyone approved | That department's members, and 主席团 | That department's 部长, and 主席团 |

- "主席团" in this doc includes the system admin.
- Anyone who can upload can rename, move or delete **their own** files. Managers can do it to anyone's files in the space, and own its folders and trash.
- An archived department's space is read-only.
- `public` is reserved and can't be used as a department slug.
- The files home page (`/files/`) lists every space the viewer can see, with the ones they can upload to first.
- The 主席团 space is the presidium department's space; it's just the one department space that only its members can see.

## Layout

```text
文件 Files  >  活动部  >  2026 迎新晚会
[Upload] [New folder]                        [Search files...] [List|Grid]
---------------------------------------------------------------------------
Name                     Uploaded by     Modified        Size
[dir]  海报素材             Alice           Oct 12          -
[xlsx] 预算表.xlsx          Bob             Oct 15          48 KB
[png]  场地平面图.png        Carol           Oct 16          2.1 MB
```

- The URL holds the space and folder: `/files/?s=events&f=<folderId>`. A file opens at `/files/?s=events&file=<fileId>`.
- Breadcrumb navigation. List view by default; grid view shows image thumbnails.
- Drag and drop to upload, with a progress bar per file.
- Row menu: Download, Rename, Move, Copy link, Share to chat, Delete. Only actions the viewer may take are shown.
- The header shows the space's usage, for example "活动部 · 已用 42 MB / 75 MB".

## Uploads

- Flow: `files.generateUploadUrl`, then a direct `POST` to Convex storage, then `files.save`. See [01-architecture.md](../01-architecture.md#uploading-a-file).
- Up to **10 MB** per file in Convex storage (`LIMITS.fileBytes`). The server checks using the size from storage metadata (`ctx.db.system.get("_storage", storageId)`), never the client's number. Bigger files go to [Google Drive](#google-drive), up to **500 MB** (`LIMITS.driveFileBytes`).
- Blocked types: executables (`.exe`, `.bat`, `.cmd`, `.sh`, `.app`, `.msi`, `.dmg`, `.apk`), checked by extension and content type, for both storage paths.
- Images get a browser-made thumbnail (the same helper chat attachments use), so list and grid views don't download full images. This keeps egress under the free plan's 1 GB a month.
- Name conflicts in the same folder get " (1)", " (2)", and so on.
- If `files.save` rejects the upload (size, type, quota or permission), it deletes the stored object right away and returns the error instead of throwing, so the delete isn't rolled back.

## Google Drive

Files over 10 MB, and files that don't fit the space's quota, are stored in the dedicated CSSA Google account's Drive instead of Convex, through the same Apps Script as the email digest ([06-email-apps-script.md](../06-email-apps-script.md#google-drive)). For members it's automatic: the upload panel says "存到 Google Drive / Saving to Google Drive" and the file then shows up in the folder like any other.

1. The browser calls `drive.startUpload` (action) with the target, name, size and type. It checks upload rights, the 500 MB cap and blocked types (`drive.prepareUpload`), records a `driveUploads` row, and asks Apps Script for a resumable upload session in `CSSA Hub Files/<space key>`.
2. The browser `PUT`s the file straight to that session URL, with progress. The file never passes through Convex.
3. The browser calls `drive.finishUpload` with the Drive file id. Apps Script checks the file sits under `CSSA Hub Files`, sets it to "anyone with the link can view", and reports its real size and type. `drive.record` re-checks rights and inserts a `files` row with `driveFileId` (no `storageId`). If anything fails, the Drive file is trashed.

Rules:
- A file under 10 MB first goes to Convex; only a `QUOTA_EXCEEDED` result sends it to Drive.
- Drive files don't count toward space quotas or the Convex 1 GB cap. The admin storage card shows their count and total size. The free account has 15 GB shared with Gmail.
- They follow the same folders, permissions, trash and restore as other files. Purging one (by hand or after 30 days in the trash) moves it to the Drive trash (`drive.trashFile`), which Google empties after 30 more days.
- Previews use Drive's viewer in an iframe (`/file/d/<id>/preview`), which handles images, PDFs, video, Office files and more. There is also an "在 Google Drive 中打开 / Open in Google Drive" button.
- Links work for anyone who has them. The Hub only shows them to people who can see the space, but a link someone copies keeps working after they leave. Don't put sensitive files over 10 MB in the 主席团 space.
- Unfinished uploads (`driveUploads` rows) are forgotten after a day by an hourly cron. A file whose upload finished but was never recorded stays in the Drive folder until someone deletes it there.
- Without `APPS_SCRIPT_URL` / `APPS_SCRIPT_SHARED_SECRET`, files that need Drive fail with `DRIVE_NOT_CONFIGURED`.

## Storage quotas

The Convex free plan has a hard cap of 1 GB of stored files, shared by Files, task files and chat attachments (15 MB max each, deleted after 15 days).

- Every space has a quota. It defaults to **75 MB** (`DEFAULT_SPACE_QUOTA_BYTES`).
- Each space has a `fileSpaces` row holding `quotaBytes` and `usedBytes`. `usedBytes` goes up when a file is saved and down when a file is purged from the trash. Trashed files still count, because they still take up storage.
- An upload that would go over the quota fails with `QUOTA_EXCEEDED`, and the message says how much space is left.
- **Admin console (主席团 only):** a storage card shows total storage used against 1 GB, split into each space (task files count toward their space) and chat attachments, with each space's quota editable. It warns when storage used, or the quotas added up, pass about 800 MB, so chat attachments always have room.
- A space at 90% of its quota shows a warning in its header.

## Previews

Stored files (Files, chat attachments, task and submission files) open in a viewer dialog with a close button, never on a Convex page in a new tab (`components/files/file-viewer.tsx`):

- Images: full size, fitted to the dialog.
- PDF: rendered with pdf.js (`pdfjs-dist`), fitted to the width, pages drawn as they scroll into view, with pdf.js's text layer on top so text can be selected and copied where it appears.
- Video and audio: native players. Plain text and JSON: shown as text (first 1 MB).
- Everything else: an icon and a Download button.
- Drive files keep Drive's own viewer in an iframe.

### Kept on this device

To save Convex bandwidth, a file's bytes are fetched once and kept in the browser's IndexedDB (`cssa-hub-files`, `lib/file-cache.ts`), keyed by the storage URL (stable per stored blob). `localStorage` holds only a few MB of text, so it can't hold files. Opening or downloading the file again reads it from the device.

- Only Convex storage files, up to 100 MB each; Drive files and larger ones stream each time.
- Nothing expires on its own. The app asks the browser for persistent storage so it isn't evicted under pressure (the browser may decline).
- Settings → "本设备上的文件 / Files on this device" lists every kept file with its size and date, deletes one, deletes files kept longer than 30, 90, 180 or 360 days, or deletes everything.
- Signing out clears it, so the next person on a shared device can't open them.

## Documents

"新建文档 / New document" (for anyone who can upload in the folder) creates a collaborative markdown document there, edited in the same live editor as task documents (see [assignments.md](assignments.md#documents)), at `/docs/?d=<id>`.

- It is a `files` row with `documentId` (type `text/markdown`, size 0), so it shows in the folder, search, move, trash and restore like any file, and doesn't use quota. Opening it goes to the editor instead of the preview; there is no download (export from the editor instead).
- Anyone who can upload in the space (or the author, inside a task folder) can edit it. Renaming and deleting follow the file rules: the author or a manager. Deleting moves it to the trash; purging deletes the content.
- @mentions suggest everyone who can see the space (主席团 members for 主席团).
- Dictation and 小飒 work as in task documents ([ai-assistant.md](ai-assistant.md#document-summaries)). Tasks found in a Files document's summary are created as drafts in a chat the member picks. Files documents outside the 主席团 space can be attached to 小飒 questions in any chat; 主席团 documents only in the member's private 小飒 chat.

## Folder operations

- Create, rename, move (within the same space only), delete.
- Delete is soft (`deletedAt`). Deleting a folder soft-deletes its contents.
- 回收站 / Trash (managers only) lists soft-deleted items for 30 days with Restore. A daily cron permanently deletes older items: the row, and the stored object if nothing else references it.

## Chat and Files

Both directions are supported:

- **Share a file to a chat:** the composer's attach menu has "从文件中选择 / From Files". It posts a message with a link card (name, size, space, uploader). Use this for anything that should outlive the chat's 15-day attachments.
  - The card links to the file in Files, which checks permission when opened. Only a 主席团 file shared outside 主席团 would show "你没有权限查看 / No access".
  - If the file is later deleted, the card shows "文件已删除 / File deleted".
  - "Share to chat" in the file's row menu opens a chat picker and does the same.
- **Save a chat attachment to Files:** "保存到文件 / Save to Files" on an attachment copies it into a folder the viewer can upload to. The new `files` row reuses the same `storageId`, so it costs nothing extra until the attachment expires. It counts against the space's quota. The attachment cleanup cron must not delete a stored object that a `files` row still uses.
- Quick chat attachments stay as they are: private to the chat and deleted after 15 days.

## Task files

Task attachments and submitted files live in the task's file space (see [assignments.md](assignments.md#files)).

- They go in an automatic folder `任务 Tasks / <task title>`. That folder is linked to the task (`folders.assignmentId`), so everyone who can view the space can see them.
- Assignees can upload into their task's folder even if they can't otherwise upload to that space.
- Managers can tidy or delete these files like any others; the task then shows "文件已删除 / File deleted".

## Search

Search file names (case-insensitive substring) across the spaces the viewer can see. Each space holds at most a few hundred files under its quota, so a scan of the visible spaces is fast enough and matches partial Chinese names, which a search index would not.

## Convex functions

| Function | Type | Notes |
| --- | --- | --- |
| `files.listSpaces` | query | Spaces the viewer can see, with usage and the viewer's rights in each |
| `files.listFolder` | query | Folders and files in a folder (or the space root), with breadcrumb and thumbnail URLs |
| `files.get` | query | One file with its download URL, after the access check |
| `files.search` | query | |
| `files.listTrash` | query | Managers only |
| `files.createFolder`, `renameFolder`, `moveFolder`, `removeFolder`, `restoreFolder` | mutation | |
| `files.generateUploadUrl` | mutation | Requires upload rights in the target space, or being an assignee of the target task |
| `files.save` | mutation | Checks size, type and quota. On failure it deletes the stored object and returns `{ ok: false, code }` instead of throwing, because a throw would roll back the delete |
| `files.rename`, `move`, `remove`, `restore` | mutation | Own files, or manager |
| `files.saveAttachment` | mutation | Save to Files from a chat attachment |
| `drive.startUpload`, `drive.finishUpload` | action | [Google Drive](#google-drive) uploads |
| `internal.drive.trashFile`, `internal.drive.cleanupUploads` | internal action, mutation | Drive trash on purge; hourly cleanup of unfinished uploads |
| `files.setQuota` | mutation | 主席团 only |
| `files.folderTree` | query | Folders of a space, for the move and save pickers |
| `files.purge` | mutation | Managers: delete a trashed file or folder for good |
| `documents.createInFolder` | mutation | New document in a folder (see [Documents](#documents)) |
| `internal.files.purgeTrash` | internal mutation | Daily cron: deletes trash older than 30 days |

## Acceptance criteria

- [ ] Everyone can view 公共 and every department space. Only 主席团 can see the 主席团 space.
- [ ] A 部员 can upload to their own department's space, and rename or delete only their own files there.
- [ ] A 部长 can create folders, delete anyone's files and restore from the trash in their department's space, but not in other departments' spaces.
- [ ] Blocked types are rejected on the server, and the stored object is deleted.
- [ ] A 50 MB video, and a small file uploaded to a full space, both end up in Google Drive and open from the folder; purging them moves them to the Drive trash.
- [ ] 主席团 can change a space's quota, and the admin storage card adds up correctly.
- [ ] A file shared to a chat shows a card that opens it in Files; once the file is deleted, the card says so.
- [ ] A chat attachment saved to Files is still there after the attachment expires.
- [ ] Deleted items can be restored within 30 days and are purged afterwards.
