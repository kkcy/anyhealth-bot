import { parseDeepLinkToken, applyDeepLink } from "../src/bot/deep-link";
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

// --- parseDeepLinkToken ---
{
  const r = parseDeepLinkToken("clinic_acme-dental");
  assert(r.kind === "match" && r.slug === "acme-dental" && r.residual === "",
    "valid slug, no residual");
}
{
  const r = parseDeepLinkToken("clinic_acme-dental I want a cleaning");
  assert(r.kind === "match" && r.slug === "acme-dental" && r.residual === "I want a cleaning",
    "valid slug + residual");
}
{
  const r = parseDeepLinkToken("Clinic_Acme-Dental");
  assert(r.kind === "match" && r.slug === "acme-dental",
    "case-insensitive prefix and slug, lowercased");
}
{
  const r = parseDeepLinkToken("hi clinic_acme please");
  assert(r.kind === "none", "token not at start of message → none");
}
{
  const r = parseDeepLinkToken("clinic_acme$$$");
  assert(r.kind === "match" && r.slug === "acme" && r.residual === "$$$",
    "junk after slug → match with junk in residual");
}
{
  // 41-char slug body — over the 40-char cap.
  const r = parseDeepLinkToken("clinic_" + "a".repeat(41));
  assert(r.kind === "none", "over-cap slug → none");
}
{
  const r = parseDeepLinkToken("clinic_acme-");
  assert(r.kind === "none", "trailing hyphen in slug → none");
}
{
  const r = parseDeepLinkToken("clinic_acme- hello");
  assert(r.kind === "none", "trailing hyphen before space → none");
}
{
  const r = parseDeepLinkToken("");
  assert(r.kind === "none", "empty input → none");
}

// --- applyDeepLink ---
function makeState(p: Partial<ThreadState> = {}): ThreadState {
  return {
    phone: "60123456789",
    verified: false,
    verifyAttempts: 0,
    ...p,
  };
}

{
  const s = makeState({
    activeClinicId: "old-id",
    activeServiceId: "svc-1",
    activeMethodId: "method-1",
    activeDoctorId: "doc-1",
    lastSearchQuery: "dental",
    clinicOptions: [{ id: "x", name: "X" } as any],
    serviceOptions: [{ id: "y", name: "Y" } as any],
    doctorOptions: [{ id: "z", name: "Z" } as any],
    userId: "u1",
    activePatientId: "p1",
    verified: true,
    language: "en",
  });
  applyDeepLink(s, { id: "new-id", name: "New" });
  assert(s.activeClinicId === "new-id", "different clinic → activeClinicId switched");
  assert(s.activeServiceId === undefined, "different clinic → activeServiceId wiped");
  assert(s.activeMethodId === undefined, "different clinic → activeMethodId wiped");
  assert(s.activeDoctorId === undefined, "different clinic → activeDoctorId wiped");
  assert(s.lastSearchQuery === undefined, "different clinic → lastSearchQuery wiped");
  assert((s.clinicOptions ?? []).length === 0, "different clinic → clinicOptions wiped");
  assert((s.serviceOptions ?? []).length === 0, "different clinic → serviceOptions wiped");
  assert((s.doctorOptions ?? []).length === 0, "different clinic → doctorOptions wiped");
  assert(s.userId === "u1", "different clinic → userId preserved");
  assert(s.activePatientId === "p1", "different clinic → activePatientId preserved");
  assert(s.verified === true, "different clinic → verified preserved");
  assert(s.language === "en", "different clinic → language preserved");
}

{
  const s = makeState({
    activeClinicId: "same-id",
    activeServiceId: "svc-1",
    activeMethodId: "method-1",
  });
  applyDeepLink(s, { id: "same-id", name: "Same" });
  assert(s.activeClinicId === "same-id", "same clinic → activeClinicId unchanged");
  assert(s.activeServiceId === "svc-1", "same clinic re-tap → activeServiceId preserved");
  assert(s.activeMethodId === "method-1", "same clinic re-tap → activeMethodId preserved");
}

{
  const s = makeState();
  applyDeepLink(s, { id: "new-id", name: "New" });
  assert(s.activeClinicId === "new-id", "fresh state → activeClinicId set");
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll parser tests passed.");
