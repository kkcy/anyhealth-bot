# Friendly Clinic Deep-Link Prefill + Branded Short URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace robot-token deep-link UX (`clinic_one-care-clinic`) with a human-readable WhatsApp prefill (`Hi! I'd like to book at One Care Clinic`) reached via a branded short URL (`/c/<slug>` → `wa.me` 302). Existing `clinic_<slug>` token parser stays as backward-compat fallback.

**Architecture:** Two changes layered on the existing deep-link feature.
1. **Branded short URL.** New Next.js route handler `src/app/c/[slug]/route.ts` looks up the clinic by slug and 302s to `https://wa.me/<biz_phone>?text=<urlencoded prefill>`. Lives on the bot's existing Next.js deployment so no new infra; user can front with a branded domain via DNS later.
2. **Friendly-prefill parser.** New parser path `parseFriendlyPrefill(text)` recognises the exact prefill template and extracts the clinic name. Resolver gets a sibling `resolveClinicByName(name)` (case-insensitive exact match against `c_a_clinics.name`). Wired into `src/bot/index.ts` after the legacy `clinic_<slug>` parser, before the LLM agent loop. Same `applyDeepLink` state transform reused. Only fires on the first message of a fresh thread (no `activeClinicId`, no `lastIntent`) to avoid mid-conversation false positives.

The prefill template is the single source of truth shared by the redirect builder and the parser; both import it from one helper. Because we control the URL that generates the prefill, parsing is exact-match (not fuzzy), so false positives are bounded by the user editing the prefill before sending — which falls through to the LLM cleanly.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (`c_a_clinics` table), tsx for test scripts. Reuses existing `clinic-resolver.ts`, `deep-link.ts`, and `applyDeepLink` from the merged deep-link feature.

---

## File Structure

**Create:**
- `src/lib/clinic-link.ts` — Pure helpers: `buildPrefillText(name)`, `buildShortUrl(slug)`, `buildWhatsAppDeepLink(phone, prefill)`. Single source of truth for the prefill template string.
- `src/app/c/[slug]/route.ts` — Next.js route handler. GET `/c/<slug>` resolves clinic by slug, 302s to `wa.me` with prefill, or 302s to `/` on miss.
- `scripts/test-clinic-link.ts` — Unit test for `buildPrefillText`, `buildShortUrl`, `buildWhatsAppDeepLink`, and the route handler (calling the GET function directly with a mocked resolver).
- `scripts/test-friendly-prefill.ts` — Unit test for `parseFriendlyPrefill`.

**Modify:**
- `src/lib/env.ts` — Add `WHATSAPP_BUSINESS_PHONE` to `REQUIRED_ENV_VARS`.
- `.env.example` — Add new env var with comment.
- `src/bot/clinic-resolver.ts` — Add `resolveClinicByName(name)`.
- `src/bot/deep-link.ts` — Add `parseFriendlyPrefill(text)` returning `{ kind: "none" } | { kind: "match"; clinicName: string; residual: string }`.
- `src/bot/index.ts` (around line 567–601) — After existing token parser, if `kind === "none"` and the thread is fresh, try `parseFriendlyPrefill`; on match, call `resolveClinicByName`, then existing `applyDeepLink` + `sendWelcome`.
- `package.json` — Add `test:clinic-link` and `test:friendly-prefill` scripts.
- `README.md` — Document the short URL + new prefill format under existing deep-link section.
- `docs/bot-test-smoke.md` — Add scenarios for `/c/<slug>` redirect and friendly prefill arrival.

**No changes to:** `c_a_clinics` schema (slug column already exists from migration `003_clinic_slug.sql`), existing welcome templates, prompt builder, `applyDeepLink` state transform.

---

## Task 1: Add `WHATSAPP_BUSINESS_PHONE` env var

**Files:**
- Modify: `src/lib/env.ts:1-10`
- Modify: `.env.example`

- [ ] **Step 1: Add env var to required list**

Edit `src/lib/env.ts`:

