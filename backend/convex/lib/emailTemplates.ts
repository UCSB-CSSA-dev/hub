import { TIME_ZONE } from "./constants";
import type { Digest, DigestAnnouncement, DigestChat, DigestItem } from "./digest";

type Locale = "zh" | "en";

const TEXT = {
  zh: {
    subjectToday: "【CSSA Hub】今日待办：{n} 项",
    subjectDaily: "【CSSA Hub】每日摘要",
    greeting: "{name}，早上好！这是你今天的 CSSA Hub 摘要。",
    today: "今天",
    week: "未来一周",
    todos: "其他待办",
    announcements: "未读公告",
    chats: "未读消息",
    unreadCount: "{n} 条未读",
    mutedCount: "{n} 条未读（免打扰）",
    more: "还有 {n} 条，打开聊天查看",
    openChat: "打开聊天",
    task: "任务",
    event: "活动",
    due: "截止 {time}",
    overdue: "已逾期 · 截止 {time}",
    noDue: "无截止日期",
    open: "打开任务页面",
    footer:
      "这是 CSSA Hub 每天上午 10 点发送的摘要，只在你有待办、活动或未读消息时发送。接收邮箱和摘要语言可以在“设置 → 通知”中修改。",
  },
  en: {
    subjectToday: "[CSSA Hub] Today: {n} item(s)",
    subjectDaily: "[CSSA Hub] Daily summary",
    greeting: "Good morning, {name}! Here is your CSSA Hub summary for today.",
    today: "Today",
    week: "Next 7 days",
    todos: "Other to-dos",
    announcements: "Unread announcements",
    chats: "Unread messages",
    unreadCount: "{n} unread",
    mutedCount: "{n} unread (muted)",
    more: "{n} more — open the chat to read them",
    openChat: "Open Chat",
    task: "Task",
    event: "Event",
    due: "Due {time}",
    overdue: "Overdue · was due {time}",
    noDue: "No due date",
    open: "Open Tasks",
    footer:
      "CSSA Hub sends this summary at 10:00 AM Pacific, only when you have open tasks, events, or unread messages. You can change the address and language in Settings → Notifications.",
  },
} as const;

