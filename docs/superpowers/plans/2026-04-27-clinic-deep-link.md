# Clinic Deep-Link Routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow each clinic to publish a unique `wa.me` deep link that auto-scopes the WhatsApp bot to that clinic, skipping the "which clinic?" turn.

**Architecture:** Parse `clinic_<slug>` token at the start of inbound messages in `handleMessage()` *before* the LLM agent loop runs. Resolve slug to clinic via Supabase, mutate `ThreadState` (set `activeClinicId`, wipe booking-scoped fields), send a deterministic welcome via `thread.post()`, and forward any residual text into the LLM. Unknown slugs surface to the LLM via a one-shot prompt flag for a friendly apology.

**Tech Stack:** Next.js 16, Vercel AI SDK, ChatSDK adapters (`@chat-adapter/state-pg`), Supabase JS client, plain `tsx` test scripts. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-04-27-clinic-deep-link-design.md`

**Order of execution:** Tasks 1 → 9 sequentially. Each task ends with a commit. Don't batch commits.

---

## File map

| Action | Path | Responsibility |
|---|---|---|
| Create | `supabase/migrations/003_clinic_slug.sql` | Add `slug` column, backfill, unique constraint. |
| Modify | `src/types.ts` | Add `unknownSlugThisTurn?: boolean` to `ThreadState`. |
| Create | `src/bot/deep-link.ts` | `parseDeepLinkToken()` + `applyDeepLink()` pure functions. |
| Create | `src/bot/clinic-resolver.ts` | `resolveClinicBySlug()` Supabase query. |
| Create | `src/bot/messages/welcome.ts` | Multi-language welcome templates + `sendWelcome()`. |
| Modify | `src/bot/prompt.ts` | Inject one-shot instruction when `state.unknownSlugThisTurn`. |
| Modify | `src/bot/index.ts` | Splice deep-link handling into top of `handleMessage()`; clear `unknownSlugThisTurn` at end of turn. |
| Create | `scripts/test-deep-link-parser.ts` | Pure parser/state-transform assertion script. |
| Create | `scripts/test-deep-link.ts` | Integration script hitting real Supabase. |
| Modify | `package.json` | Add `test:deep-link-parser` and `test:deep-link` scripts. |

---

## Task 1: DB migration — add `slug` column

**Files:**
- Create: `supabase/migrations/003_clinic_slug.sql`

- [ ] **Step 1: Create the migration file**

Create `supabase/migrations/003_clinic_slug.sql`:

```sql
-- 003_clinic_slug.sql
-- Adds a URL-safe slug to c_a_clinics for WhatsApp deep-link routing.

BEGIN;

ALTER TABLE c_a_clinics ADD COLUMN slug text;

-- Backfill from name: lowercase, strip non-alphanumeric (keep space, hyphen),
-- collapse runs of space/hyphen to single hyphen, trim, truncate to 40 chars.
UPDATE c_a_clinics
SET slug = TRIM(BOTH '-' FROM
  LEFT(
    REGEXP_REPLACE(
      REGEXP_REPLACE(LOWER(COALESCE(name, '')), '[^a-z0-9 -]', '', 'g'),
      '[\s-]+', '-', 'g'
    ),
    40
  )
);

-- Fallback for empty slugs (e.g. names with only non-Latin chars).
UPDATE c_a_clinics
SET slug = 'clinic-' || SUBSTRING(id::text, 1, 8)
WHERE slug IS NULL OR slug = '';

-- Disambiguate collisions with -2, -3, ...
WITH numbered AS (
  SELECT id, slug,
    ROW_NUMBER() OVER (PARTITION BY slug ORDER BY id) AS rn
  FROM c_a_clinics
)
UPDATE c_a_clinics c
SET slug = CASE WHEN n.rn = 1 THEN c.slug ELSE c.slug || '-' || n.rn END
FROM numbered n
WHERE c.id = n.id;

