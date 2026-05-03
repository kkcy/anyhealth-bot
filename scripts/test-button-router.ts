import "dotenv/config";
import { parseButtonPayload } from "../src/bot/messages/button-router";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else { console.error(`FAIL: ${label}`); failures++; }
}

async function main() {
  // Valid payloads
  {
    const p = parseButtonPayload("mute_clinic:abc-123");
    assert(p?.kind === "mute_clinic" && (p as any).clinicId === "abc-123", "mute_clinic parses");
  }
  {
    const p = parseButtonPayload("view_booking:bk_xyz");
    assert(p?.kind === "view_booking" && (p as any).bookingId === "bk_xyz", "view_booking parses");
  }
  {
    const p = parseButtonPayload("get_doc:bk_1");
    assert(p?.kind === "get_doc" && (p as any).bookingId === "bk_1", "get_doc parses");
  }
  {
    const p = parseButtonPayload("unmute_clinic:cl_2");
    assert(p?.kind === "unmute_clinic" && (p as any).clinicId === "cl_2", "unmute_clinic parses");
  }

  // Invalid payloads return null (fall through to AI loop)
  assert(parseButtonPayload("") === null, "empty -> null");
  assert(parseButtonPayload("Hello bot") === null, "free text -> null");
  assert(parseButtonPayload("mute_clinic:") === null, "missing id -> null");
  assert(parseButtonPayload("mute_clinic:abc def") === null, "id with space -> null");
  assert(parseButtonPayload("evil_action:abc") === null, "unknown kind -> null");
  assert(parseButtonPayload("MUTE_CLINIC:abc") === null, "case-sensitive (template payloads are lowercase) -> null");

  if (failures > 0) { console.error(`\n${failures} failures`); process.exit(1); }
  console.log("\nAll tests passed");
}

main();