function fill(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTime(ms: number, locale: Locale) {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

function itemWhen(item: DigestItem, locale: Locale) {
  const t = TEXT[locale];
  if (item.kind === "event" && item.startAt) {
    const start = formatTime(item.startAt, locale);
    const end = item.endAt ? ` – ${formatTime(item.endAt, locale)}` : "";
    return `${start}${end}${item.location ? ` · ${item.location}` : ""}`;
  }
  if (item.dueAt === undefined) return t.noDue;
  return fill(item.overdue ? t.overdue : t.due, { time: formatTime(item.dueAt, locale) });
}

const box = (critical: boolean) =>
  critical ? "background:#fff8e6;border:1px solid #f0d58c;border-radius:8px;padding:4px 16px 8px;" : "padding:0 0 8px;";

function sectionHtml(title: string, count: number, rows: string, critical = false) {
  return `<div style="margin-top:20px;${box(critical)}">
<h2 style="font-size:15px;margin:12px 0 4px;color:${critical ? "#8a6100" : "#111111"};">${escapeHtml(title)} (${count})</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
</div>`;
}

function button(href: string, label: string, primary: boolean) {
  const style = primary ? "background:#d4a017;color:#111111;" : "background:#ffffff;color:#8a6100;border:1px solid #d4a017;";
  return `<a href="${escapeHtml(href)}" style="display:inline-block;${style}font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px;text-decoration:none;margin:0 8px 8px 0;">${escapeHtml(label)}</a>`;
}

export function renderDigest(digest: Digest, args: { locale: Locale; name: string; siteUrl: string }) {
  const { locale, siteUrl } = args;
  const t = TEXT[locale];
  const base = siteUrl.replace(/\/+$/, "");
  // Jobs queued before the unread sections existed still render.
  const week = digest.week ?? (digest as { events?: DigestItem[] }).events ?? [];
  const announcements = digest.announcements ?? [];
  const chats = digest.chats ?? [];
  const subject = digest.today.length > 0 ? fill(t.subjectToday, { n: digest.today.length }) : t.subjectDaily;
  const greeting = fill(t.greeting, { name: args.name });

  const sections: [string, DigestItem[], boolean][] = [
    [t.today, digest.today, true],
    [t.week, week, false],
    [t.todos, digest.todos, false],
  ];

  const itemHtml = (item: DigestItem, critical: boolean) => {
    const chat = locale === "zh" ? item.chatZh : item.chatEn || item.chatZh;
    const when = itemWhen(item, locale);
    const color = item.overdue ? "#b42318" : critical ? "#8a6100" : "#555555";
    return `<tr><td style="padding:10px 0;border-bottom:1px solid #eeeeee;">
<div style="font-size:12px;color:#888888;">${escapeHtml(item.kind === "event" ? t.event : t.task)}${chat ? ` · ${escapeHtml(chat)}` : ""}</div>
<a href="${escapeHtml(base + item.link)}" style="font-size:15px;color:#111111;font-weight:600;text-decoration:none;">${escapeHtml(item.title)}</a>
<div style="font-size:13px;color:${color};margin-top:2px;">${escapeHtml(when)}</div>
</td></tr>`;
  };

  const announcementHtml = (a: DigestAnnouncement) => `<tr><td style="padding:10px 0;border-bottom:1px solid #f0d58c;">
<div style="font-size:12px;color:#888888;"><a href="${escapeHtml(base + a.link)}" style="color:#8a6100;text-decoration:none;">${escapeHtml(a.chat)}</a> · ${escapeHtml(a.author)} · ${escapeHtml(formatTime(a.at, locale))}</div>
<div style="font-size:14px;color:#111111;margin-top:2px;">${escapeHtml(a.text)}</div>
</td></tr>`;

  const chatHtml = (chat: DigestChat) => {
    const count = fill(chat.muted ? t.mutedCount : t.unreadCount, { n: chat.unread });
    const hidden = chat.unread - chat.messages.length;
    const lines = chat.messages
      .map(
        (m) =>
          `<div style="font-size:14px;color:#333333;margin-top:4px;"><span style="color:#888888;">${escapeHtml(m.author)}:</span> ${escapeHtml(m.text)}</div>`,
      )
      .join("");
    const more =
      hidden > 0 && !chat.muted ? `<div style="font-size:12px;color:#888888;margin-top:4px;">${escapeHtml(fill(t.more, { n: hidden }))}</div>` : "";
    return `<tr><td style="padding:10px 0;border-bottom:1px solid #eeeeee;">
<div><a href="${escapeHtml(base + chat.link)}" style="font-size:15px;color:#111111;font-weight:600;text-decoration:none;">${escapeHtml(chat.name)}</a>
<span style="font-size:12px;color:${chat.muted ? "#888888" : "#b42318"};margin-left:6px;">${escapeHtml(count)}</span></div>
${lines}${more}
</td></tr>`;
  };

  const body = [
    announcements.length > 0
      ? sectionHtml(t.announcements, announcements.length, announcements.map(announcementHtml).join(""), true)
      : "",
    ...sections
      .filter(([, items]) => items.length > 0)
      .map(([title, items, critical]) => sectionHtml(title, items.length, items.map((i) => itemHtml(i, critical)).join(""), critical)),
    chats.length > 0 ? sectionHtml(t.chats, chats.length, chats.map(chatHtml).join("")) : "",
  ].join("");

  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
<div style="max-width:560px;margin:0 auto;padding:24px 16px;">
<div style="background:#ffffff;border-radius:12px;padding:24px;">
<div style="font-size:13px;font-weight:700;color:#b8860b;letter-spacing:0.5px;">CSSA HUB</div>
<p style="font-size:15px;color:#111111;margin:12px 0 0;">${escapeHtml(greeting)}</p>
${body}
<div style="margin-top:24px;">${button(`${base}/assignments/`, t.open, true)}${chats.length + announcements.length > 0 ? button(`${base}/chat/`, t.openChat, false) : ""}</div>
</div>
<p style="font-size:12px;color:#888888;margin:16px 4px 0;line-height:1.5;">${escapeHtml(t.footer)}</p>
</div></body></html>`;

  const textLines = [greeting];
  if (announcements.length > 0) {
    textLines.push("", `${t.announcements} (${announcements.length})`);
    for (const a of announcements) textLines.push(`- [${a.chat}] ${a.author}: ${a.text}`, `  ${base}${a.link}`);
  }
  for (const [title, items] of sections) {
    if (items.length === 0) continue;
    textLines.push("", `${title} (${items.length})`);
    for (const item of items) {
      const chat = locale === "zh" ? item.chatZh : item.chatEn || item.chatZh;
      textLines.push(`- ${item.title}${chat ? ` [${chat}]` : ""} — ${itemWhen(item, locale)}`, `  ${base}${item.link}`);
    }
  }
  if (chats.length > 0) {
    textLines.push("", `${t.chats} (${chats.length})`);
    for (const chat of chats) {
      textLines.push(`- ${chat.name} · ${fill(chat.muted ? t.mutedCount : t.unreadCount, { n: chat.unread })}`);
      for (const m of chat.messages) textLines.push(`  ${m.author}: ${m.text}`);
      textLines.push(`  ${base}${chat.link}`);
    }
  }
  textLines.push("", `${t.open}: ${base}/assignments/`, "", t.footer);
  return { subject, html, text: textLines.join("\n") };
}
