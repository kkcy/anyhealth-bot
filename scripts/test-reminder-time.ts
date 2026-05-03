import "dotenv/config";
import { formatTimeMYT } from "../src/lib/time";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else { console.error(`FAIL: ${label}`); failures++; }
}

async function main() {
  // 2026-05-05T02:30:00Z = 10:30 AM MYT (UTC+8) on Tue 5 May 2026
  const utc = new Date("2026-05-05T02:30:00Z");
  assert(
    formatTimeMYT(utc) === "10:30 AM, Tue 5 May",
    "formats UTC instant in Asia/Kuala_Lumpur",
  );

  // Midnight MYT (16:00 UTC previous day)
  const midnightMYT = new Date("2026-05-04T16:00:00Z");
  assert(
    formatTimeMYT(midnightMYT) === "12:00 AM, Tue 5 May",
    "midnight MYT renders as 12:00 AM",
  );

  // Single-digit day no leading zero
  const earlyMonth = new Date("2026-05-01T01:00:00Z"); // 09:00 AM MYT Fri 1 May
  assert(
    formatTimeMYT(earlyMonth) === "9:00 AM, Fri 1 May",
    "single-digit day with no leading zero",
  );

  if (failures > 0) {
    console.error(`\n${failures} failures`);
    process.exit(1);
  }
  console.log("\nAll tests passed");
}

main();
