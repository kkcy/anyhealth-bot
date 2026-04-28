import "dotenv/config";
import {
  buildPrefillText,
  buildShortUrl,
  buildWhatsAppDeepLink,
  PREFILL_TEMPLATE_REGEX,
} from "../src/lib/clinic-link";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

async function main() {
  // buildPrefillText
  assert(
    buildPrefillText("One Care Clinic") === "Hi! I'd like to book at One Care Clinic",
    "buildPrefillText: simple name",
  );
  assert(
    buildPrefillText("  One Care Clinic  ") === "Hi! I'd like to book at One Care Clinic",
    "buildPrefillText: trims whitespace",
  );

  // PREFILL_TEMPLATE_REGEX round-trip
  {
    const text = buildPrefillText("One Care Clinic");
    const m = text.match(PREFILL_TEMPLATE_REGEX);
    assert(!!m && m[1] === "One Care Clinic", "regex matches generated text");
  }
  {
    const text = "hi! i'd like to book at one care clinic";
    const m = text.match(PREFILL_TEMPLATE_REGEX);
    assert(!!m && m[1].toLowerCase() === "one care clinic", "regex case-insensitive");
  }
  {
    const m = "Hi there I want a booking".match(PREFILL_TEMPLATE_REGEX);
    assert(m === null, "non-template text → no match");
  }
  {
    // Curly apostrophe variant some keyboards produce.
    const m = "Hi! I'd like to book at One Care Clinic".match(PREFILL_TEMPLATE_REGEX);
    assert(!!m && m[1] === "One Care Clinic", "regex accepts curly apostrophe");
  }

  // buildShortUrl
  process.env.PUBLIC_BASE_URL = "https://bot.anyhealth.my";
  assert(
    buildShortUrl("one-care-clinic") === "https://bot.anyhealth.my/c/one-care-clinic",
    "buildShortUrl with PUBLIC_BASE_URL",
  );
  delete process.env.PUBLIC_BASE_URL;
  assert(
    buildShortUrl("one-care-clinic").endsWith("/c/one-care-clinic"),
    "buildShortUrl falls back when PUBLIC_BASE_URL unset",
  );

  // buildWhatsAppDeepLink
  assert(
    buildWhatsAppDeepLink("60123456789", "Hi! I'd like to book at One Care Clinic") ===
      "https://wa.me/60123456789?text=Hi!%20I'd%20like%20to%20book%20at%20One%20Care%20Clinic",
    "buildWhatsAppDeepLink encodes prefill",
  );
  assert(
    buildWhatsAppDeepLink("+60 123 456 789", "x") === "https://wa.me/60123456789?text=x",
    "buildWhatsAppDeepLink strips non-digits from phone",
  );

  // Route handler — miss-branch only (no Supabase stub in this script).
  // Hit-branch is covered in test:deep-link.
  {
    process.env.WHATSAPP_BUSINESS_PHONE = "60123456789";
    const { GET } = await import("../src/app/c/[slug]/route");
    const req = new Request("https://example.test/c/__nope__", { method: "GET" });
    const res = await GET(req as any, { params: Promise.resolve({ slug: "__nope__" }) });
    assert(res.status === 302, "GET /c/__nope__ → 302");
    // Miss branch redirects to the home page on the same origin.
    const loc = res.headers.get("location") ?? "";
    assert(
      loc.endsWith("/") || loc === "https://example.test/" || loc === "/",
      `miss redirects to /; got=${loc}`,
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll clinic-link tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
