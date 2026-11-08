// Shared with the frontend (imported via @cssa-hub/backend). Keep free of server-only imports.

/** v2 (Stage 2): retention, recall, the monitored icon, and public profiles. */
export const CURRENT_CONSENT_VERSION = 2;

export const DEFAULT_ALLOWED_EMAIL_DOMAIN = "ucsb.edu";

export const LIMITS = {
  messageBody: 4000,
  nameLength: 60,
  applicationNote: 500,
  rejectionReason: 500,
  preApprovalNote: 200,
  preApprovalBatch: 100,
  departmentName: 40,
  messagesPageSize: 50,
  unreadCountCap: 99,
  /** Unacknowledged announcements loaded for the bar at the top of a chat. */
  announcementBar: 20,
  leadsPerDepartment: 2,
  bio: 160,
  /** Avatars are resized to 256px in the browser; this only guards against bypassing that. */
  avatarBytes: 1024 * 1024,
  deactivationReason: 500,

  // Chat (Stage 2)
  recallWindowMs: 5 * 60 * 1000,
  defaultRetentionDays: 15,
  attachmentBytes: 15 * 1024 * 1024,
  attachmentsPerMessage: 10,
  attachmentRetentionDays: 15,
  unsentUploadHours: 24,
  thumbnailBytes: 200 * 1024,
  attachmentName: 200,
  groupName: 40,
  groupPurpose: 200,
  groupMembers: 100,
  groupProposalDays: 14,
  reviewNote: 500,
  forwardMessages: 50,
  forwardTargets: 5,
  forwardBytes: 200_000,
  forwardDepth: 3,
  searchResults: 50,
  searchTerms: 16,
  aroundMessages: 25,
  notificationRetentionDays: 90,
  oversightLogWindowMs: 10 * 60 * 1000,
  purgeBatch: 500,
  fanoutBatch: 200,

  // Chat apps (Stage 2)
  appsPerChannel: 5,
  appTitle: 80,
  appDescription: 500,
  signupEntry: 200,
  signupExample: 100,
  signupCap: 500,
  pollOptionsMin: 2,
  pollOptionsMax: 20,
  pollOption: 80,
  pollOther: 100,
  meetingSlotMinutes: 30,
  appDueSoonMs: 24 * 60 * 60 * 1000,
  bestTimes: 5,

  // Files (Stage 3)
  /** Larger files go to Google Drive instead of Convex storage. */
  fileBytes: 10 * 1024 * 1024,
  driveFileBytes: 500 * 1024 * 1024,
  /** Unfinished Drive uploads are forgotten after this. */
  driveUploadMs: 24 * 60 * 60 * 1000,
  defaultSpaceQuotaBytes: 75 * 1024 * 1024,
  maxSpaceQuotaBytes: 1024 * 1024 * 1024,
  /** The Convex free plan's file storage cap, shared by everything. */
  storageCapBytes: 1024 * 1024 * 1024,
  /** Warn when space quotas add up to more than this, so chat attachments keep room. */
  quotaWarnBytes: 800 * 1024 * 1024,
  fileName: 200,
  folderName: 60,
  trashDays: 30,
  sharedFilesPerMessage: 10,
  fileSearchResults: 50,

  // Tasks and events (Stage 3)
  taskTitle: 120,
  taskDescription: 5000,
  taskLocation: 120,
  taskFiles: 20,
  taskAssignees: 300,
  submissionText: 5000,
  submissionLink: 1000,
  taskComment: 2000,
  taskDueSoonMs: 24 * 60 * 60 * 1000,
  taskListLimit: 200,
  documentTitle: 120,
  documentsPerTask: 20,
  documentsPerChat: 50,
  /** Mention notifications sent per document save, so a pasted roster can't spam everyone. */
  documentMentionsPerSave: 20,

  // Daily digest (Stage 3)
  digestHour: 10,
  digestEventDays: 7,
  digestItems: 30,
  /** Chats with unread messages listed in the digest, and the newest messages shown per chat. */
  digestChats: 20,
  digestChatMessages: 5,
  digestMessageChars: 200,
  digestEmail: 254,
  emailAttempts: 5,
} as const;

/** Times are entered and shown in Pacific time (UCSB). */
export const TIME_ZONE = "America/Los_Angeles";

/** `/files/?s=public` is the shared space; department slugs can't use it. */
export const PUBLIC_SPACE = "public";

/** Content type of documents created in Files (they live in the database, not in storage). */
export const DOC_CONTENT_TYPE = "text/markdown";

/** Executables can't be uploaded to Files. */
export const BLOCKED_EXTENSIONS = ["exe", "bat", "cmd", "sh", "app", "msi", "dmg", "apk", "com", "scr"] as const;

/** Allowed values for channels.retentionDays. */
export const RETENTION_OPTIONS = [15, 30, 90, 180, 365] as const;

export const REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "🙏", "✅", "🔥"] as const;

export const NOTIFICATION_TYPES = [
  "mention",
  "reply",
  "announcement",
  "added_to_group",
  "added_to_department",
  "deactivation_reviewed",
  "group_proposed",
  "group_approved",
  "group_rejected",
  "group_expired",
  "group_takeover",
  "app_proposed",
  "app_approved",
  "app_rejected",
  "app_due_soon",
  "assignment_new",
  "assignment_updated",
  "assignment_due_soon",
  "assignment_overdue",
  "event_soon",
  "submission_received",
  "submission_reviewed",
  "assignment_comment",
  "doc_mention",
  "task_mention",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "NOT_APPROVED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID",
  "ALREADY_REVIEWED",
  "LAST_SYSTEM_ADMIN",
  "DOMAIN_NOT_ALLOWED",
  /** 主席团 already has a 主席; use presidium.transferChair. */
  "CHAIR_EXISTS",
  /** The action would leave 主席团 without its 主席; transfer the role first. */
  "CHAIR_REQUIRED",
  "TOO_MANY_LEADS",
  /** The 5-minute recall window has passed. */
  "RECALL_EXPIRED",
  "FILE_TOO_LARGE",
  "TOO_MANY_APPS",
  /** A 接龙 reached its cap. */
  "SIGNUP_FULL",
  /** The chat is read-only (ended group, archived department, deactivated DM partner). */
  "READ_ONLY",
  /** The upload would go over the file space's quota. */
  "QUOTA_EXCEEDED",
  /** Executables can't be uploaded. */
  "FILE_TYPE_BLOCKED",
  /** The file needs Google Drive, but APPS_SCRIPT_URL / APPS_SCRIPT_SHARED_SECRET aren't set. */
  "DRIVE_NOT_CONFIGURED",
  /** Google Drive refused the upload (full, or the Apps Script failed). */
  "DRIVE_FAILED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const SEED_DEPARTMENTS = [
  { slug: "presidium", nameZh: "主席团", nameEn: "Presidium", kind: "presidium" },
  { slug: "events", nameZh: "活动部", nameEn: "Events", kind: "regular" },
  { slug: "international", nameZh: "国际部", nameEn: "International", kind: "regular" },
  { slug: "publicity", nameZh: "宣传部", nameEn: "Publicity", kind: "regular" },
] as const;
