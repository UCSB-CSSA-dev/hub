import { TIME_ZONE } from "./constants";

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function pacificParts(ms: number) {
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
}

/** Milliseconds Pacific time is ahead of UTC at `ms` (negative). */
function offsetAt(ms: number) {
  const p = pacificParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** "YYYY-MM-DD" in Pacific time. */
export function pacificDay(ms: number) {
  const p = pacificParts(ms);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function pacificHour(ms: number) {
  return pacificParts(ms).hour;
}

/** Midnight Pacific time of the day containing `ms`. */
export function startOfPacificDay(ms: number) {
  const p = pacificParts(ms);
  const midnightUtc = Date.UTC(p.year, p.month - 1, p.day);
  // Re-check the offset at the guess, since midnight can be on the other side of a DST change.
  const guess = midnightUtc - offsetAt(ms);
  return midnightUtc - offsetAt(guess);
}

/** Midnight Pacific time at the end of the day containing `ms`. */
export function endOfPacificDay(ms: number) {
  return startOfPacificDay(startOfPacificDay(ms) + 36 * 60 * 60 * 1000);
}

/** The instant a Pacific wall-clock time happens. Day overflow is allowed (day 0 is the previous month's last day). */
export function pacificWallTime(year: number, month: number, day: number, hour: number, minute = 0) {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const guess = asUtc - offsetAt(asUtc);
  return asUtc - offsetAt(guess);
}

/** Day of the week in Pacific time, 0 = Sunday. */
export function pacificWeekday(ms: number) {
  const p = pacificParts(ms);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/**
 * The most recent `weekday` at `hour`:00 Pacific at or before `ms`, and the next one after it.
 * Used for the weekly 小飒 credit reset (Sunday 08:00).
 */
export function pacificWeekWindow(ms: number, weekday: number, hour: number) {
  const p = pacificParts(ms);
  const back = (pacificWeekday(ms) - weekday + 7) % 7;
  let start = pacificWallTime(p.year, p.month, p.day - back, hour);
  let startDay = p.day - back;
  if (start > ms) {
    startDay -= 7;
    start = pacificWallTime(p.year, p.month, startDay, hour);
  }
  return { start, end: pacificWallTime(p.year, p.month, startDay + 7, hour) };
}