ALTER TABLE c_a_clinics ALTER COLUMN slug SET NOT NULL;
ALTER TABLE c_a_clinics ADD CONSTRAINT c_a_clinics_slug_key UNIQUE (slug);

COMMIT;
```

- [ ] **Step 2: Apply the migration**

Run from repo root:
```bash
psql "$SUPABASE_DB_URL" -f supabase/migrations/003_clinic_slug.sql
```

Expected: `BEGIN`, `ALTER TABLE`, several `UPDATE` lines, then `COMMIT`. No errors.

(If the project uses `supabase db push` or another tool, the user will run that instead — confirm with them at this step before proceeding.)

- [ ] **Step 3: Verify backfill and uniqueness**

```bash
psql "$SUPABASE_DB_URL" -c "SELECT id, name, slug FROM c_a_clinics ORDER BY slug;"
psql "$SUPABASE_DB_URL" -c "SELECT slug, COUNT(*) FROM c_a_clinics GROUP BY slug HAVING COUNT(*) > 1;"
```

Expected: every clinic has a non-empty kebab-case slug; the second query returns zero rows.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/003_clinic_slug.sql
git commit -m "feat(db): add slug column to c_a_clinics for deep-link routing"
```

---

## Task 2: Extend `ThreadState` type

**Files:**
- Modify: `src/types.ts` (in the `ThreadState` interface, around line 40–67)

- [ ] **Step 1: Add the field**

In `src/types.ts`, locate the `ThreadState` interface and add the field below `lastLocation`:

```ts
  // Most recent WhatsApp location share
  lastLocation?: {
    lat: number;
    lng: number;
    capturedAt: number;
  };

  // Deep-link routing — one-shot, cleared at end of turn.
  unknownSlugThisTurn?: boolean;
}
```

- [ ] **Step 2: Type-check**

```bash
bun run lint || bunx tsc --noEmit
```

(Whichever the project uses for type-checks. If neither, skip.)

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(bot): add unknownSlugThisTurn flag to ThreadState"
```

---

## Task 3: Pure parser + state-transform module (TDD)

**Files:**
- Create: `src/bot/deep-link.ts`
- Create: `scripts/test-deep-link-parser.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test script**

Create `scripts/test-deep-link-parser.ts`:

```ts
import "dotenv/config";
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
```

- [ ] **Step 2: Add npm script**

Edit `package.json` `scripts` section, add a new line after `test:geo`:

```json
"test:deep-link-parser": "tsx scripts/test-deep-link-parser.ts",
```

