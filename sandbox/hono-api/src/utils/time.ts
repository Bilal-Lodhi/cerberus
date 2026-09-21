/**
 * Time utilities — produces ISO-8601 strings with the server's local
 * timezone offset (e.g. +05:00) instead of UTC Z suffix, so that
 * MongoDB Atlas Explorer and frontend dashboards display times in
 * the operator's local time zone.
 *
 * Also provides human-readable local time formatting used by the
 * risk notification UI and audit review timeline.
 */

const PAD = (n: number): string => n.toString().padStart(2, "0");
const PAD_MS = (n: number): string => n.toString().padStart(3, "0");

/**
 * Returns an ISO-8601 string using the server's LOCAL timezone offset
 * (e.g. "2026-06-04T08:22:36.123+05:00") instead of UTC Z suffix.
 * This makes timestamps human-readable in MongoDB Atlas Explorer and
 * the Flutter dashboard without timezone conversion guesswork.
 */
export function toISOStringLocal(date = new Date()): string {
  const tzOffsetMin = -date.getTimezoneOffset(); // getTimezoneOffset returns (UTC - local) in minutes, but negated
  const sign = tzOffsetMin >= 0 ? "+" : "-";
  const absOff = Math.abs(tzOffsetMin);
  const offH = PAD(Math.floor(absOff / 60));
  const offM = PAD(absOff % 60);

  const y = date.getFullYear();
  const mo = PAD(date.getMonth() + 1);
  const d = PAD(date.getDate());
  const h = PAD(date.getHours());
  const mi = PAD(date.getMinutes());
  const s = PAD(date.getSeconds());
  const ms = PAD_MS(date.getMilliseconds());

  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}${sign}${offH}:${offM}`;
}

/**
 * Formats a Date into a human-readable local time label.
 * Examples: "Today 10:32 AM", "Jun 3, 10:32 AM"
 *
 * Used for incidentTimeLabel in risk notification popups and
 * the real-time threat dashboard timeline entries.
 */
export function formatLocalTime(date: Date): string {
  const now = new Date();
  const isToday =
    now.getFullYear() === date.getFullYear() &&
    now.getMonth() === date.getMonth() &&
    now.getDate() === date.getDate();

  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  const timeStr = `${hour12}:${minutes} ${ampm}`;

  if (isToday) return `Today ${timeStr}`;

  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${monthNames[date.getMonth()]} ${date.getDate()}, ${timeStr}`;
}