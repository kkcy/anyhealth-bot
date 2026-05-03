import "dotenv/config";
import { getSupabase } from "../src/lib/supabase";
import {
  isMuted,
  muteClinic,
  unmuteClinic,
  muteGlobally,
  listMutedClinics,
} from "../src/lib/reminders/optout";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else { console.error(`FAIL: ${label}`); failures++; }
}

const PHONE = "60000test001";
const CLINIC_A = "test-clinic-a";
const CLINIC_B = "test-clinic-b";

async function reset() {
  const sb = getSupabase();
  await sb.from("reminder_optouts").delete().eq("phone", PHONE);
}

async function main() {
  await reset();

  assert(!(await isMuted(PHONE, CLINIC_A)), "fresh phone is not muted");

  await muteClinic(PHONE, CLINIC_A, "button");
  assert(await isMuted(PHONE, CLINIC_A), "clinic A muted after muteClinic");
  assert(!(await isMuted(PHONE, CLINIC_B)), "clinic B still not muted (per-clinic scope)");

  await unmuteClinic(PHONE, CLINIC_A);
  assert(!(await isMuted(PHONE, CLINIC_A)), "clinic A unmuted");

  // Global mute affects all clinics
  await muteGlobally(PHONE, "auto_block");
  assert(await isMuted(PHONE, CLINIC_A), "global mute covers clinic A");
  assert(await isMuted(PHONE, CLINIC_B), "global mute covers clinic B");

  // Auto-unmute on rebook scenario: only 'button' source clears
  await reset();
  await muteClinic(PHONE, CLINIC_A, "button");
  await muteGlobally(PHONE, "auto_block");
  await unmuteClinic(PHONE, CLINIC_A, { onlyButtonSource: true });
  assert(!(await isMuted(PHONE, CLINIC_A)) === false, "auto_block global mute survives onlyButtonSource unmute");
  // (still muted because of global auto_block row)

  // Listing
  await reset();
  await muteClinic(PHONE, CLINIC_A, "button");
  await muteClinic(PHONE, CLINIC_B, "command");
  await muteGlobally(PHONE, "auto_block");
  const listed = await listMutedClinics(PHONE);
  // listMutedClinics excludes auto_block global mutes (UI-only list)
  assert(
    listed.length === 2 && listed.every((c) => c !== null),
    "listMutedClinics returns 2 clinic-scoped mutes, excludes global",
  );

  await reset();
  if (failures > 0) { console.error(`\n${failures} failures`); process.exit(1); }
  console.log("\nAll tests passed");
}

main();