- [ ] **Step 3: Run the test (expect failure — module doesn't exist yet)**

```bash
bun run test:deep-link-parser
```

Expected: error like `Cannot find module '../src/bot/deep-link'`.

- [ ] **Step 4: Implement the module**

Create `src/bot/deep-link.ts`:

```ts
import type { ThreadState } from "../types";

const TOKEN_RE = /^clinic_([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\b\s*/i;

export type DeepLinkParse =
  | { kind: "none" }
  | { kind: "match"; slug: string; residual: string };

export function parseDeepLinkToken(text: string): DeepLinkParse {
  if (!text) return { kind: "none" };
  const m = text.match(TOKEN_RE);
  if (!m) return { kind: "none" };
  return {
    kind: "match",
    slug: m[1].toLowerCase(),
    residual: text.slice(m[0].length).trim(),
  };
}

export type DeepLinkClinic = { id: string; name: string };

/**
 * Mutates state for a deep-link arrival.
 * - Same clinic re-tap: idempotent, no wipe (preserves any in-progress booking).
 * - Different / no current clinic: wipes booking-scoped fields, sets activeClinicId.
 * - Identity-scoped fields (userId, patients, activePatientId, verified, language, phone) are preserved.
 */
export function applyDeepLink(state: ThreadState, clinic: DeepLinkClinic): void {
  if (state.activeClinicId === clinic.id) return;

  state.activeClinicId = clinic.id;
  state.activeServiceId = undefined;
  state.activeMethodId = undefined;
  state.activeDoctorId = undefined;
  state.lastSearchQuery = undefined;
  state.clinicOptions = [];
  state.serviceOptions = [];
  state.doctorOptions = [];
}
```

- [ ] **Step 5: Run the test — expect PASS**

```bash
bun run test:deep-link-parser
```

Expected: every line `PASS: ...`, ending with `All parser tests passed.`

- [ ] **Step 6: Commit**

```bash
git add src/bot/deep-link.ts scripts/test-deep-link-parser.ts package.json
git commit -m "feat(bot): add deep-link token parser and state transform"
```

---

## Task 4: Clinic resolver

**Files:**
- Create: `src/bot/clinic-resolver.ts`

- [ ] **Step 1: Implement the resolver**

Create `src/bot/clinic-resolver.ts`:

```ts
import { getSupabase } from "../lib/supabase";

export type ResolvedClinic = { id: string; name: string };

/**
 * Looks up a clinic by its URL-safe slug. Returns null if no match.
 */
export async function resolveClinicBySlug(slug: string): Promise<ResolvedClinic | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("c_a_clinics")
    .select("id, name")
    .eq("slug", slug)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[DEEP-LINK] resolver error slug=${slug}:`, error.message);
    return null;
  }
  if (!data) return null;
  return { id: data.id, name: data.name };
}
```

- [ ] **Step 2: Type-check**

```bash
bunx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/bot/clinic-resolver.ts
git commit -m "feat(bot): add resolveClinicBySlug supabase lookup"
```

---

## Task 5: Welcome templates

**Files:**
- Create: `src/bot/messages/welcome.ts`

- [ ] **Step 1: Implement the welcome module**

Create `src/bot/messages/welcome.ts`:

```ts
type Lang = "en" | "ms" | "zh";

const TEMPLATES: Record<Lang, (clinicName: string) => string> = {
  en: (n) => `Hi! You're booking at *${n}*. What service do you need today?`,
  ms: (n) => `Hai! Anda sedang menempah di *${n}*. Apakah perkhidmatan yang anda perlukan hari ini?`,
  zh: (n) => `您好！您正在 *${n}* 预约。请问您需要什么服务？`,
};

function pickLang(language: string | undefined): Lang {
  if (language === "ms" || language === "zh") return language;
  return "en";
}

export function buildWelcomeText(clinicName: string, language: string | undefined): string {
  return TEMPLATES[pickLang(language)](clinicName);
}

/**
 * Sends a deterministic clinic-named welcome via the existing thread.post helper.
 */
