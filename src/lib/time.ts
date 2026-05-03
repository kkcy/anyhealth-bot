const MYT_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Kuala_Lumpur",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

export function formatTimeMYT(d: Date): string {
  // Intl gives e.g. "Tue, May 5, 10:30 AM" — reorder to "10:30 AM, Tue 5 May".
  const parts = MYT_FORMAT.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour");
  const minute = get("minute");
  const dayPeriod = get("dayPeriod"); // "AM" / "PM"
  const weekday = get("weekday");
  const day = get("day");
  const month = get("month");
  return `${hour}:${minute} ${dayPeriod}, ${weekday} ${day} ${month}`;
}