```ts
const REQUIRED_ENV_VARS = [
  "AI_MODEL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_BUSINESS_PHONE",
  "POSTGRES_URL",
] as const;
```

- [ ] **Step 2: Document in `.env.example`**

If `.env.example` exists, append:

```
# Visible WhatsApp business phone number used in wa.me deep links.
# E.164 format WITHOUT the leading '+' (e.g. 60123456789 for Malaysia).
# Distinct from WHATSAPP_PHONE_NUMBER_ID which is Meta's internal phone ID.
WHATSAPP_BUSINESS_PHONE=60123456789
```

If it doesn't exist, create it with this block plus existing keys copied from `src/lib/env.ts`.

- [ ] **Step 3: Set the value locally**

Add `WHATSAPP_BUSINESS_PHONE=<actual dev number, no +>` to local `.env`. (Do not commit `.env`; it's already gitignored.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/env.ts .env.example
git commit -m "feat(env): require WHATSAPP_BUSINESS_PHONE for wa.me deep links"
```

---

## Task 2: Pure helpers in `src/lib/clinic-link.ts` (TDD)

**Files:**
- Create: `src/lib/clinic-link.ts`
- Create: `scripts/test-clinic-link.ts`

- [ ] **Step 1: Write failing tests**

Create `scripts/test-clinic-link.ts`:

```ts
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
  const m = "Hi! I’d like to book at One Care Clinic".match(PREFILL_TEMPLATE_REGEX);
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
    "https://wa.me/60123456789?text=Hi%21%20I'd%20like%20to%20book%20at%20One%20Care%20Clinic",
  "buildWhatsAppDeepLink encodes prefill",
);
assert(
  buildWhatsAppDeepLink("+60 123 456 789", "x") === "https://wa.me/60123456789?text=x",
  "buildWhatsAppDeepLink strips non-digits from phone",
);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll clinic-link tests passed.");
```

- [ ] **Step 2: Add npm script and run test to verify it fails**

Edit `package.json` `scripts`:

```json
"test:clinic-link": "tsx --tsconfig tsconfig.json scripts/test-clinic-link.ts",
```

Run: `bun run test:clinic-link`
Expected: FAIL with module-not-found error for `../src/lib/clinic-link`.

- [ ] **Step 3: Implement helpers**

Create `src/lib/clinic-link.ts`:

```ts
/**
 * Single source of truth for the WhatsApp deep-link prefill template.
 * Shared between the /c/[slug] redirect (writer) and the bot parser (reader).
 *
 * Format: "Hi! I'd like to book at {clinic.name}"
 *
 * The name is rendered verbatim and round-trips through the regex below.
 */
export function buildPrefillText(clinicName: string): string {
  return `Hi! I'd like to book at ${clinicName.trim()}`;
}

/**
 * Matches the prefill template case-insensitively. Captures the clinic name
 * as group 1. Accepts both straight (') and curly (’) apostrophes since
 * some mobile keyboards substitute one for the other.
 */