export async function sendWelcome(
  thread: { post: (text: string) => Promise<unknown> },
  clinic: { name: string },
  language: string | undefined,
): Promise<void> {
  const text = buildWelcomeText(clinic.name, language);
  await thread.post(text);
}
```

- [ ] **Step 2: Type-check**

```bash
bunx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/bot/messages/welcome.ts
git commit -m "feat(bot): add multi-language welcome templates for deep-link"
```

---

## Task 6: System-prompt injection for unknown slug

**Files:**
- Modify: `src/bot/prompt.ts`

- [ ] **Step 1: Update `buildSystemPrompt` to use the state**

Open `src/bot/prompt.ts`. Change the function signature to actually use the state argument (currently `_state`), and append the one-shot block at the end of the prompt.

Replace:

```ts
export function buildSystemPrompt(_state?: ThreadState): string {
```

With:

```ts
export function buildSystemPrompt(state?: ThreadState): string {
```

And just before the `return` statement, capture the unknown-slug fragment:

```ts
const unknownSlugBlock = state?.unknownSlugThisTurn
  ? `\n\n## Unrecognised clinic link\nThe user opened the bot via a deep link with an unrecognised clinic identifier. Briefly tell them you couldn't find that clinic, then continue helping them normally. Do NOT pretend the clinic exists.\n`
  : "";
```

Then append `${unknownSlugBlock}` to the end of the returned template string (just before the closing backtick).

If the existing function used the underscore convention because `state` was unused, also update any callers in this file or elsewhere that pass nothing — they continue to work since the parameter is still optional. Search for callers:

```bash
grep -rn "buildSystemPrompt(" src/
```

For each call site, ensure the current `state: ThreadState` (or equivalent) is passed in. Most should already pass it; if any pass nothing, change them to pass the local state variable.

- [ ] **Step 2: Type-check**

```bash
bunx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/bot/prompt.ts
git commit -m "feat(bot): inject unknown-slug instruction into system prompt"
```

---

## Task 7: Splice deep-link into `handleMessage`

**Files:**
- Modify: `src/bot/index.ts` (around `handleMessage`, line 514+)

- [ ] **Step 1: Add imports at top of file**

Add to the import block at the top of `src/bot/index.ts`:

```ts
import { parseDeepLinkToken, applyDeepLink } from "./deep-link";
import { resolveClinicBySlug } from "./clinic-resolver";
import { sendWelcome } from "./messages/welcome";
```

- [ ] **Step 2: Identify the inbound text**

Inside `handleMessage`, after the existing `state` initialisation block (around the line that ends `verifyAttempts: 0,\n  };`), capture the inbound text. The exact field name depends on the `message` shape — check the existing code that already reads it (search for `message.text`, `message.body`, or similar near the top of `handleMessage`). Use that same accessor.

For the rest of this task, the inbound text variable is referred to as `incomingText`. If existing code already extracts it, reuse that variable; otherwise add:

```ts
const incomingText: string =
  typeof message?.text === "string" ? message.text : "";
```

- [ ] **Step 3: Insert the deep-link block**

Immediately after `state` is loaded and `incomingText` is available, before any user_lookup / agent loop calls, insert:

```ts
// --- Deep-link routing ---
const deepLink = parseDeepLinkToken(incomingText);
if (deepLink.kind === "match") {
  const clinic = await resolveClinicBySlug(deepLink.slug);
  if (clinic) {
    const switchedFrom = state.activeClinicId;
    applyDeepLink(state, clinic);
    await thread.setState(state);
    console.log(
      `[DEEP-LINK] event=deep_link slug=${deepLink.slug} resolved=true clinicId=${clinic.id} switchedFrom=${switchedFrom ?? "none"}`,
    );
    await sendWelcome(thread, clinic, state.language);
    if (!deepLink.residual) {
      return; // turn ends; LLM not invoked
    }
    // Forward residual into the LLM agent loop.
    message = { ...message, text: deepLink.residual };
  } else {
    state.unknownSlugThisTurn = true;
    await thread.setState(state);
    console.log(`[DEEP-LINK] event=deep_link slug=${deepLink.slug} resolved=false`);
    if (deepLink.residual) {
      message = { ...message, text: deepLink.residual };
    }
    // Fall through to LLM with one-shot prompt flag set.
  }
}
// --- end deep-link routing ---
```

- [ ] **Step 4: Clear `unknownSlugThisTurn` at end of turn**

At the end of `handleMessage`, after the LLM agent loop finishes and any final `thread.post` / `thread.setState` calls, add:

```ts
if (state.unknownSlugThisTurn) {
  state.unknownSlugThisTurn = undefined;
  await thread.setState(state);
}
```

Place this just before the function's final `return` (or final closing brace if there is no explicit return).

- [ ] **Step 5: Verify `buildSystemPrompt` is called with state**

In `src/bot/index.ts`, find the call to `buildSystemPrompt(...)` (around line 657). Confirm it is invoked as `buildSystemPrompt(state)`. If it is currently called with no argument, change it to pass `state`.

- [ ] **Step 6: Type-check + lint**

```bash
bunx tsc --noEmit
bun run lint
```

Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/bot/index.ts
git commit -m "feat(bot): handle clinic deep-link tokens before LLM agent loop"
```

---

## Task 8: Integration test script

**Files:**
- Create: `scripts/test-deep-link.ts`
- Modify: `package.json`

This script asserts the resolver against real Supabase. It does **not** invoke the LLM — that's the smoke test (Task 9). It needs at least one real clinic with a known slug; we'll use the first clinic in the table.

- [ ] **Step 1: Add npm script**

Edit `package.json`, add another line under `scripts`:

```json
"test:deep-link": "tsx scripts/test-deep-link.ts",
```

- [ ] **Step 2: Create the script**

Create `scripts/test-deep-link.ts`:

```ts
import "dotenv/config";
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
```

- [ ] **Step 3: Run the script**

Ensure `.env` has `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Then:

```bash
bun run test:deep-link
```

Expected: every assertion `PASS`, ending with `All integration tests passed.`

- [ ] **Step 4: Commit**

```bash
git add scripts/test-deep-link.ts package.json
git commit -m "test(bot): integration script for deep-link resolver and state"
```

---

## Task 9: Manual smoke test on dev WhatsApp

This task does not produce a commit — it's a verification gate before declaring the feature done.

- [ ] **Step 1: Pick a known slug**

```bash
psql "$SUPABASE_DB_URL" -c "SELECT name, slug FROM c_a_clinics LIMIT 5;"
```

Note one slug, e.g. `acme-dental`.

- [ ] **Step 2: Start dev server**

```bash
bun run dev
```

Wait for `Ready` log line.

- [ ] **Step 3: Valid slug, no residual**

From the dev WhatsApp test number, send: `clinic_acme-dental`

Expected:
- Bot replies once with the welcome template (`Hi! You're booking at *<clinic name>*. What service do you need today?`).
- Logs show `[DEEP-LINK] event=deep_link slug=acme-dental resolved=true clinicId=...`.
- No LLM invocation in this turn (no `[BOT]` agent-loop logs).

- [ ] **Step 4: Valid slug + residual**

Send: `clinic_acme-dental I need a dental cleaning`

Expected:
- Welcome message arrives first.
- Then the LLM proceeds with service search for "dental cleaning" — clinic-pick step is skipped because `activeClinicId` is set.

- [ ] **Step 5: Different-clinic switch mid-flow**

Pick a second slug from the DB (e.g. `beta-clinic`). After the previous turn, send: `clinic_beta-clinic`

Expected:
- Welcome for the new clinic.
- Logs show `switchedFrom=<previous-clinic-id>`.
- `activeServiceId` etc. are wiped — verify by sending the next message and confirming the bot asks "what service?" rather than continuing the previous booking.

- [ ] **Step 6: Same-clinic re-tap mid-booking**

Get into a partially-completed booking at `acme-dental`. Send: `clinic_acme-dental` again.

Expected:
- Welcome arrives.
- Booking selections (service/method) preserved — verify by asking the bot "what's my next step?" or sending a follow-up that should pick up where you left off.

- [ ] **Step 7: Unknown slug**

Send: `clinic_does-not-exist`

Expected:
- Logs show `resolved=false`.
- LLM apologises in the user's language ("I couldn't find that clinic — what service are you looking for?") and continues normally.
- No state mutation: `activeClinicId` unchanged.

- [ ] **Step 8: Token mid-message ignored**

Send: `hi clinic_acme-dental I'd like to book`

Expected:
- Treated as plain chat. No deep-link log line. LLM responds normally.

- [ ] **Step 9: Document in observation log (if applicable)**

If the team logs verified features, add an entry summarising the smoke test pass.

---

## Done

After Task 9 passes end-to-end, the feature is complete. Distribute clinic URLs to operators in the form:

```
https://wa.me/<bot_phone>?text=clinic_<slug>
```

(The slug for each clinic is in `c_a_clinics.slug`.)
