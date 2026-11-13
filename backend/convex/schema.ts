import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { NOTIFICATION_TYPES } from "./lib/constants";

// Stage 1 to 3 tables. See doc/03-data-model.md for the full target schema.

export const userStatus = v.union(
  v.literal("new"),
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("deactivated"),
);

export const membershipRole = v.union(v.literal("lead"), v.literal("member"));

export const locale = v.union(v.literal("zh"), v.literal("en"));

export const channelType = v.union(
  v.literal("org"),
  /** Legacy: no longer created; maintenance.mergeAnnouncementChannels folds them into org and department chats. */
  v.literal("announcement"),
  v.literal("department"),
  v.literal("group"),
  v.literal("dm"),
  /** One per user: their private chat with 小飒. */
  v.literal("assistant"),
);

export const aiMessageStatus = v.union(
  v.literal("thinking"),
  v.literal("streaming"),
  v.literal("done"),
  v.literal("refused"),
  v.literal("failed"),
);

export const aiSuggestionAction = v.union(v.literal("create_task"), v.literal("create_event"), v.literal("edit"));

export const notificationType = v.union(
  ...NOTIFICATION_TYPES.map((type) => v.literal(type)),
);

export default defineSchema({
  ...authTables,

  users: defineTable({
    // Managed by Convex Auth
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),

    // App fields
    isSystemAdmin: v.optional(v.boolean()),
    status: v.optional(userStatus),
    nameZh: v.optional(v.string()),
    nameEn: v.optional(v.string()),
    // Public profile. avatarUrl overrides the Google `image`, which Convex Auth rewrites on each sign-in.
    bio: v.optional(v.string()),
    avatarStorageId: v.optional(v.id("_storage")),
    avatarUrl: v.optional(v.string()),
    requestedDepartmentIds: v.optional(v.array(v.id("departments"))),
    applicationNote: v.optional(v.string()),
    oversightConsentAt: v.optional(v.number()),
    oversightConsentVersion: v.optional(v.number()),
    reviewedBy: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    rejectionReason: v.optional(v.string()),
    locale: v.optional(locale),
    /** Daily digest address; unset sends to the sign-in email. */
    digestEmail: v.optional(v.string()),
    /** Language of the daily summary; defaults to the app language. */
    digestLocale: v.optional(locale),
    /** Show the sign-in email on the public about-us page (hidden by default). */
    showEmailPublicly: v.optional(v.boolean()),
    /** The 小飒 assistant. Has no status, so it never shows up in roster or audience queries. */
    isBot: v.optional(v.boolean()),
  })
    .index("email", ["email"])
    .index("by_status", ["status"])
    .index("by_isSystemAdmin", ["isSystemAdmin"])
    .index("by_isBot", ["isBot"]),

  preApprovals: defineTable({
    email: v.string(),
    departmentId: v.id("departments"),
    role: membershipRole,
    note: v.optional(v.string()),
    createdBy: v.id("users"),
    claimedAt: v.optional(v.number()),
    claimedBy: v.optional(v.id("users")),
    revokedAt: v.optional(v.number()),
    revokedBy: v.optional(v.id("users")),
  })
    .index("by_email", ["email"])
    .index("by_department", ["departmentId"])
    .index("by_email_department", ["email", "departmentId"]),

  departments: defineTable({
    slug: v.string(),
    nameZh: v.string(),
    nameEn: v.string(),
    kind: v.union(v.literal("presidium"), v.literal("regular")),
    sortOrder: v.number(),
    archivedAt: v.optional(v.number()),
  })
    .index("by_slug", ["slug"])
    .index("by_kind", ["kind"]),

  departmentMemberships: defineTable({
    userId: v.id("users"),
    departmentId: v.id("departments"),
    // In the presidium department, "lead" is 主席 (exactly one) and "member" is 副主席.
    role: membershipRole,
    addedBy: v.optional(v.id("users")),
    // Presidium only: set when a 主席 hands the role over, so retiring later records 前主席.
    wasChair: v.optional(v.boolean()),
  })
    .index("by_user", ["userId"])
    .index("by_department", ["departmentId"])
    .index("by_user_department", ["userId", "departmentId"]),

  // Retired presidium members (前主席 / 前副主席). role "lead" = 前主席.
  formerPresidium: defineTable({
    userId: v.id("users"),
    role: membershipRole,
    retiredAt: v.number(),
  }).index("by_user", ["userId"]),

  // A member asking to deactivate their own account; 主席团 reviews it.
  deactivationRequests: defineTable({
    userId: v.id("users"),
    reason: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("declined"),
      v.literal("cancelled"),
    ),
    reviewedBy: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    reviewNote: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_status", ["status"]),

  channels: defineTable({
    type: channelType,
    /** Group chats only; other types derive their name. */
    name: v.optional(v.string()),
    /** department channels (and legacy department announcement channels). */
    departmentId: v.optional(v.id("departments")),
    dmKey: v.optional(v.string()),
    createdBy: v.optional(v.id("users")),
    lastMessageAt: v.optional(v.number()),
    /** Messages older than this are purged. Unset means LIMITS.defaultRetentionDays. */
    retentionDays: v.optional(v.number()),
    // Group chats
    purpose: v.optional(v.string()),
    proposalId: v.optional(v.id("groupProposals")),
    endedAt: v.optional(v.number()),
    /** AI mode (org, department, group): messages sent while it's on can be read by 小飒. */
    aiEnabled: v.optional(v.boolean()),
    aiEnabledAt: v.optional(v.number()),
    aiEnabledBy: v.optional(v.id("users")),
    /** Rate limit for automatic task suggestions: start of the current hour window and model calls in it. */
    aiScanWindowStart: v.optional(v.number()),
    aiScanCount: v.optional(v.number()),
  })
    .index("by_type", ["type"])
    .index("by_department", ["departmentId"])
    .index("by_dmKey", ["dmKey"])
    .index("by_aiEnabled", ["aiEnabled"]),

  /** Departments involved in a group chat. Their 部长 are members automatically. */
  groupDepartments: defineTable({
    channelId: v.id("channels"),
    departmentId: v.id("departments"),
  })
    .index("by_channel", ["channelId"])
    .index("by_department", ["departmentId"]),

  groupProposals: defineTable({
    proposerId: v.id("users"),
    name: v.string(),
    purpose: v.string(),
    departmentIds: v.array(v.id("departments")),
    suggestedUserIds: v.array(v.id("users")),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("cancelled"),
      v.literal("expired"),
    ),
    reviewedBy: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    reviewNote: v.optional(v.string()),
    channelId: v.optional(v.id("channels")),
    expiresAt: v.number(),
  })
    .index("by_proposer", ["proposerId"])
    .index("by_status", ["status"]),

  // Read state for every channel a user has opened, plus explicit membership for DMs and groups.
  // Access to org and department channels is derived from departmentMemberships.
  channelMembers: defineTable({
    channelId: v.id("channels"),
    userId: v.id("users"),
    lastReadAt: v.number(),
    /** Announcements stay highlighted until acknowledged, independently of lastReadAt. */
    announcementsReadAt: v.optional(v.number()),
    muted: v.optional(v.boolean()),
    /** Set for explicit DM and group members; read-state-only rows leave it unset. */
    joinedAt: v.optional(v.number()),
    addedBy: v.optional(v.id("users")),
  })
    .index("by_channel", ["channelId"])
    .index("by_user", ["userId"])
    .index("by_channel_user", ["channelId", "userId"]),

  messages: defineTable({
    channelId: v.id("channels"),
    authorId: v.id("users"),
    body: v.string(),
    kind: v.optional(
      v.union(
        v.literal("user"),
        v.literal("system"),
        v.literal("forward"),
        v.literal("task"),
        v.literal("doc"),
        v.literal("ai"),
      ),
    ),
    /** Sent while AI mode was on (or in a private 小飒 chat); only these are ever given to the model. */
    aiReadable: v.optional(v.boolean()),
    /** kind "ai": 小飒's answer, refusal, notice, or task suggestion card. */
    ai: v.optional(
      v.object({
        status: aiMessageStatus,
        requestId: v.optional(v.id("aiRequests")),
        suggestionId: v.optional(v.id("aiSuggestions")),
        /** A fixed notice rendered from translations, e.g. "appeal_denied"; the body then holds the admin's note. */
        notice: v.optional(v.string()),
        /** Who had 小飒 post this (announcements sent from a document summary). */
        actorId: v.optional(v.id("users")),
      }),
    ),
    /** Documents attached to a question for 小飒 (at most three, each readable by everyone in the chat). */
    aiDocumentIds: v.optional(v.array(v.id("documents"))),
    mentionUserIds: v.optional(v.array(v.id("users"))),
    mentionAll: v.optional(v.boolean()),
    replyToId: v.optional(v.id("messages")),
    /** Posted as an announcement (org chat: admins; department chat: its 部长 and admins). */
    announcement: v.optional(v.boolean()),
    editedAt: v.optional(v.number()),
    recalledAt: v.optional(v.number()),
    removedAt: v.optional(v.number()),
    removedBy: v.optional(v.id("users")),
    /** Lowercased body with CJK split into bigrams, for the search index. */
    searchText: v.optional(v.string()),
    /** kind "system": event name and params, translated on the client. */
    system: v.optional(v.object({ event: v.string(), params: v.any() })),
    /** kind "forward": snapshot of the forwarded messages. */
    forward: v.optional(v.any()),
    /** kind "task": the task or event this card shows. */
    assignmentId: v.optional(v.id("assignments")),
    /** kind "doc": the chat document this card opens. */
    documentId: v.optional(v.id("documents")),
    /** Files shared from Files, shown as link cards. */
    fileIds: v.optional(v.array(v.id("files"))),
  })
    .index("by_channel", ["channelId"])
    .index("by_channel_announcement", ["channelId", "announcement"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["channelId"] }),

  /** Earlier versions of edited messages. */
  messageEdits: defineTable({
    messageId: v.id("messages"),
    body: v.string(),
  }).index("by_message", ["messageId"]),

  messageReactions: defineTable({
    messageId: v.id("messages"),
    userId: v.id("users"),
    emoji: v.string(),
  })
    .index("by_message", ["messageId"])
    .index("by_message_user_emoji", ["messageId", "userId", "emoji"]),

  /** Uploaded chat files. Unsent uploads expire after a day, sent ones 15 days after sending. */
  attachments: defineTable({
    storageId: v.id("_storage"),
    thumbStorageId: v.optional(v.id("_storage")),
    name: v.string(),
    size: v.number(),
    contentType: v.string(),
    uploaderId: v.id("users"),
    messageId: v.optional(v.id("messages")),
    expiresAt: v.number(),
    /** Set once the stored files are deleted. */
    expiredAt: v.optional(v.number()),
  })
    .index("by_message", ["messageId"])
    .index("by_expiry", ["expiredAt", "expiresAt"])
    .index("by_storage", ["storageId"]),

  /** One per file space: departmentId unset is 公共; the presidium department is 主席团. */
  fileSpaces: defineTable({
    departmentId: v.optional(v.id("departments")),
    quotaBytes: v.number(),
    /** Includes trashed files until they're purged. */
    usedBytes: v.number(),
  }).index("by_department", ["departmentId"]),

  folders: defineTable({
    name: v.string(),
    /** The space; unset is 公共. */
    departmentId: v.optional(v.id("departments")),
    /** Unset is the top level of the space. */
    parentId: v.optional(v.id("folders")),
    /** The automatic "任务 Tasks / <title>" folder of a task. */
    assignmentId: v.optional(v.id("assignments")),
    /** The automatic "任务 Tasks" parent folder of a space's task folders. */
    tasksRoot: v.optional(v.boolean()),
    createdBy: v.id("users"),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.id("users")),
  })
    .index("by_space_parent", ["departmentId", "parentId"])
    .index("by_assignment", ["assignmentId"])
    .index("by_deletedAt", ["deletedAt"]),

  files: defineTable({
    /** May be shared with a chat attachment (Save to Files). Unset for files kept in Google Drive. */
    storageId: v.optional(v.id("_storage")),
    /** Files over 10 MB, or uploaded when the space was full, live in the CSSA Google Drive. */
    driveFileId: v.optional(v.string()),
    /** A collaborative document created in Files; its content lives in the prosemirrorSync component. */
    documentId: v.optional(v.id("documents")),
    thumbStorageId: v.optional(v.id("_storage")),
    name: v.string(),
    contentType: v.string(),
    size: v.number(),
    /** The space, copied from the folder; files never move between spaces. */
    departmentId: v.optional(v.id("departments")),
    folderId: v.optional(v.id("folders")),
    uploadedBy: v.id("users"),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.id("users")),
  })
    .index("by_space_folder", ["departmentId", "folderId"])
    .index("by_storage", ["storageId"])
    .index("by_deletedAt", ["deletedAt"]),

  /** A Google Drive upload between `drive.startUpload` and `drive.finishUpload`. */
  driveUploads: defineTable({
    userId: v.id("users"),
    space: v.optional(v.string()),
    folderId: v.optional(v.id("folders")),
    assignmentId: v.optional(v.id("assignments")),
    name: v.string(),
    size: v.number(),
    contentType: v.string(),
    /** Drive folder (under "CSSA Hub Files") the file goes in: the space key. */
    driveFolder: v.string(),
  }),

  /**
   * Collaborative markdown documents; content lives in the prosemirrorSync component.
   * Exactly one parent: a task or event, a chat, or a file in Files (whose name is the title).
   */
  documents: defineTable({
    assignmentId: v.optional(v.id("assignments")),
    channelId: v.optional(v.id("channels")),
    fileId: v.optional(v.id("files")),
    title: v.string(),
    createdBy: v.id("users"),
    updatedAt: v.number(),
    updatedBy: v.id("users"),
    /** People mentioned in the last saved version, so only new mentions notify. */
    mentionedIds: v.optional(v.array(v.id("users"))),
    /** Plain-text copy of the last saved version (capped), for 小飒. */
    text: v.optional(v.string()),
  })
    .index("by_assignment", ["assignmentId"])
    .index("by_channel", ["channelId"])
    .index("by_updatedAt", ["updatedAt"]),

  /** Tasks and events (UI: 任务 / 活动). */
  assignments: defineTable({
    kind: v.union(v.literal("task"), v.literal("event")),
    title: v.string(),
    description: v.optional(v.string()),
    createdBy: v.id("users"),
    /** 全体, a department chat or a group chat; decides who can create and who can be assigned. */
    channelId: v.id("channels"),
    /** File space for the task's files; unset is 公共. */
    departmentId: v.optional(v.id("departments")),
    /** A prep task of this event. */
    eventId: v.optional(v.id("assignments")),
    status: v.union(v.literal("draft"), v.literal("open"), v.literal("closed")),
    dueAt: v.optional(v.number()),
    startAt: v.optional(v.number()),
    endAt: v.optional(v.number()),
    location: v.optional(v.string()),
    requiresSubmission: v.boolean(),
    autoApprove: v.optional(v.boolean()),
    fileIds: v.array(v.id("files")),
    /** Drafts: who will be assigned on publish. */
    draftAssigneeIds: v.optional(v.array(v.id("users"))),
    /** Drafts: assign everyone in the chat on publish. */
    draftEveryone: v.optional(v.boolean()),
    messageId: v.optional(v.id("messages")),
    publishedAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),
  })
    .index("by_creator", ["createdBy"])
    .index("by_channel", ["channelId"])
    .index("by_event", ["eventId"])
    .index("by_status_due", ["status", "dueAt"])
    .index("by_status_start", ["status", "startAt"]),

  /** One per assignee (or event helper), created on publish. */
  assignmentSubmissions: defineTable({
    assignmentId: v.id("assignments"),
    assigneeId: v.id("users"),
    status: v.union(
      v.literal("assigned"),
      v.literal("submitted"),
      v.literal("changes_requested"),
      v.literal("approved"),
    ),
    text: v.optional(v.string()),
    fileIds: v.array(v.id("files")),
    link: v.optional(v.string()),
    submittedAt: v.optional(v.number()),
    late: v.optional(v.boolean()),
    reviewedBy: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    /** Due soon (tasks) or event soon (events). */
    dueSoonReminderSentAt: v.optional(v.number()),
    overdueReminderSentAt: v.optional(v.number()),
  })
    .index("by_assignment", ["assignmentId"])
    .index("by_assignee", ["assigneeId"])
    .index("by_assignment_assignee", ["assignmentId", "assigneeId"]),

  assignmentComments: defineTable({
    submissionId: v.id("assignmentSubmissions"),
    authorId: v.id("users"),
    body: v.string(),
  }).index("by_submission", ["submissionId"]),

  /** Outbox for the daily digest; see doc/features/notifications-and-email.md. */
  emailJobs: defineTable({
    to: v.string(),
    userId: v.optional(v.id("users")),
    template: v.string(),
    locale,
    params: v.any(),
    status: v.union(
      v.literal("queued"),
      v.literal("sending"),
      v.literal("sent"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    sendAfter: v.number(),
    sentAt: v.optional(v.number()),
    dedupeKey: v.optional(v.string()),
    /** Pacific date the job belongs to (YYYY-MM-DD); older failed jobs are skipped, not retried. */
    day: v.string(),
  })
    .index("by_status_sendAfter", ["status", "sendAfter"])
    .index("by_dedupeKey", ["dedupeKey"])
    .index("by_day", ["day"]),

  notifications: defineTable({
    userId: v.id("users"),
    type: notificationType,
    params: v.any(),
    /** In-app path, e.g. "/chat/?c=<id>&m=<id>". */
    link: v.optional(v.string()),
    readAt: v.optional(v.number()),
    messageId: v.optional(v.id("messages")),
  })
    .index("by_user", ["userId"])
    .index("by_user_read", ["userId", "readAt"])
    .index("by_readAt", ["readAt"])
    .index("by_message", ["messageId"]),

  /** Web Push subscriptions, one per browser or installed home-screen app. */
  pushSubscriptions: defineTable({
    userId: v.id("users"),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
  })
    .index("by_user", ["userId"])
    .index("by_endpoint", ["endpoint"]),

  // 接龙 (signup), 投票 (poll), 集会 (meeting) inside a chat.
  chatApps: defineTable({
    channelId: v.id("channels"),
    kind: v.union(v.literal("signup"), v.literal("poll"), v.literal("meeting")),
    status: v.union(
      v.literal("proposed"),
      v.literal("active"),
      v.literal("closed"),
      v.literal("rejected"),
      v.literal("cancelled"),
    ),
    title: v.string(),
    description: v.optional(v.string()),
    config: v.any(),
    createdBy: v.id("users"),
    approvedBy: v.optional(v.id("users")),
    rejectReason: v.optional(v.string()),
    deadline: v.optional(v.number()),
    closedAt: v.optional(v.number()),
    /** 集会: the chosen start slot index. */
    confirmedSlot: v.optional(v.number()),
  }).index("by_channel_status", ["channelId", "status"]),

  chatAppResponses: defineTable({
    appId: v.id("chatApps"),
    userId: v.id("users"),
    data: v.any(),
  })
    .index("by_app", ["appId"])
    .index("by_app_user", ["appId", "userId"])
    .index("by_user", ["userId"]),

  /**
   * One request to 小飒. `cost` is what it took from the asker's balance in `weekKey`.
   * Chat questions have a channel and question message; document requests have `documentId`.
   */
  aiRequests: defineTable({
    userId: v.id("users"),
    channelId: v.optional(v.id("channels")),
    questionMessageId: v.optional(v.id("messages")),
    replyMessageId: v.optional(v.id("messages")),
    documentId: v.optional(v.id("documents")),
    source: v.union(
      v.literal("mention"),
      v.literal("private"),
      v.literal("appeal"),
      v.literal("doc_summary"),
      v.literal("doc_write"),
    ),
    status: v.union(v.literal("pending"), v.literal("done"), v.literal("refused"), v.literal("failed")),
    cost: v.number(),
    /** Pacific date of the Sunday the credit week started on (YYYY-MM-DD). */
    weekKey: v.string(),
    /** Appeal re-answers skip the relevance filter. */
    skipFilter: v.optional(v.boolean()),
    model: v.optional(v.string()),
    error: v.optional(v.string()),
  })
    .index("by_user_week", ["userId", "weekKey"])
    .index("by_user_status", ["userId", "status"])
    .index("by_week", ["weekKey"]),

  /** Credits given back (approved appeals); counted in the week they were granted. */
  aiCreditAdjustments: defineTable({
    userId: v.id("users"),
    weekKey: v.string(),
    delta: v.number(),
    reason: v.string(),
    requestId: v.optional(v.id("aiRequests")),
  }).index("by_user_week", ["userId", "weekKey"]),

  /** A member disputing an "irrelevant" refusal; system admins decide. */
  aiAppeals: defineTable({
    requestId: v.id("aiRequests"),
    userId: v.id("users"),
    /** The chat for questions; the document for writing prompts. */
    channelId: v.optional(v.id("channels")),
    documentId: v.optional(v.id("documents")),
    /** Snapshots, so the review still works after the chat's retention deletes the messages. */
    question: v.string(),
    reason: v.string(),
    note: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("denied")),
    reviewedBy: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    reviewNote: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_request", ["requestId"]),

  /**
   * Rules system admins teach the relevance filter, usually while reviewing an appeal. Every rule is
   * sent with every filter call, so it applies to the next request as soon as it's saved.
   */
  aiFilterMemory: defineTable({
    verdict: v.union(v.literal("allow"), v.literal("refuse")),
    text: v.string(),
    /** The appeal it was learned from, if any. */
    appealId: v.optional(v.id("aiAppeals")),
    createdBy: v.id("users"),
    updatedAt: v.number(),
    updatedBy: v.id("users"),
  }).index("by_updatedAt", ["updatedAt"]),

  /** A task or event 小飒 spotted in an AI chat; a person opens it in the task form to create or edit. */
  aiSuggestions: defineTable({
    channelId: v.id("channels"),
    /** The chat message it came from, or the document whose summary proposed it. */
    sourceMessageId: v.optional(v.id("messages")),
    documentId: v.optional(v.id("documents")),
    messageId: v.optional(v.id("messages")),
    action: aiSuggestionAction,
    assignmentId: v.optional(v.id("assignments")),
    fields: v.object({
      title: v.optional(v.string()),
      description: v.optional(v.string()),
      assigneeIds: v.optional(v.array(v.id("users"))),
      dueAt: v.optional(v.number()),
      startAt: v.optional(v.number()),
      endAt: v.optional(v.number()),
      location: v.optional(v.string()),
    }),
    status: v.union(v.literal("pending"), v.literal("applied"), v.literal("dismissed")),
    actedBy: v.optional(v.id("users")),
  })
    .index("by_channel", ["channelId"])
    .index("by_source", ["sourceMessageId"])
    .index("by_document", ["documentId"]),

  /**
   * 小飒's summary of a document, shared with everyone who can read it and shown under it.
   * One row per document; regenerating keeps the old content visible until the new one lands.
   */
  aiDocSummaries: defineTable({
    documentId: v.id("documents"),
    requestedBy: v.id("users"),
    /** The request being generated right now, if any. */
    pendingRequestId: v.optional(v.id("aiRequests")),
    /** Set once a summary has been generated. */
    generatedAt: v.optional(v.number()),
    /** `documents.updatedAt` the summary was made from; newer edits mark it outdated. */
    docUpdatedAt: v.optional(v.number()),
    summary: v.string(),
    tasks: v.array(
      v.object({
        kind: v.union(v.literal("task"), v.literal("event")),
        title: v.string(),
        description: v.optional(v.string()),
        assigneeIds: v.array(v.id("users")),
        dueAt: v.optional(v.number()),
        startAt: v.optional(v.number()),
        endAt: v.optional(v.number()),
        location: v.optional(v.string()),
        /** The draft created from this item. */
        assignmentId: v.optional(v.id("assignments")),
      }),
    ),
    announcements: v.array(
      v.object({
        body: v.string(),
        sent: v.array(v.object({ channelId: v.id("channels"), messageId: v.id("messages"), by: v.id("users"), at: v.number() })),
      }),
    ),
    edits: v.array(
      v.object({
        assignmentId: v.id("assignments"),
        fields: v.object({
          title: v.optional(v.string()),
          description: v.optional(v.string()),
          assigneeIds: v.optional(v.array(v.id("users"))),
          dueAt: v.optional(v.number()),
          startAt: v.optional(v.number()),
          endAt: v.optional(v.number()),
          location: v.optional(v.string()),
        }),
        suggestionId: v.optional(v.id("aiSuggestions")),
      }),
    ),
    error: v.optional(v.string()),
  }).index("by_document", ["documentId"]),

  /** A private 小飒 writing result for one editor; applied through their editor, never written directly. */
  aiDocDrafts: defineTable({
    documentId: v.id("documents"),
    userId: v.id("users"),
    requestId: v.id("aiRequests"),
    prompt: v.string(),
    status: v.union(
      v.literal("thinking"),
      v.literal("streaming"),
      v.literal("done"),
      v.literal("refused"),
      v.literal("failed"),
      v.literal("closed"),
    ),
    text: v.string(),
    /** Refusal reason, or the admin's note after a denied appeal. */
    reason: v.optional(v.string()),
    appealDenied: v.optional(v.boolean()),
  })
    .index("by_document_user", ["documentId", "userId"])
    .index("by_request", ["requestId"]),

  auditLogs: defineTable({
    actorId: v.optional(v.id("users")),
    action: v.string(),
    targetType: v.string(),
    targetId: v.string(),
    subjectUserId: v.optional(v.id("users")),
    metadata: v.optional(v.any()),
  })
    .index("by_actor", ["actorId"])
    .index("by_subject", ["subjectUserId"])
    .index("by_action", ["action"]),
});
