import { MENTION_PATTERN } from "../text";

// Cheap check before spending a model call on automatic task suggestions: only messages that look
// like they hand out work, set a time, or change a plan get scanned.

const ZH = [
  "负责", "安排", "交给", "帮忙", "麻烦", "拜托", "截止", "之前", "以前", "提交", "完成", "任务", "活动",
  "开会", "会议", "改到", "改成", "换成", "推迟", "延期", "提前", "取消", "地点", "时间", "明天", "后天",
  "今晚", "下周", "这周", "本周", "星期", "礼拜", "做一下", "写一下", "准备", "截稿", "ddl", "DDL",
];
const ZH_PATTERNS = [/周[一二三四五六日天末]/, /\d{1,2}\s*[月号日点]/, /[一二三四五六七八九十]+[号点]/];

const EN = [
  /\bassign/i, /\bdue\b/i, /\bdeadline/i, /\bby (mon|tue|wed|thu|fri|sat|sun|tomorrow|tonight|next|end of)/i,
  /\btomorrow\b/i, /\btonight\b/i, /\bnext (week|mon|tue|wed|thu|fri|sat|sun)/i, /\b(can|could) you\b/i,
  /\bplease\b/i, /\bin charge\b/i, /\bresponsible\b/i, /\breschedul/i, /\bpostpone/i, /\bmove (it|the)\b/i,
  /\bchange (the|it)\b/i, /\bextend/i, /\bvenue\b/i, /\blocation\b/i, /\bmeeting\b/i, /\bevent\b/i,
  /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i, /\b\d{1,2}[/-]\d{1,2}\b/,
];

export function worthScanning(body: string) {
  const hasMention = /<@[a-z0-9]+>/i.test(body);
  const text = body.replace(MENTION_PATTERN, " ").trim();
  if (text.length < 4) return false;
  if (ZH.some((word) => text.includes(word))) return true;
  if (ZH_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (EN.some((pattern) => pattern.test(text))) return true;
  return hasMention && text.length >= 8;
}
