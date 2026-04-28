import { parseFriendlyPrefill } from "../src/bot/deep-link";
import { buildPrefillText } from "../src/lib/clinic-link";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

// Round-trip
{
  const text = buildPrefillText("One Care Clinic");
  const r = parseFriendlyPrefill(text);
  assert(
    r.kind === "match" && r.clinicName === "One Care Clinic" && r.residual === "",
    "round-trip prefill → match",
  );
}

// Case-insensitive
{
  const r = parseFriendlyPrefill("hi! i’d like to book at one care clinic");
  assert(
    r.kind === "match" && r.clinicName.toLowerCase() === "one care clinic",
    "case-insensitive prefix",
  );
}

// Curly apostrophe
{
  const r = parseFriendlyPrefill("Hi! I’d like to book at One Care Clinic");
  assert(r.kind === "match" && r.clinicName === "One Care Clinic", "curly apostrophe accepted");
}

// Non-template text → none
{
  const r = parseFriendlyPrefill("hi there i want an appointment");
  assert(r.kind === "none", "non-template text → none");
}

// Empty string → none
{
  const r = parseFriendlyPrefill("");
  assert(r.kind === "none", "empty input → none");
}

// Trailing whitespace tolerated
{
  const r = parseFriendlyPrefill("Hi! I’d like to book at One Care Clinic   \n");
  assert(r.kind === "match" && r.clinicName === "One Care Clinic", "trailing whitespace trimmed");
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll friendly-prefill tests passed.");
