import { resolveClinicBySlug } from "../src/bot/clinic-resolver";
import { applyDeepLink } from "../src/bot/deep-link";
import { buildWelcomeText } from "../src/bot/messages/welcome";
import { getSupabase } from "../src/lib/supabase";
import type { ThreadState } from "../src/types";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

function makeState(p: Partial<ThreadState> = {}): ThreadState {
  return {
    phone: "60123456789",
    verified: false,
    verifyAttempts: 0,
    ...p,
  };
}

async function main() {
  const supabase = getSupabase();
  const { data: clinics, error } = await supabase
    .from("c_a_clinics")
    .select("id, name, slug")
    .limit(2);

  if (error) {
    console.error("Could not load clinics:", error.message);
    process.exit(1);
  }
  if (!clinics || clinics.length === 0) {
    console.error("No clinics in c_a_clinics — seed at least one before running.");
    process.exit(1);
  }

  const clinicA = clinics[0];

  // 1. Resolver: known slug.
  const r1 = await resolveClinicBySlug(clinicA.slug);
  assert(!!r1 && r1.id === clinicA.id, `resolver finds known slug "${clinicA.slug}"`);

  // 2. Resolver: unknown slug.
  const r2 = await resolveClinicBySlug("definitely-not-a-real-clinic-xyz");
  assert(r2 === null, "resolver returns null for unknown slug");

  // 3. State transform: fresh state pre-scoped to clinic.
  const sFresh = makeState();
  applyDeepLink(sFresh, { id: clinicA.id, name: clinicA.name });
  assert(sFresh.activeClinicId === clinicA.id, "fresh state → activeClinicId set");

  // 4. State transform: mid-booking switch wipes booking fields.
  const sMid = makeState({
    activeClinicId: "OTHER_CLINIC_ID_DOES_NOT_MATTER",
    activeServiceId: "svc-1",
    activeMethodId: "method-1",
    activeDoctorId: "doc-1",
    userId: "u1",
    verified: true,
    language: "ms",
  });
  applyDeepLink(sMid, { id: clinicA.id, name: clinicA.name });
  assert(sMid.activeClinicId === clinicA.id, "switch → activeClinicId switched");
  assert(sMid.activeServiceId === undefined, "switch → activeServiceId wiped");
  assert(sMid.userId === "u1", "switch → userId preserved");
  assert(sMid.verified === true, "switch → verified preserved");
  assert(sMid.language === "ms", "switch → language preserved");

  // 5. Welcome template uses correct language.
  const en = buildWelcomeText("Acme Dental", "en");
  const ms = buildWelcomeText("Acme Dental", "ms");
  const zh = buildWelcomeText("Acme Dental", "zh");
  const fallback = buildWelcomeText("Acme Dental", undefined);
  assert(en.includes("*Acme Dental*") && en.toLowerCase().includes("hi"), "en welcome");
  assert(ms.includes("*Acme Dental*") && ms.toLowerCase().includes("hai"), "ms welcome");
  assert(zh.includes("*Acme Dental*") && zh.includes("您好"), "zh welcome");
  assert(fallback === en, "undefined language → english fallback");

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll integration tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