export const PREFILL_TEMPLATE_REGEX =
  /^\s*hi[!.,]?\s+i['’]d\s+like\s+to\s+book\s+at\s+(.+?)\s*$/i;

/**
 * Branded short URL the clinic embeds on their website / poster / QR.
 * Falls back to a relative path if PUBLIC_BASE_URL is not set, so unit
 * tests work without env wiring.
 */
export function buildShortUrl(slug: string): string {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
  return `${base}/c/${slug}`;
}

/**
 * Builds the wa.me URL the short link redirects to. Strips non-digits from
 * the phone number so callers can pass either "60123456789" or "+60 123…".
 */
export function buildWhatsAppDeepLink(phone: string, prefill: string): string {
  const digits = phone.replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(prefill)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:clinic-link`
Expected: PASS for all 9 assertions.

- [ ] **Step 5: Commit**

```bash
git add src/lib/clinic-link.ts scripts/test-clinic-link.ts package.json
git commit -m "feat(bot): add clinic-link helpers (prefill template, short url, wa.me builder)"
```

---

## Task 3: Add `resolveClinicByName` to resolver

**Files:**
- Modify: `src/bot/clinic-resolver.ts`
- Test: extend `scripts/test-deep-link.ts` (existing integration script that hits Supabase)

- [ ] **Step 1: Add the resolver function**

Append to `src/bot/clinic-resolver.ts`:

```ts
/**
 * Looks up a clinic by exact (case-insensitive) name. Returns null on miss
 * or when the name is ambiguous (multiple rows match) — the caller should
 * fall through to the LLM rather than guess.
 */
export async function resolveClinicByName(name: string): Promise<ResolvedClinic | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("c_a_clinics")
    .select("id, name")
    .ilike("name", trimmed)
    .limit(2);

  if (error) {
    console.error(`[DEEP-LINK] resolveClinicByName error name=${trimmed}:`, error.message);
    return null;
  }
  if (!data || data.length === 0) return null;
  if (data.length > 1) {
    console.warn(`[DEEP-LINK] ambiguous clinic name=${trimmed} matches=${data.length}`);
    return null;
  }
  return { id: data[0].id, name: data[0].name };
}
```

- [ ] **Step 2: Add an integration assertion**

Open `scripts/test-deep-link.ts`, locate the existing `resolveClinicBySlug` block, and add a sibling block immediately after it:

```ts
import { resolveClinicByName } from "../src/bot/clinic-resolver";
// ...inside the same async IIFE / main():
{
  const c = await resolveClinicByName("one care clinic");
  assert(!!c && c.name.toLowerCase() === "one care clinic",
    "resolveClinicByName: case-insensitive exact match");
}
{
  const c = await resolveClinicByName("__nonexistent clinic xyz__");
  assert(c === null, "resolveClinicByName: miss → null");
}
```

(If the existing test file uses a different assertion harness, mirror it. Use the slug seeded by migration `003_clinic_slug.sql` — pick an actual seeded clinic name from `c_a_clinics` if `one care clinic` isn't present. Confirm with: `psql $POSTGRES_URL -c "select name from c_a_clinics limit 5"`.)

- [ ] **Step 3: Run integration test**

Run: `bun run test:deep-link`
Expected: PASS, including the new assertions.

- [ ] **Step 4: Commit**

```bash
git add src/bot/clinic-resolver.ts scripts/test-deep-link.ts
git commit -m "feat(bot): add resolveClinicByName for friendly prefill lookups"
```

---

## Task 4: Friendly-prefill parser (TDD)

**Files:**
- Modify: `src/bot/deep-link.ts`
- Create: `scripts/test-friendly-prefill.ts`

- [ ] **Step 1: Write failing tests**

Create `scripts/test-friendly-prefill.ts`:

```ts
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
  const r = parseFriendlyPrefill("hi! i'd like to book at one care clinic");
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
  const r = parseFriendlyPrefill("Hi! I'd like to book at One Care Clinic   \n");
  assert(r.kind === "match" && r.clinicName === "One Care Clinic", "trailing whitespace trimmed");
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll friendly-prefill tests passed.");
```

Add to `package.json` scripts:

```json
"test:friendly-prefill": "tsx --tsconfig tsconfig.json scripts/test-friendly-prefill.ts",
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:friendly-prefill`
Expected: FAIL — `parseFriendlyPrefill` not exported.

- [ ] **Step 3: Implement parser**

Append to `src/bot/deep-link.ts`:

```ts
import { PREFILL_TEMPLATE_REGEX } from "../lib/clinic-link";

export type FriendlyPrefillParse =
  | { kind: "none" }
  | { kind: "match"; clinicName: string; residual: string };

/**
 * Recognises the prefill template generated by /c/[slug] (see src/lib/clinic-link.ts).
 * Distinct from parseDeepLinkToken — that handles the legacy `clinic_<slug>` token
 * and stays in place for backward compat with any links already in the wild.
 *
 * Residual is always empty for now (the template captures the entire message),
 * but the field is kept symmetric with DeepLinkParse so the call sites compose.
 */
export function parseFriendlyPrefill(text: string): FriendlyPrefillParse {
  if (!text) return { kind: "none" };
  const m = text.match(PREFILL_TEMPLATE_REGEX);
  if (!m) return { kind: "none" };
  return { kind: "match", clinicName: m[1].trim(), residual: "" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:friendly-prefill`
Expected: PASS for all 6 assertions.

- [ ] **Step 5: Commit**

```bash
git add src/bot/deep-link.ts scripts/test-friendly-prefill.ts package.json
git commit -m "feat(bot): add parseFriendlyPrefill for human-readable deep-link arrivals"
```

---

## Task 5: Wire friendly-prefill into the message handler

**Files:**
- Modify: `src/bot/index.ts:567-601` (the existing deep-link block)

- [ ] **Step 1: Update imports**

Find the existing import line at `src/bot/index.ts:11-12`:

```ts
import { parseDeepLinkToken, applyDeepLink } from "./deep-link";
import { resolveClinicBySlug } from "./clinic-resolver";
```

Replace with:

```ts
import { parseDeepLinkToken, parseFriendlyPrefill, applyDeepLink } from "./deep-link";
import { resolveClinicBySlug, resolveClinicByName } from "./clinic-resolver";
```

- [ ] **Step 2: Extend the deep-link routing block**

Locate the block at `src/bot/index.ts:570-601` (`// --- Deep-link routing ---` … `// --- end deep-link routing ---`). After the existing `if (deepLink.kind === "match")` branch closes (right before the `}` that ends the outer block at line 600), insert:

```ts
    else {
      // Legacy token didn't match — try the friendly prefill, but only on
      // a fresh thread. Mid-conversation, an organic message that happens
      // to start with "Hi! I'd like to book at …" should NOT reset state.
      const isFreshThread = !state.activeClinicId && !state.lastIntent;
      if (isFreshThread) {
        const friendly = parseFriendlyPrefill(tokenText);
        if (friendly.kind === "match") {
          const clinic = await resolveClinicByName(friendly.clinicName);
          if (clinic) {
            applyDeepLink(state, clinic);
            deepLinkApplied = true;
            await thread.setState(state);
            console.log(
              `[DEEP-LINK] event=friendly_prefill name="${friendly.clinicName}" resolved=true clinicId=${clinic.id}`,
            );
            await sendWelcome(thread, clinic, state.language);
            return; // turn ends; LLM not invoked
          }
          // Unresolved friendly prefill: do NOT set unknownSlugThisTurn —
          // the user's intent is plain English, just let the LLM handle it.
          console.log(
            `[DEEP-LINK] event=friendly_prefill name="${friendly.clinicName}" resolved=false`,
          );
        }
      }
    }
```

(Verify the `lastIntent` field exists on `ThreadState`. If it does not, substitute the closest equivalent "thread has had any prior turn" check — e.g. `state.activePatientId` or a length check on `allMessages`. Confirm with: `grep -n "lastIntent\|interface ThreadState" src/types.ts`.)

- [ ] **Step 3: Type-check**

Run: `bun x tsc --noEmit`
Expected: no new errors. (Pre-existing `config.ts` error noted in observation 3512 is unrelated.)

- [ ] **Step 4: Re-run all deep-link tests**

```bash
bun run test:deep-link-parser
bun run test:friendly-prefill
bun run test:clinic-link
bun run test:deep-link
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/index.ts
git commit -m "feat(bot): route friendly prefill arrivals to clinic deep-link flow"
```

---

## Task 6: `/c/[slug]` redirect route (TDD)

**Files:**
- Create: `src/app/c/[slug]/route.ts`
- Modify: `scripts/test-clinic-link.ts` (extend with route-handler tests)

- [ ] **Step 1: Extend the test script with route-handler cases**

Append to `scripts/test-clinic-link.ts`, before the `if (failures > 0)` check:

```ts
// Route handler — call GET() directly with a stubbed resolver via env.
import { GET } from "../src/app/c/[slug]/route";

process.env.WHATSAPP_BUSINESS_PHONE = "60123456789";

// Hit the route. We can't easily stub the Supabase resolver from here, so
// this test exercises the not-found branch by passing a guaranteed-missing slug.
{
  const req = new Request("https://example.test/c/__nope__", { method: "GET" });
  // Next.js passes params as a Promise in v15+.
  const res = await GET(req as any, { params: Promise.resolve({ slug: "__nope__" }) });
  assert(res.status === 302, "GET /c/__nope__ → 302");
  assert(res.headers.get("location") === "/", "miss redirects to /");
}

// Found-branch coverage lives in test:deep-link (real Supabase).
```

Append to `scripts/test-deep-link.ts` a route-handler integration check that hits a real seeded slug:

```ts
{
  process.env.WHATSAPP_BUSINESS_PHONE = process.env.WHATSAPP_BUSINESS_PHONE ?? "60123456789";
  const { GET } = await import("../src/app/c/[slug]/route");
  const slug = "one-care-clinic"; // adjust to a real seeded slug if needed
  const req = new Request(`https://example.test/c/${slug}`, { method: "GET" });
  const res = await GET(req as any, { params: Promise.resolve({ slug }) });
  assert(res.status === 302, `GET /c/${slug} → 302`);
  const loc = res.headers.get("location") ?? "";
  assert(loc.startsWith("https://wa.me/60123456789?text="),
    `GET /c/${slug} → wa.me redirect`);
  assert(loc.includes("Hi%21%20I'd%20like%20to%20book%20at%20"),
    "wa.me URL embeds the prefill template");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:clinic-link`
Expected: FAIL — module not found `../src/app/c/[slug]/route`.

- [ ] **Step 3: Implement the route handler**

Create `src/app/c/[slug]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { resolveClinicBySlug } from "@/bot/clinic-resolver";
import {
  buildPrefillText,
  buildWhatsAppDeepLink,
} from "@/lib/clinic-link";

/**
 * Branded short URL: /c/<slug> → 302 to wa.me with a friendly prefill.
 *
 * Misses redirect to "/" so a clinic with a typoed link still lands the
 * patient on the bot's marketing page rather than a 404. The bot's parser
 * (parseFriendlyPrefill) reads the prefill on the WhatsApp side.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await ctx.params;

  const clinic = await resolveClinicBySlug(slug);
  if (!clinic) {
    console.log(`[CLINIC-LINK] event=short_url_miss slug=${slug}`);
    return NextResponse.redirect(new URL("/", _req.url), 302);
  }

  const phone = process.env.WHATSAPP_BUSINESS_PHONE;
  if (!phone) {
    console.error("[CLINIC-LINK] WHATSAPP_BUSINESS_PHONE not set");
    return NextResponse.redirect(new URL("/", _req.url), 302);
  }

  const prefill = buildPrefillText(clinic.name);
  const target = buildWhatsAppDeepLink(phone, prefill);

  console.log(
    `[CLINIC-LINK] event=short_url_hit slug=${slug} clinicId=${clinic.id}`,
  );
  return NextResponse.redirect(target, 302);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun run test:clinic-link
bun run test:deep-link
```

Expected: PASS.

- [ ] **Step 5: Smoke-test in dev**

```bash
bun run dev
# In another terminal:
curl -sI http://localhost:3000/c/one-care-clinic | head -5
```

Expected: `HTTP/1.1 302` with `location: https://wa.me/<your_phone>?text=Hi%21%20I'd%20like%20to%20book%20at%20One%20Care%20Clinic`. Replace `one-care-clinic` with a real seeded slug from your DB.

- [ ] **Step 6: Commit**

```bash
git add src/app/c/[slug]/route.ts scripts/test-clinic-link.ts scripts/test-deep-link.ts
git commit -m "feat(bot): /c/[slug] short URL redirects to wa.me with friendly prefill"
```

---

## Task 7: Docs + smoke test scenarios

**Files:**
- Modify: `README.md`
- Modify: `docs/bot-test-smoke.md`

- [ ] **Step 1: Update README**

Find the existing deep-link section in `README.md` (search for `clinic_` or "deep link"). Add a subsection beneath it:

```markdown
### Branded short URL

Patient-facing entry point. Clinics share `https://<your-public-domain>/c/<clinic-slug>` (e.g. on a website button, business card, QR). The route 302s to `wa.me` with a human-readable prefill the bot recognises:

- Visible to user: `Hi! I'd like to book at One Care Clinic`
- Bot effect: same as the legacy `clinic_<slug>` token — pre-scopes the booking to that clinic and sends the welcome template.

Required env: `WHATSAPP_BUSINESS_PHONE` (E.164 without `+`). Optional: `PUBLIC_BASE_URL` for `buildShortUrl()` callers.

The legacy `clinic_<slug>` text token still works for any links already in the wild.
```

- [ ] **Step 2: Add smoke scenarios**

Append to `docs/bot-test-smoke.md`:

```markdown
## Friendly clinic deep-link

### Scenario: short URL redirect
1. Open `https://<dev-host>/c/<known-slug>` in a mobile browser.
2. Expect: WhatsApp app opens with prefill `Hi! I'd like to book at <Clinic Name>`.
3. Tap send.
4. Expect: bot sends the clinic-specific welcome template; thread state has `activeClinicId` set.

### Scenario: short URL miss
1. Open `https://<dev-host>/c/__bogus__`.
2. Expect: browser lands on `/` (bot home page); no WhatsApp redirect.

### Scenario: organic friendly-prefill text mid-conversation
1. From a thread that already has `activeClinicId` and `lastIntent` set, send `Hi! I'd like to book at Some Other Clinic`.
2. Expect: bot does NOT switch clinics. The message is forwarded to the LLM as-is.
3. Reason: friendly-prefill parser only fires on a fresh thread.

### Scenario: friendly prefill, unknown clinic name
1. Fresh thread. Send `Hi! I'd like to book at Made Up Clinic`.
2. Expect: parser matches but resolver returns null. No state change. LLM responds normally without claiming the clinic exists.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/bot-test-smoke.md
git commit -m "docs(bot): document short URL + friendly prefill UX"
```

---

## Self-Review

**Spec coverage check:**
- Option 1 (friendlier prefill + name match): Tasks 3, 4, 5 ✓
- Option 4 (branded short URL): Tasks 1, 2, 6 ✓
- Backward compat with `clinic_<slug>` token: untouched in `src/bot/index.ts:570-599` ✓
- Single source of truth for prefill template: `src/lib/clinic-link.ts` exports both `buildPrefillText` and `PREFILL_TEMPLATE_REGEX` ✓
- Mid-conversation false-positive guard: `isFreshThread` check in Task 5 ✓
- Ambiguous-name guard: `resolveClinicByName` returns null on >1 match in Task 3 ✓

**Placeholder scan:** No "TBD", "implement later", or unspecified test code. All code blocks are complete. The one parametric note ("adjust to a real seeded slug if needed" in Task 6 Step 1) is unavoidable because seeded data is environment-specific; the bash command to discover the right slug is provided in Task 3 Step 2.

**Type consistency:**
- `parseFriendlyPrefill` returns `{ kind, clinicName, residual }` — used identically in Task 5.
- `resolveClinicByName` returns `ResolvedClinic | null` — same shape as `resolveClinicBySlug`, consumed identically by `applyDeepLink`.
- Helper names (`buildPrefillText`, `buildShortUrl`, `buildWhatsAppDeepLink`, `PREFILL_TEMPLATE_REGEX`) used consistently in Tasks 2, 4, 6.

**Risks acknowledged:**
- Two clinics with identical `name` would both go unresolved (by design — `resolveClinicByName` returns null on ambiguity). Caller falls through to LLM. Documented inline.
- User editing the prefill before sending breaks the regex match. Falls through to LLM. Acceptable.
- `PUBLIC_BASE_URL` is optional; `buildShortUrl` is only used for outbound display, not the redirect itself, so its absence is non-fatal.
