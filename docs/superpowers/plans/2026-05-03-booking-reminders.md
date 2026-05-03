# Booking Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add WhatsApp-template-compliant booking reminders (T-24h, T-2h, doc-ready) with per-clinic opt-out, recompute-on-change scheduling, and a Vercel Cron sweeper.

**Architecture:** Two new Postgres tables (`reminder_jobs` queue + `reminder_optouts`). `recomputeReminders(bookingId)` is called from booking write paths and replaces all unsent rows for a booking. A `*/5 * * * *` Vercel Cron route sweeps due rows, re-validates each, sends a Meta WhatsApp template, and classifies failures. Inbound template button taps short-circuit before the AI tool loop via a new `parseButtonPayload`.

**Tech Stack:** Next.js 16 (Vercel), Supabase Postgres, Meta Cloud API v21.0, AI SDK tool loop, `tsx` test scripts.

**Spec:** `docs/superpowers/specs/2026-05-03-booking-reminders-design.md`

---

## File Structure

| File | Status | Purpose |
|---|---|---|
| `supabase/migrations/004_reminders.sql` | new | `reminder_jobs` + `reminder_optouts` tables |
| `src/lib/time.ts` | new | `formatTimeMYT(date)` — Asia/Kuala_Lumpur formatter |
| `src/lib/whatsapp.ts` | modify | Add `sendTemplate(...)` + Meta error classifier |
| `src/lib/reminders/optout.ts` | new | `isMuted`, `muteClinic`, `unmuteClinic`, `muteGlobally`, `listMutedClinics` |
| `src/lib/reminders/booking-loader.ts` | new | `getBookingForReminder(bookingId)` — joined view used by scheduler + sender |
| `src/lib/reminders/templates.ts` | new | Template name registry, `buildComponents()` |
| `src/lib/reminders/scheduler.ts` | new | `recomputeReminders`, `enqueueDocReady`, `reconcileDocReady` |
| `src/lib/reminders/sender.ts` | new | Cron sweep loop, `processJob`, retry/failure handling |
| `src/lib/reminders/types.ts` | new | Shared types (`ReminderKind`, `ReminderJob`, `BookingForReminder`) |
| `src/app/api/cron/reminders/route.ts` | new | Vercel Cron entry (auth via `CRON_SECRET`) |
| `src/bot/messages/button-router.ts` | new | `parseButtonPayload`, `handleButtonAction` |
| `src/bot/tools/manage-optouts.ts` | new | AI tool `manage_reminder_optouts` |
| `src/bot/tools/booking.ts` | modify | Call `recomputeReminders` after create / reschedule / cancel |
| `src/bot/tools/index.ts` | modify | Register `manage_reminder_optouts` |
| `src/bot/index.ts` | modify | Slot `parseButtonPayload` into receive flow |
| `src/types.ts` | modify | Extend `ThreadState` with reminder thread fields |
| `vercel.json` | new (or modify) | `*/5` cron schedule |
| `.env.example`, `README.md` | modify | Add `CRON_SECRET` |
| `scripts/test-reminder-time.ts` | new | Time formatter tests |
| `scripts/test-reminder-templates.ts` | new | Template selection / component build tests |
| `scripts/test-error-classifier.ts` | new | Meta error code → kind tests |
| `scripts/test-button-router.ts` | new | Payload parser + dispatch tests |
| `scripts/test-reminder-scheduler.ts` | new | Schedule math + status gates (mocked DB) |
| `scripts/test-reminder-optout.ts` | new | Mute / unmute / scope tests (real DB or mock) |
| `scripts/test-reminder-sender.ts` | new | Sweep simulation, retry classification (mocked Meta) |
| `package.json` | modify | New `test:reminder-*` scripts + composite `test:reminders` |
| `docs/bot-test-smoke.md` | modify | 6 reminder smoke scenarios |

---

## Phase 1 — Foundation

Database tables, time formatter, template-send helper. Standalone, no dependencies on later phases.

### Task 1.1: Migration `004_reminders.sql`

**Files:**
- Create: `supabase/migrations/004_reminders.sql`

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/004_reminders.sql`:

```sql
-- Booking reminders: queue + per-clinic opt-outs.

CREATE TABLE IF NOT EXISTS reminder_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    text NOT NULL,
  user_id       text NOT NULL,
  clinic_id     text NOT NULL,
  phone         text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('appt_24h','appt_2h','doc_ready')),
  template_name text NOT NULL,
  template_vars jsonb NOT NULL,
  send_at       timestamptz NOT NULL,
  sent_at       timestamptz,
  attempts      int NOT NULL DEFAULT 0,
  last_error    text,
  failed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Sweeper hot path. Partial index keeps it small.
CREATE INDEX IF NOT EXISTS reminder_jobs_due_idx
  ON reminder_jobs (send_at)
  WHERE sent_at IS NULL AND failed_at IS NULL;

-- Recompute path: delete-by-booking_id.
CREATE INDEX IF NOT EXISTS reminder_jobs_booking_idx
  ON reminder_jobs (booking_id);

-- (booking_id, kind) is unique per pending row to defend against double-enqueue races.
CREATE UNIQUE INDEX IF NOT EXISTS reminder_jobs_pending_unique
  ON reminder_jobs (booking_id, kind)
  WHERE sent_at IS NULL AND failed_at IS NULL;


CREATE TABLE IF NOT EXISTS reminder_optouts (
  phone     text NOT NULL,
  clinic_id text,                           -- NULL = global mute (all clinics)
  muted_at  timestamptz NOT NULL DEFAULT now(),
  source    text NOT NULL CHECK (source IN ('button','command','auto_block')),
  PRIMARY KEY (phone, clinic_id)
);
```

- [ ] **Step 2: Apply the migration to local/dev Supabase**

Run (from project root):
```bash
# If using Supabase CLI locally:
supabase db push
# Or paste the SQL into the Supabase Studio SQL editor for the dev project.
```
Expected: both tables present in `public` schema, indices listed in `pg_indexes`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/004_reminders.sql
git commit -m "feat(bot): add reminder_jobs + reminder_optouts tables"
```

---

### Task 1.2: Time formatter `src/lib/time.ts`

**Files:**
- Create: `src/lib/time.ts`
- Test: `scripts/test-reminder-time.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-reminder-time.ts`:

```ts
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
```

- [ ] **Step 2: Add npm script and run to verify failure**

Edit `package.json` `scripts`:
```json
"test:reminder-time": "tsx --tsconfig tsconfig.json scripts/test-reminder-time.ts",
```

Run: `bun run test:reminder-time`
Expected: FAIL — module not found / `formatTimeMYT` undefined.

- [ ] **Step 3: Implement formatter**

Create `src/lib/time.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun run test:reminder-time`
Expected: All 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/time.ts scripts/test-reminder-time.ts package.json
git commit -m "feat(bot): add formatTimeMYT for reminder timestamps"
```

---

### Task 1.3: Meta error classifier + `sendTemplate` helper

**Files:**
- Modify: `src/lib/whatsapp.ts`
- Test: `scripts/test-error-classifier.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-error-classifier.ts`:

```ts
import "dotenv/config";
import { classifyMetaError } from "../src/lib/whatsapp";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else { console.error(`FAIL: ${label}`); failures++; }
}

async function main() {
  // Permanent block codes
  for (const code of [131026, 131047, 131049]) {
    const k = classifyMetaError({ http: 400, metaCode: code, body: "{}" });
    assert(k.kind === "permanent_block", `meta code ${code} -> permanent_block`);
  }

  // Permanent template family (132xxx)
  for (const code of [132000, 132001, 132012, 132999]) {
    const k = classifyMetaError({ http: 400, metaCode: code, body: "{}" });
    assert(k.kind === "permanent_template", `meta code ${code} -> permanent_template`);
  }

  // Transient: 5xx + network
  assert(
    classifyMetaError({ http: 500, metaCode: undefined, body: "" }).kind === "transient",
    "http 500 -> transient",
  );
  assert(
    classifyMetaError({ http: 0, metaCode: undefined, body: "network timeout" }).kind === "transient",
    "network error (http=0) -> transient",
  );

  // Unknown 4xx with no Meta code -> transient (fail-safe)
  assert(
    classifyMetaError({ http: 400, metaCode: undefined, body: "{}" }).kind === "transient",
    "unknown 4xx no code -> transient (fail-safe)",
  );

  if (failures > 0) { console.error(`\n${failures} failures`); process.exit(1); }
  console.log("\nAll tests passed");
}

main();
```

Add to `package.json`:
```json
"test:error-classifier": "tsx --tsconfig tsconfig.json scripts/test-error-classifier.ts",
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:error-classifier`
Expected: FAIL — `classifyMetaError` not exported.

- [ ] **Step 3: Implement classifier + sendTemplate**

Append to `src/lib/whatsapp.ts` (after existing helpers):

```ts
// ---------- Templates ----------

export type TemplateSendKind =
  | "ok"
  | "transient"
  | "permanent_block"
  | "permanent_template";

export interface TemplateSendResult {
  kind: TemplateSendKind;
  detail?: string;
  metaCode?: number;
}

export interface MetaErrorInput {
  http: number;            // HTTP status, 0 if network error
  metaCode?: number;       // Meta error.code from response body
  body: string;            // raw response body text
}

const PERMANENT_BLOCK_CODES = new Set<number>([131026, 131047, 131049]);

export function classifyMetaError(e: MetaErrorInput): TemplateSendResult {
  if (e.http >= 200 && e.http < 300) return { kind: "ok" };
  if (e.metaCode && PERMANENT_BLOCK_CODES.has(e.metaCode)) {
    return { kind: "permanent_block", metaCode: e.metaCode, detail: e.body };
  }
  if (e.metaCode && e.metaCode >= 132000 && e.metaCode < 133000) {
    return { kind: "permanent_template", metaCode: e.metaCode, detail: e.body };
  }
  if (e.http >= 500 || e.http === 0) {
    return { kind: "transient", detail: e.body };
  }
  // Unknown 4xx: fail-safe transient, will retry up to attempts cap.
  return { kind: "transient", detail: e.body, metaCode: e.metaCode };
}

export interface TemplateComponent {
  type: "body" | "button" | "header";
  sub_type?: "quick_reply" | "url";
  index?: string;
  parameters?: Array<
    | { type: "text"; text: string }
    | { type: "payload"; payload: string }
  >;
}

export async function sendTemplate(args: {
  to: string;
  name: string;
  lang: string;
  components: TemplateComponent[];
}): Promise<TemplateSendResult> {
  if (isTestMode()) {
    captureQueue.push({
      kind: "buttons", // re-use existing capture shape for snapshotting
      to: args.to,
      body: `template:${args.name}`,
      options: args.components
        .filter((c) => c.type === "button")
        .map((c) => ({
          id: (c.parameters?.[0] as any)?.payload ?? "",
          title: "(template button)",
        })),
    });
    return { kind: "ok" };
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    return { kind: "transient", detail: "missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN" };
  }

  let res: Response;
  try {
    res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: args.to,
        type: "template",
        template: {
          name: args.name,
          language: { code: args.lang },
          components: args.components,
        },
      }),
    });
  } catch (err) {
    return classifyMetaError({ http: 0, metaCode: undefined, body: String(err) });
  }

  const body = await res.text().catch(() => "");
  let metaCode: number | undefined;
  try {
    const parsed = JSON.parse(body);
    metaCode = parsed?.error?.code;
  } catch { /* non-JSON response */ }

  return classifyMetaError({ http: res.status, metaCode, body });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun run test:error-classifier`
Expected: All cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp.ts scripts/test-error-classifier.ts package.json
git commit -m "feat(bot): add sendTemplate helper + Meta error classifier"
```

---

## Phase 2 — Opt-Out Module

Sits below scheduler and sender. Pure DB CRUD with one slightly-tricky `isMuted` query (clinic-specific OR global).

### Task 2.1: `src/lib/reminders/optout.ts`

**Files:**
- Create: `src/lib/reminders/optout.ts`
- Test: `scripts/test-reminder-optout.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-reminder-optout.ts`:

```ts
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
```

Add to `package.json`:
```json
"test:reminder-optout": "tsx --tsconfig tsconfig.json scripts/test-reminder-optout.ts",
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:reminder-optout`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement opt-out module**

Create `src/lib/reminders/optout.ts`:

```ts
import { getSupabase } from "../supabase";

export type OptoutSource = "button" | "command" | "auto_block";

export async function isMuted(phone: string, clinicId: string): Promise<boolean> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("reminder_optouts")
    .select("clinic_id")
    .eq("phone", phone)
    .or(`clinic_id.eq.${clinicId},clinic_id.is.null`)
    .limit(1);
  if (error) {
    console.error("[REMINDER] isMuted error:", error.message);
    return false; // fail-open on read error so reminders aren't silently dropped
  }
  return (data?.length ?? 0) > 0;
}

export async function muteClinic(
  phone: string,
  clinicId: string,
  source: OptoutSource,
): Promise<void> {
  const sb = getSupabase();
  await sb
    .from("reminder_optouts")
    .upsert(
      { phone, clinic_id: clinicId, source },
      { onConflict: "phone,clinic_id" },
    );
}

export async function muteGlobally(
  phone: string,
  source: OptoutSource = "auto_block",
): Promise<void> {
  const sb = getSupabase();
  await sb
    .from("reminder_optouts")
    .upsert(
      { phone, clinic_id: null, source },
      { onConflict: "phone,clinic_id" },
    );
}

export async function unmuteClinic(
  phone: string,
  clinicId: string,
  opts: { onlyButtonSource?: boolean } = {},
): Promise<void> {
  const sb = getSupabase();
  let q = sb.from("reminder_optouts")
    .delete()
    .eq("phone", phone)
    .eq("clinic_id", clinicId);
  if (opts.onlyButtonSource) q = q.eq("source", "button");
  await q;
}

/**
 * Returns clinic_ids the phone has muted via user-initiated actions
 * (button or command). Excludes auto_block / global mutes — those are
 * technical and not user-actionable from the bot UI.
 */
export async function listMutedClinics(phone: string): Promise<string[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("reminder_optouts")
    .select("clinic_id, source")
    .eq("phone", phone)
    .not("clinic_id", "is", null)
    .in("source", ["button", "command"]);
  if (error) return [];
  return (data ?? []).map((r) => r.clinic_id as string);
}
```

- [ ] **Step 4: Run test (requires dev DB)**

Run: `bun run test:reminder-optout`
Expected: all assertions pass. Test cleans up its own rows.

If running against a DB without the migration applied, this fails with "relation reminder_optouts does not exist" — apply Task 1.1 first.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reminders/optout.ts scripts/test-reminder-optout.ts package.json
git commit -m "feat(bot): add reminder opt-out module (per-clinic + global)"
```

---

## Phase 3 — Templates + Booking Loader

These two modules are pure (templates) or read-only (loader). Building them before the scheduler keeps scheduler tests focused on math.

### Task 3.1: Shared types + booking loader

**Files:**
- Create: `src/lib/reminders/types.ts`
- Create: `src/lib/reminders/booking-loader.ts`

- [ ] **Step 1: Write types**

Create `src/lib/reminders/types.ts`:

```ts
export type ReminderKind = "appt_24h" | "appt_2h" | "doc_ready";

export interface BookingForReminder {
  id: string;
  user_id: string;
  clinic_id: string;
  doctor_name: string | null;     // null when no doctor selection at clinic
  patient_name: string;            // best display name we have for the user/patient
  clinic_name: string;
  phone: string;                   // E.164 without "+"
  status: string;                  // c_s_bookings.status
  appointment_at: Date;            // composed from new_date+new_time OR original_date+original_time
}

export interface ReminderJobRow {
  id: string;
  booking_id: string;
  user_id: string;
  clinic_id: string;
  phone: string;
  kind: ReminderKind;
  template_name: string;
  template_vars: Record<string, string>;
  send_at: string;                 // ISO timestamptz
  sent_at: string | null;
  attempts: number;
  last_error: string | null;
  failed_at: string | null;
}
```

- [ ] **Step 2: Implement booking loader**

Create `src/lib/reminders/booking-loader.ts`:

```ts
import { getSupabase } from "../supabase";
import type { BookingForReminder } from "./types";

/**
 * Loads a c_s_bookings row joined with the data the reminder layer needs:
 * - clinic (via doctor_id -> c_a_doctors.clinic_id -> c_a_clinics)
 * - doctor name
 * - user phone (via whatsapp_users.whatsapp_number)
 *
 * Returns null if the booking doesn't exist or is missing required relations.
 *
 * Composes appointment_at from new_date+new_time when present (rescheduled),
 * else original_date+original_time.
 */
export async function getBookingForReminder(
  bookingId: string,
): Promise<BookingForReminder | null> {
  const sb = getSupabase();

  const { data: b, error } = await sb
    .from("c_s_bookings")
    .select(`
      id, user_id, status,
      original_date, original_time, new_date, new_time,
      doctor:doctor_id(id, name, clinic_id)
    `)
    .eq("id", bookingId)
    .maybeSingle();

  if (error || !b) return null;
  const doctor = b.doctor as { id: string; name: string; clinic_id: string } | null;
  if (!doctor?.clinic_id) return null;

  const [{ data: clinic }, { data: user }] = await Promise.all([
    sb.from("c_a_clinics").select("id, name").eq("id", doctor.clinic_id).maybeSingle(),
    sb.from("whatsapp_users")
      .select("id, whatsapp_number, name")
      .eq("id", b.user_id)
      .maybeSingle(),
  ]);
  if (!clinic || !user?.whatsapp_number) return null;

  const date = b.new_date ?? b.original_date;     // YYYY-MM-DD
  const time = b.new_time ?? b.original_time;     // HH:MM:SS or HH:MM
  // Treat the stored date+time as Asia/Kuala_Lumpur local (UTC+8), no DST.
  const apptIso = `${date}T${normalizeTime(time)}+08:00`;
  const appointment_at = new Date(apptIso);

  return {
    id: b.id,
    user_id: b.user_id,
    clinic_id: doctor.clinic_id,
    doctor_name: doctor.name ?? null,
    patient_name: (user.name as string) ?? "there",
    clinic_name: clinic.name as string,
    phone: stripPlus(user.whatsapp_number as string),
    status: b.status as string,
    appointment_at,
  };
}

function normalizeTime(t: string): string {
  // "HH:MM" -> "HH:MM:00", "HH:MM:SS" -> unchanged
  return t.length === 5 ? `${t}:00` : t;
}

function stripPlus(p: string): string {
  return p.startsWith("+") ? p.slice(1) : p;
}
```

- [ ] **Step 3: Commit (no test yet — covered indirectly by scheduler/sender integration tests)**

```bash
git add src/lib/reminders/types.ts src/lib/reminders/booking-loader.ts
git commit -m "feat(bot): add reminder types + booking loader"
```

---

### Task 3.2: Template registry + component builder

**Files:**
- Create: `src/lib/reminders/templates.ts`
- Test: `scripts/test-reminder-templates.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-reminder-templates.ts`:

```ts
import "dotenv/config";
import {
  pickTemplateName,
  buildTemplateVars,
  buildComponents,
} from "../src/lib/reminders/templates";
import type { BookingForReminder } from "../src/lib/reminders/types";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else { console.error(`FAIL: ${label}`); failures++; }
}

const baseBooking: BookingForReminder = {
  id: "bk_1",
  user_id: "u_1",
  clinic_id: "cl_1",
  doctor_name: "Tan",
  patient_name: "Ali",
  clinic_name: "One Care Clinic",
  phone: "60123456789",
  status: "confirmed",
  appointment_at: new Date("2026-05-05T02:30:00Z"), // 10:30 AM MYT Tue 5 May
};

async function main() {
  // pickTemplateName
  assert(
    pickTemplateName("appt_24h", baseBooking) === "appt_24h_with_doctor",
    "appt_24h with doctor selects with_doctor variant",
  );
  assert(
    pickTemplateName("appt_24h", { ...baseBooking, doctor_name: null }) === "appt_24h_no_doctor",
    "appt_24h without doctor selects no_doctor variant",
  );
  assert(
    pickTemplateName("doc_ready", baseBooking) === "doc_ready",
    "doc_ready has single template",
  );

  // buildTemplateVars
  const v24 = buildTemplateVars("appt_24h", baseBooking);
  assert(
    v24.patient_name === "Ali" &&
      v24.clinic_name === "One Care Clinic" &&
      v24.time_string === "10:30 AM, Tue 5 May" &&
      v24.doctor_name === "Tan",
    "appt_24h_with_doctor vars include doctor_name",
  );
  const v24nd = buildTemplateVars("appt_24h", { ...baseBooking, doctor_name: null });
  assert(
    v24nd.doctor_name === undefined,
    "no_doctor variant omits doctor_name from vars",
  );

  // doc_ready vars require doc_type — passed via overrides
  const vDoc = buildTemplateVars("doc_ready", baseBooking, { doc_type: "medical certificate" });
  assert(
    vDoc.doc_type === "medical certificate" && vDoc.clinic_name === "One Care Clinic",
    "doc_ready vars include doc_type override",
  );

  // buildComponents — appt_24h_with_doctor
  const comps = buildComponents({
    template_name: "appt_24h_with_doctor",
    template_vars: v24,
    booking_id: "bk_1",
    clinic_id: "cl_1",
  });
  // 1 body + 2 buttons
  assert(comps.length === 3, "appt_24h_with_doctor produces 3 components");
  const body = comps.find((c) => c.type === "body");
  assert(
    !!body && body.parameters?.length === 4,
    "body has 4 text params for with_doctor variant",
  );
  const buttons = comps.filter((c) => c.type === "button");
  assert(buttons.length === 2, "two quick-reply buttons present");
  assert(
    (buttons[0].parameters?.[0] as any).payload === "view_booking:bk_1",
    "primary button payload is view_booking:<id>",
  );
  assert(
    (buttons[1].parameters?.[0] as any).payload === "mute_clinic:cl_1",
    "secondary button payload is mute_clinic:<id>",
  );

  // buildComponents — doc_ready uses get_doc payload
  const docComps = buildComponents({
    template_name: "doc_ready",
    template_vars: vDoc,
    booking_id: "bk_1",
    clinic_id: "cl_1",
  });
  const docBtns = docComps.filter((c) => c.type === "button");
  assert(
    (docBtns[0].parameters?.[0] as any).payload === "get_doc:bk_1",
    "doc_ready primary button payload is get_doc:<id>",
  );

  if (failures > 0) { console.error(`\n${failures} failures`); process.exit(1); }
  console.log("\nAll tests passed");
}

main();
```

Add to `package.json`:
```json
"test:reminder-templates": "tsx --tsconfig tsconfig.json scripts/test-reminder-templates.ts",
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:reminder-templates`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement templates module**

Create `src/lib/reminders/templates.ts`:

```ts
import { formatTimeMYT } from "../time";
import type { TemplateComponent } from "../whatsapp";
import type { BookingForReminder, ReminderKind } from "./types";

export function pickTemplateName(
  kind: ReminderKind,
  booking: Pick<BookingForReminder, "doctor_name">,
): string {
  if (kind === "doc_ready") return "doc_ready";
  const variant = booking.doctor_name ? "with_doctor" : "no_doctor";
  return `${kind}_${variant}`;
}

export function buildTemplateVars(
  kind: ReminderKind,
  booking: BookingForReminder,
  overrides: Partial<{ doc_type: string }> = {},
): Record<string, string> {
  if (kind === "doc_ready") {
    return {
      patient_name: booking.patient_name,
      doc_type: overrides.doc_type ?? "document",
      clinic_name: booking.clinic_name,
    };
  }
  const vars: Record<string, string> = {
    patient_name: booking.patient_name,
    clinic_name: booking.clinic_name,
    time_string: formatTimeMYT(booking.appointment_at),
  };
  if (booking.doctor_name) vars.doctor_name = booking.doctor_name;
  return vars;
}

interface BuildArgs {
  template_name: string;
  template_vars: Record<string, string>;
  booking_id: string;
  clinic_id: string;
}

export function buildComponents(args: BuildArgs): TemplateComponent[] {
  const v = args.template_vars;
  let bodyParams: string[];
  let primaryPayload: string;

  switch (args.template_name) {
    case "appt_24h_with_doctor":
    case "appt_2h_with_doctor":
      bodyParams = [v.patient_name, v.clinic_name, v.time_string, v.doctor_name];
      primaryPayload = `view_booking:${args.booking_id}`;
      break;
    case "appt_24h_no_doctor":
    case "appt_2h_no_doctor":
      bodyParams = [v.patient_name, v.clinic_name, v.time_string];
      primaryPayload = `view_booking:${args.booking_id}`;
      break;
    case "doc_ready":
      bodyParams = [v.patient_name, v.doc_type, v.clinic_name];
      primaryPayload = `get_doc:${args.booking_id}`;
      break;
    default:
      throw new Error(`Unknown template: ${args.template_name}`);
  }

  return [
    {
      type: "body",
      parameters: bodyParams.map((t) => ({ type: "text", text: t })),
    },
    {
      type: "button",
      sub_type: "quick_reply",
      index: "0",
      parameters: [{ type: "payload", payload: primaryPayload }],
    },
    {
      type: "button",
      sub_type: "quick_reply",
      index: "1",
      parameters: [{ type: "payload", payload: `mute_clinic:${args.clinic_id}` }],
    },
  ];
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun run test:reminder-templates`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reminders/templates.ts scripts/test-reminder-templates.ts package.json
git commit -m "feat(bot): add reminder template registry + component builder"
```

---

## Phase 4 — Scheduler

`recomputeReminders` is pure on top of the loader + opt-out module. Tests use a fake `loadBooking` injection so we don't need a real DB row for math cases.

### Task 4.1: Scheduler module with injectable loader

**Files:**
- Create: `src/lib/reminders/scheduler.ts`
- Test: `scripts/test-reminder-scheduler.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-reminder-scheduler.ts`:

```ts
import "dotenv/config";
import { computeReminderJobs } from "../src/lib/reminders/scheduler";
import type { BookingForReminder } from "../src/lib/reminders/types";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else { console.error(`FAIL: ${label}`); failures++; }
}

function bookingAt(offsetMs: number, overrides: Partial<BookingForReminder> = {}): BookingForReminder {
  return {
    id: "bk_x",
    user_id: "u_1",
    clinic_id: "cl_1",
    doctor_name: "Tan",
    patient_name: "Ali",
    clinic_name: "One Care",
    phone: "60111",
    status: "confirmed",
    appointment_at: new Date(Date.now() + offsetMs),
    ...overrides,
  };
}

async function main() {
  const ms = (h: number) => h * 3600 * 1000;

  // 48h out -> both T-24h and T-2h scheduled
  {
    const jobs = computeReminderJobs(bookingAt(ms(48)));
    assert(jobs.length === 2, "48h out -> 2 jobs");
    assert(
      jobs.some((j) => j.kind === "appt_24h") && jobs.some((j) => j.kind === "appt_2h"),
      "48h out -> kinds appt_24h + appt_2h",
    );
    assert(jobs[0].template_name.endsWith("_with_doctor"), "with-doctor template selected");
  }

  // 3h out -> only T-2h
  {
    const jobs = computeReminderJobs(bookingAt(ms(3)));
    assert(jobs.length === 1 && jobs[0].kind === "appt_2h", "3h out -> only T-2h");
  }

  // 1h out -> 0 (under buffer for T-2h, T-24h past)
  {
    const jobs = computeReminderJobs(bookingAt(ms(1)));
    assert(jobs.length === 0, "1h out -> 0 jobs");
  }

  // status != confirmed -> 0
  {
    const jobs = computeReminderJobs(bookingAt(ms(48), { status: "pending" }));
    assert(jobs.length === 0, "pending -> 0 jobs");
  }
  {
    const jobs = computeReminderJobs(bookingAt(ms(48), { status: "cancelled" }));
    assert(jobs.length === 0, "cancelled -> 0 jobs");
  }
  {
    const jobs = computeReminderJobs(bookingAt(ms(48), { status: "reschedule_pending" }));
    assert(jobs.length === 0, "reschedule_pending -> 0 jobs");
  }

  // No doctor -> no_doctor template, 3 vars
  {
    const jobs = computeReminderJobs(bookingAt(ms(48), { doctor_name: null }));
    assert(
      jobs.every((j) => j.template_name.endsWith("_no_doctor")),
      "no doctor -> no_doctor templates",
    );
    assert(
      jobs.every((j) => j.template_vars.doctor_name === undefined),
      "no_doctor template_vars omit doctor_name",
    );
  }

  // send_at math: T-24h within 1s of (apptAt - 24h)
  {
    const b = bookingAt(ms(48));
    const jobs = computeReminderJobs(b);
    const t24 = jobs.find((j) => j.kind === "appt_24h")!;
    const diff = Math.abs(t24.send_at.getTime() - (b.appointment_at.getTime() - ms(24)));
    assert(diff < 1000, "T-24h send_at = appointment_at - 24h");
  }

  if (failures > 0) { console.error(`\n${failures} failures`); process.exit(1); }
  console.log("\nAll tests passed");
}

main();
```

Add to `package.json`:
```json
"test:reminder-scheduler": "tsx --tsconfig tsconfig.json scripts/test-reminder-scheduler.ts",
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:reminder-scheduler`
Expected: FAIL — `computeReminderJobs` not exported.

- [ ] **Step 3: Implement scheduler**

Create `src/lib/reminders/scheduler.ts`:

```ts
import { getSupabase } from "../supabase";
import { getBookingForReminder } from "./booking-loader";
import { isMuted } from "./optout";
import { pickTemplateName, buildTemplateVars } from "./templates";
import type { BookingForReminder, ReminderKind } from "./types";

const BUFFER_MS = 5 * 60 * 1000;
const HOUR_MS = 3600 * 1000;

interface ComputedJob {
  booking_id: string;
  user_id: string;
  clinic_id: string;
  phone: string;
  kind: ReminderKind;
  template_name: string;
  template_vars: Record<string, string>;
  send_at: Date;
}

/**
 * Pure scheduling math. No DB writes, no opt-out check.
 * Returns 0..2 jobs (appt_24h, appt_2h) given a confirmed booking.
 * doc_ready jobs are enqueued separately via enqueueDocReady.
 */
export function computeReminderJobs(booking: BookingForReminder): ComputedJob[] {
  if (booking.status !== "confirmed") return [];

  const apptAt = booking.appointment_at;
  const now = Date.now();
  const out: ComputedJob[] = [];

  for (const [kind, offsetH] of [["appt_24h", 24], ["appt_2h", 2]] as const) {
    const sendAt = new Date(apptAt.getTime() - offsetH * HOUR_MS);
    if (sendAt.getTime() <= now + BUFFER_MS) continue;
    const template_name = pickTemplateName(kind, booking);
    const template_vars = buildTemplateVars(kind, booking);
    out.push({
      booking_id: booking.id,
      user_id: booking.user_id,
      clinic_id: booking.clinic_id,
      phone: booking.phone,
      kind,
      template_name,
      template_vars,
      send_at: sendAt,
    });
  }
  return out;
}

/**
 * Recompute reminders for a booking after any state change.
 * Deletes all unsent rows for the booking and re-inserts current intent.
 * No-ops if booking missing, not confirmed, or muted.
 */
export async function recomputeReminders(bookingId: string): Promise<void> {
  const sb = getSupabase();
  // 1. Delete pending rows (recompute model — see spec).
  await sb
    .from("reminder_jobs")
    .delete()
    .eq("booking_id", bookingId)
    .is("sent_at", null);

  const booking = await getBookingForReminder(bookingId);
  if (!booking) return;
  if (await isMuted(booking.phone, booking.clinic_id)) return;

  const jobs = computeReminderJobs(booking);
  if (jobs.length === 0) return;

  await sb.from("reminder_jobs").insert(
    jobs.map((j) => ({
      booking_id: j.booking_id,
      user_id: j.user_id,
      clinic_id: j.clinic_id,
      phone: j.phone,
      kind: j.kind,
      template_name: j.template_name,
      template_vars: j.template_vars,
      send_at: j.send_at.toISOString(),
    })),
  );
}

/**
 * Enqueue a doc_ready reminder. Idempotent — relies on
 * reminder_jobs_pending_unique to prevent double-insert.
 * Caller passes the doc type label that ends up in the template.
 */
export async function enqueueDocReady(args: {
  bookingId: string;
  docType: string;
}): Promise<void> {
  const sb = getSupabase();
  const booking = await getBookingForReminder(args.bookingId);
  if (!booking) return;
  if (await isMuted(booking.phone, booking.clinic_id)) return;

  const template_name = "doc_ready";
  const template_vars = buildTemplateVars("doc_ready", booking, { doc_type: args.docType });

  await sb.from("reminder_jobs").upsert(
    {
      booking_id: booking.id,
      user_id: booking.user_id,
      clinic_id: booking.clinic_id,
      phone: booking.phone,
      kind: "doc_ready",
      template_name,
      template_vars,
      send_at: new Date().toISOString(), // fire next sweep
    },
    { onConflict: "booking_id,kind" },
  );
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun run test:reminder-scheduler`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reminders/scheduler.ts scripts/test-reminder-scheduler.ts package.json
git commit -m "feat(bot): add reminder scheduler (recompute + enqueueDocReady)"
```

---

## Phase 5 — Cron Sweeper

### Task 5.1: Sender module + sweeper logic

**Files:**
- Create: `src/lib/reminders/sender.ts`
- Test: `scripts/test-reminder-sender.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-reminder-sender.ts`:

```ts
import "dotenv/config";
import { processJob } from "../src/lib/reminders/sender";
import type { ReminderJobRow } from "../src/lib/reminders/types";
import type { TemplateSendResult } from "../src/lib/whatsapp";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else { console.error(`FAIL: ${label}`); failures++; }
}

function fakeJob(overrides: Partial<ReminderJobRow> = {}): ReminderJobRow {
  return {
    id: "j_1",
    booking_id: "bk_1",
    user_id: "u_1",
    clinic_id: "cl_1",
    phone: "60111",
    kind: "appt_24h",
    template_name: "appt_24h_with_doctor",
    template_vars: {
      patient_name: "Ali",
      clinic_name: "One Care",
      time_string: "10:30 AM, Tue 5 May",
      doctor_name: "Tan",
    },
    send_at: new Date(Date.now() - 1000).toISOString(),
    sent_at: null,
    attempts: 0,
    last_error: null,
    failed_at: null,
    ...overrides,
  };
}

async function main() {
  const calls: any[] = [];
  const fakeDeps = {
    loadBooking: async () => ({
      id: "bk_1",
      user_id: "u_1",
      clinic_id: "cl_1",
      doctor_name: "Tan",
      patient_name: "Ali",
      clinic_name: "One Care",
      phone: "60111",
      status: "confirmed",
      appointment_at: new Date(Date.now() + 24 * 3600 * 1000),
    }),
    isMuted: async () => false,
    sendTemplate: async (_args: any): Promise<TemplateSendResult> => {
      calls.push({ kind: "send", args: _args });
      return { kind: "ok" };
    },
    markSent: async (id: string) => calls.push({ kind: "markSent", id }),
    markFailed: async (id: string, err: string) => calls.push({ kind: "markFailed", id, err }),
    markCancelled: async (id: string, reason: string) => calls.push({ kind: "markCancelled", id, reason }),
    bumpAttempts: async (id: string, err: string) => calls.push({ kind: "bumpAttempts", id, err }),
    muteGlobally: async (phone: string) => calls.push({ kind: "muteGlobally", phone }),
  };

  // Happy path
  await processJob(fakeJob(), fakeDeps);
  assert(calls.some((c) => c.kind === "send"), "happy path: sendTemplate called");
  assert(calls.some((c) => c.kind === "markSent" && c.id === "j_1"), "happy path: markSent called");

  // Booking no longer confirmed -> markCancelled, no send
  calls.length = 0;
  await processJob(fakeJob(), {
    ...fakeDeps,
    loadBooking: async () => ({ ...(await fakeDeps.loadBooking()), status: "cancelled" }),
  });
  assert(
    !calls.some((c) => c.kind === "send"),
    "cancelled booking: no send",
  );
  assert(
    calls.some((c) => c.kind === "markCancelled" && c.reason.includes("not_confirmed")),
    "cancelled booking: markCancelled",
  );

  // Muted between schedule and send -> markCancelled
  calls.length = 0;
  await processJob(fakeJob(), { ...fakeDeps, isMuted: async () => true });
  assert(
    !calls.some((c) => c.kind === "send"),
    "muted: no send",
  );
  assert(
    calls.some((c) => c.kind === "markCancelled" && c.reason.includes("muted")),
    "muted: markCancelled",
  );

  // Permanent block -> markFailed + muteGlobally
  calls.length = 0;
  await processJob(fakeJob(), {
    ...fakeDeps,
    sendTemplate: async () => ({ kind: "permanent_block", metaCode: 131049, detail: "blocked" }),
  });
  assert(
    calls.some((c) => c.kind === "markFailed"),
    "perm block: markFailed",
  );
  assert(
    calls.some((c) => c.kind === "muteGlobally" && c.phone === "60111"),
    "perm block: muteGlobally called",
  );

  // Permanent template -> markFailed, NO muteGlobally
  calls.length = 0;
  await processJob(fakeJob(), {
    ...fakeDeps,
    sendTemplate: async () => ({ kind: "permanent_template", metaCode: 132001, detail: "bad params" }),
  });
  assert(
    calls.some((c) => c.kind === "markFailed"),
    "perm template: markFailed",
  );
  assert(
    !calls.some((c) => c.kind === "muteGlobally"),
    "perm template: no muteGlobally",
  );

  // Transient -> bumpAttempts only
  calls.length = 0;
  await processJob(fakeJob(), {
    ...fakeDeps,
    sendTemplate: async () => ({ kind: "transient", detail: "5xx" }),
  });
  assert(
    calls.some((c) => c.kind === "bumpAttempts"),
    "transient: bumpAttempts",
  );
  assert(
    !calls.some((c) => c.kind === "markFailed" || c.kind === "markSent"),
    "transient: no markSent / markFailed",
  );

  if (failures > 0) { console.error(`\n${failures} failures`); process.exit(1); }
  console.log("\nAll tests passed");
}

main();
```

Add to `package.json`:
```json
"test:reminder-sender": "tsx --tsconfig tsconfig.json scripts/test-reminder-sender.ts",
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:reminder-sender`
Expected: FAIL — `processJob` not exported.

- [ ] **Step 3: Implement sender**

Create `src/lib/reminders/sender.ts`:

```ts
import { getSupabase } from "../supabase";
import { sendTemplate, type TemplateSendResult } from "../whatsapp";
import { getBookingForReminder } from "./booking-loader";
import { isMuted, muteGlobally } from "./optout";
import { buildComponents } from "./templates";
import type { BookingForReminder, ReminderJobRow } from "./types";

const BATCH_LIMIT = 100;
const ATTEMPTS_CAP = 3;

export interface SweeperDeps {
  loadBooking: (id: string) => Promise<BookingForReminder | null>;
  isMuted: (phone: string, clinicId: string) => Promise<boolean>;
  sendTemplate: typeof sendTemplate;
  markSent: (id: string) => Promise<void>;
  markFailed: (id: string, err: string) => Promise<void>;
  markCancelled: (id: string, reason: string) => Promise<void>;
  bumpAttempts: (id: string, err: string) => Promise<void>;
  muteGlobally: (phone: string) => Promise<void>;
}

export const realDeps: SweeperDeps = {
  loadBooking: getBookingForReminder,
  isMuted,
  sendTemplate,
  markSent: async (id) => {
    await getSupabase()
      .from("reminder_jobs")
      .update({ sent_at: new Date().toISOString() })
      .eq("id", id);
  },
  markFailed: async (id, err) => {
    await getSupabase()
      .from("reminder_jobs")
      .update({ failed_at: new Date().toISOString(), last_error: err })
      .eq("id", id);
  },
  markCancelled: async (id, reason) => {
    await getSupabase()
      .from("reminder_jobs")
      .update({ failed_at: new Date().toISOString(), last_error: `cancelled:${reason}` })
      .eq("id", id);
  },
  bumpAttempts: async (id, err) => {
    const sb = getSupabase();
    const { data } = await sb.from("reminder_jobs").select("attempts").eq("id", id).maybeSingle();
    const current = (data?.attempts as number) ?? 0;
    const next = current + 1;
    if (next >= ATTEMPTS_CAP) {
      await sb.from("reminder_jobs")
        .update({
          attempts: next,
          last_error: err,
          failed_at: new Date().toISOString(),
        })
        .eq("id", id);
    } else {
      await sb.from("reminder_jobs")
        .update({ attempts: next, last_error: err })
        .eq("id", id);
    }
  },
  muteGlobally: async (phone) => muteGlobally(phone, "auto_block"),
};

export async function processJob(
  job: ReminderJobRow,
  deps: SweeperDeps = realDeps,
): Promise<void> {
  const booking = await deps.loadBooking(job.booking_id);
  if (!booking) {
    await deps.markCancelled(job.id, "booking_not_found");
    return;
  }
  if (booking.status !== "confirmed") {
    await deps.markCancelled(job.id, "not_confirmed");
    return;
  }
  if (await deps.isMuted(job.phone, job.clinic_id)) {
    await deps.markCancelled(job.id, "muted");
    return;
  }

  const components = buildComponents({
    template_name: job.template_name,
    template_vars: job.template_vars,
    booking_id: job.booking_id,
    clinic_id: job.clinic_id,
  });

  const result: TemplateSendResult = await deps.sendTemplate({
    to: job.phone,
    name: job.template_name,
    lang: "en",
    components,
  });

  switch (result.kind) {
    case "ok":
      await deps.markSent(job.id);
      return;
    case "permanent_block":
      await deps.markFailed(job.id, result.detail ?? "permanent_block");
      await deps.muteGlobally(job.phone);
      return;
    case "permanent_template":
      await deps.markFailed(job.id, result.detail ?? "permanent_template");
      return;
    case "transient":
      await deps.bumpAttempts(job.id, result.detail ?? "transient");
      return;
  }
}

export async function sweepDueJobs(deps: SweeperDeps = realDeps): Promise<{ processed: number }> {
  const sb = getSupabase();
  const { data: due, error } = await sb
    .from("reminder_jobs")
    .select("*")
    .lte("send_at", new Date().toISOString())
    .is("sent_at", null)
    .is("failed_at", null)
    .lt("attempts", ATTEMPTS_CAP)
    .order("send_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    console.error("[REMINDER] sweep query failed:", error.message);
    return { processed: 0 };
  }

  for (const row of (due ?? []) as ReminderJobRow[]) {
    try {
      await processJob(row, deps);
    } catch (err) {
      console.error(`[REMINDER] processJob ${row.id} threw:`, err);
      await deps.bumpAttempts(row.id, `exception:${String(err)}`);
    }
  }

  return { processed: due?.length ?? 0 };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun run test:reminder-sender`
Expected: All cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reminders/sender.ts scripts/test-reminder-sender.ts package.json
git commit -m "feat(bot): add reminder sweeper with retry + failure classification"
```

---

### Task 5.2: Vercel Cron route + schedule

**Files:**
- Create: `src/app/api/cron/reminders/route.ts`
- Create or modify: `vercel.json`

- [ ] **Step 1: Create the cron route**

Create `src/app/api/cron/reminders/route.ts`:

```ts
import { NextResponse } from "next/server";
import { sweepDueJobs } from "@/lib/reminders/sender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET>
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  const got = req.headers.get("authorization") ?? "";
  if (!process.env.CRON_SECRET || got !== expected) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const result = await sweepDueJobs();
  return NextResponse.json({ ok: true, ...result });
}
```

- [ ] **Step 2: Add cron to `vercel.json`**

If `vercel.json` doesn't exist, create it:

```json
{
  "crons": [
    { "path": "/api/cron/reminders", "schedule": "*/5 * * * *" }
  ]
}
```

If it exists, merge in the `crons` array.

- [ ] **Step 3: Smoke-test the route locally**

In one terminal: `bun run dev`
In another:
```bash
curl -i http://localhost:3000/api/cron/reminders
# Expected: 401 Unauthorized

curl -i -H "Authorization: Bearer dev-secret" http://localhost:3000/api/cron/reminders
# Set CRON_SECRET=dev-secret in .env first.
# Expected: 200 with {"ok":true,"processed":0}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/reminders/route.ts vercel.json
git commit -m "feat(bot): add /api/cron/reminders route + 5-min schedule"
```

---

## Phase 6 — Booking-Hook Integration

Wire `recomputeReminders` into the booking lifecycle.

### Task 6.1: Hook into `create_booking`, `reschedule_booking`, `cancel_booking`

**Files:**
- Modify: `src/bot/tools/booking.ts`

- [ ] **Step 1: Read the file to identify hook insertion points**

Open `src/bot/tools/booking.ts`. Confirm three execute() blocks: `create_booking`, `reschedule_booking`, `cancel_booking`.

- [ ] **Step 2: Add import**

At the top of `src/bot/tools/booking.ts`, add:

```ts
import { recomputeReminders } from "@/lib/reminders/scheduler";
```

- [ ] **Step 3: Hook into `create_booking`**

Find the success path inside `create_booking` (just before the `return JSON.stringify({ success: true, ... })`). Insert:

```ts
// Best-effort reminder enqueue. Never blocks user-facing booking confirmation.
recomputeReminders(booking.id).catch((e) => {
  console.error("[REMINDER] recompute after create failed:", e);
});
```

- [ ] **Step 4: Hook into `reschedule_booking`**

Find the success path of `reschedule_booking` (after the update + before the return). Insert the same `recomputeReminders(<bookingIdVar>).catch(...)` call using whatever local variable holds the booking id.

- [ ] **Step 5: Hook into `cancel_booking`**

Find the success path. Same call. (Cancellation will result in 0 jobs since `status !== 'confirmed'`, but the recompute step must still run to delete pending rows.)

- [ ] **Step 6: Smoke check**

Run `bun run test:tools` (existing) to ensure no regressions in booking tool tests.
Expected: existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/bot/tools/booking.ts
git commit -m "feat(bot): wire recomputeReminders into booking lifecycle"
```

---

## Phase 7 — Button Payload Routing

Inbound template button taps must short-circuit before the AI tool loop.

### Task 7.1: Extend `ThreadState`

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add fields to ThreadState**

Open `src/types.ts`, locate `interface ThreadState`. Add:

```ts
  /** Set when user taps "View booking" on a reminder template. Cleared next non-button turn. */
  activeBookingId?: string;

  /** Set when user taps "Get document" on a doc-ready reminder. Cleared next non-button turn. */
  pendingDocRetrievalBookingId?: string;
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat(bot): add reminder-related ThreadState fields"
```

---

### Task 7.2: Button router module

**Files:**
- Create: `src/bot/messages/button-router.ts`
- Test: `scripts/test-button-router.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-button-router.ts`:

```ts
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
```

Add to `package.json`:
```json
"test:button-router": "tsx --tsconfig tsconfig.json scripts/test-button-router.ts",
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:button-router`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement button router**

Create `src/bot/messages/button-router.ts`:

```ts
import { muteClinic, unmuteClinic } from "@/lib/reminders/optout";
import { getSupabase } from "@/lib/supabase";
import type { ThreadState } from "@/types";

export type ButtonAction =
  | { kind: "mute_clinic"; clinicId: string }
  | { kind: "unmute_clinic"; clinicId: string }
  | { kind: "view_booking"; bookingId: string }
  | { kind: "get_doc"; bookingId: string };

const PAYLOAD_RE = /^(mute_clinic|unmute_clinic|view_booking|get_doc):([a-zA-Z0-9_-]+)$/;

export function parseButtonPayload(text: string): ButtonAction | null {
  if (!text) return null;
  const m = text.match(PAYLOAD_RE);
  if (!m) return null;
  const [, kind, id] = m;
  switch (kind) {
    case "mute_clinic":   return { kind: "mute_clinic", clinicId: id };
    case "unmute_clinic": return { kind: "unmute_clinic", clinicId: id };
    case "view_booking":  return { kind: "view_booking", bookingId: id };
    case "get_doc":       return { kind: "get_doc", bookingId: id };
    default: return null;
  }
}

export interface HandleResult {
  /** When true, skip the AI tool loop entirely. */
  handled: boolean;
  /** Optional system-note to prepend to the AI loop on handled=false. */
  hint?: string;
}

export async function handleButtonAction(
  action: ButtonAction,
  ctx: {
    phone: string;
    thread: ThreadState;
    updateThread: (patch: Partial<ThreadState>) => Promise<void>;
    replyText: (text: string) => Promise<void>;
  },
): Promise<HandleResult> {
  switch (action.kind) {
    case "mute_clinic": {
      await muteClinic(ctx.phone, action.clinicId, "button");
      const name = await clinicName(action.clinicId);
      await ctx.replyText(
        `Reminders from ${name} muted. You can re-enable them anytime by booking again or typing "resume reminders".`,
      );
      return { handled: true };
    }
    case "unmute_clinic": {
      await unmuteClinic(ctx.phone, action.clinicId);
      const name = await clinicName(action.clinicId);
      await ctx.replyText(`Reminders from ${name} resumed.`);
      return { handled: true };
    }
    case "view_booking": {
      await ctx.updateThread({ activeBookingId: action.bookingId });
      return { handled: false, hint: `User tapped "View booking" for booking ${action.bookingId}. Load the booking and summarise it.` };
    }
    case "get_doc": {
      await ctx.updateThread({ pendingDocRetrievalBookingId: action.bookingId });
      return { handled: false, hint: `User tapped "Get document" for booking ${action.bookingId}. Verify identity if needed, then run document retrieval for that booking.` };
    }
  }
}

async function clinicName(clinicId: string): Promise<string> {
  const sb = getSupabase();
  const { data } = await sb.from("c_a_clinics").select("name").eq("id", clinicId).maybeSingle();
  return (data?.name as string) ?? "the clinic";
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun run test:button-router`
Expected: All assertions pass.

- [ ] **Step 5: Commit**

```bash
git add src/bot/messages/button-router.ts scripts/test-button-router.ts package.json
git commit -m "feat(bot): add button-router for reminder template button taps"
```

---

### Task 7.3: Wire `parseButtonPayload` into the receive flow

**Files:**
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Locate the receive flow**

Open `src/bot/index.ts`. Find the section where inbound text is processed AFTER `parseFriendlyPrefill` and `parseDeepLinkToken` and BEFORE the AI `generateText` tool loop. (Search for `parseDeepLinkToken` to anchor.)

- [ ] **Step 2: Add import**

```ts
import { parseButtonPayload, handleButtonAction } from "@/bot/messages/button-router";
```

- [ ] **Step 3: Insert button handling**

After the deep-link parsing block, before the AI loop call, add:

```ts
const buttonAction = parseButtonPayload(incomingText);
if (buttonAction) {
  const result = await handleButtonAction(buttonAction, {
    phone,
    thread,
    updateThread: updateState,           // existing helper from this scope
    replyText: async (t) => {
      // Use existing text-send helper for this scope. Adapt name as required.
      await sendText(phone, t);
    },
  });
  if (result.handled) {
    // Clear thread fields that shouldn't persist past a button-handled turn.
    return;
  }
  if (result.hint) {
    // Prepend hint as a system note for this turn only.
    extraSystemNotes.push(result.hint);
  }
}
```

(Adjust `sendText`, `updateState`, and `extraSystemNotes` names to match the exact identifiers in the file. The file's existing pattern for `parseFriendlyPrefill` is the reference.)

- [ ] **Step 4: Smoke check**

Run `bun run test:smoke` and `bun run test:tools`.
Expected: existing tests pass; no behavior change for non-button text.

- [ ] **Step 5: Commit**

```bash
git add src/bot/index.ts
git commit -m "feat(bot): route reminder button taps before AI loop"
```

---

## Phase 8 — Manual Unmute Tool

For the "I muted but want it back" flow without rebooking.

### Task 8.1: `manage_reminder_optouts` AI tool

**Files:**
- Create: `src/bot/tools/manage-optouts.ts`
- Modify: `src/bot/tools/index.ts`

- [ ] **Step 1: Implement the tool**

Create `src/bot/tools/manage-optouts.ts`:

```ts
import { tool } from "ai";
import { z } from "zod";
import { listMutedClinics, unmuteClinic } from "@/lib/reminders/optout";
import { getSupabase } from "@/lib/supabase";
import type { ThreadState } from "@/types";

interface ToolDeps {
  state: ThreadState;
}

export function manageOptoutsTools({ state }: ToolDeps) {
  return {
    manage_reminder_optouts: tool({
      description:
        "List muted clinics for the current phone and optionally unmute one. " +
        "Call with no args to list. Call with clinicId to unmute a specific clinic.",
      inputSchema: z.object({
        clinicId: z.string().optional().describe("Clinic UUID to unmute. Omit to list."),
      }),
      execute: async ({ clinicId }) => {
        if (!state.phone) {
          return JSON.stringify({ error: "No phone in session." });
        }
        if (clinicId) {
          await unmuteClinic(state.phone, clinicId);
          return JSON.stringify({ success: true, unmutedClinicId: clinicId });
        }
        const ids = await listMutedClinics(state.phone);
        if (ids.length === 0) {
          return JSON.stringify({ muted: [], message: "No clinics currently muted." });
        }
        const sb = getSupabase();
        const { data: clinics } = await sb
          .from("c_a_clinics")
          .select("id, name")
          .in("id", ids);
        return JSON.stringify({
          muted: (clinics ?? []).map((c) => ({ id: c.id, name: c.name })),
        });
      },
    }),
  };
}
```

- [ ] **Step 2: Register in `src/bot/tools/index.ts`**

Open `src/bot/tools/index.ts`. Add import:
```ts
import { manageOptoutsTools } from "./manage-optouts";
```
In the function that composes the tool record, spread `manageOptoutsTools({ state })` alongside the other tool factories.

- [ ] **Step 3: Update bot prompt to mention the tool**

Open `src/bot/prompt.ts`. In the section that lists what the bot can do (or in the tool guidance block), add a line:

```
- If a user asks to "resume reminders", "unmute reminders", or anything similar, call manage_reminder_optouts (no args) to list muted clinics, then ask which one to resume, then call again with clinicId.
```

- [ ] **Step 4: Smoke check**

Run `bun run test:tools` (existing). Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/bot/tools/manage-optouts.ts src/bot/tools/index.ts src/bot/prompt.ts
git commit -m "feat(bot): add manage_reminder_optouts AI tool"
```

---

## Phase 9 — Auto-Unmute on Rebook + Doc-Ready Reconcile

Two small post-MVP-but-required loose ends.

### Task 9.1: Auto-unmute (button-source only) on rebooking

**Files:**
- Modify: `src/lib/reminders/scheduler.ts`

- [ ] **Step 1: Tweak `recomputeReminders` to clear button-source mute**

Edit `recomputeReminders` in `src/lib/reminders/scheduler.ts`. Before the `if (await isMuted(...)) return;` line, insert:

```ts
// Auto-unmute clinic if patient muted via button — taking action (rebooking)
// is taken as renewed consent. auto_block mutes are NOT cleared (Meta says
// the user is unreachable; clearing would re-spam).
const { unmuteClinic } = await import("./optout");
await unmuteClinic(booking.phone, booking.clinic_id, { onlyButtonSource: true });
```

(Use a lazy import to avoid restructuring imports in this small change. If you prefer, hoist `unmuteClinic` to the top-of-file imports.)

- [ ] **Step 2: Re-run scheduler test**

Run: `bun run test:reminder-scheduler`
Expected: pass (test uses synthetic bookings, doesn't touch DB unmute path).

Run: `bun run test:reminder-optout`
Expected: pass (already covers `onlyButtonSource` semantic).

- [ ] **Step 3: Commit**

```bash
git add src/lib/reminders/scheduler.ts
git commit -m "feat(bot): auto-clear button-source mute on rebook"
```

---

### Task 9.2: Daily doc-ready reconcile sweep

For docs created outside the bot (clinic admin web). Single helper, daily cron.

**Files:**
- Modify: `src/lib/reminders/scheduler.ts`
- Modify: `src/app/api/cron/reminders/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Add `reconcileDocReady` helper**

Append to `src/lib/reminders/scheduler.ts`:

```ts
/**
 * Backfill: find completed bookings (status='completed') that have a generated
 * document but no doc_ready reminder enqueued. Insert one per missing.
 *
 * The exact join depends on where consultation reports / MCs live in the
 * Supabase schema. Adapt the SELECT below once that table is identified.
 * For MVP, we hard-limit to bookings completed in the last 7 days to bound work.
 */
export async function reconcileDocReady(): Promise<{ enqueued: number }> {
  const sb = getSupabase();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().split("T")[0];

  // Step 1: find recently completed bookings missing a doc_ready job
  const { data: candidates } = await sb
    .from("c_s_bookings")
    .select("id")
    .eq("status", "completed")
    .gte("original_date", sevenDaysAgo)
    .limit(200);

  if (!candidates || candidates.length === 0) return { enqueued: 0 };

  const ids = candidates.map((c) => c.id);
  const { data: existing } = await sb
    .from("reminder_jobs")
    .select("booking_id")
    .in("booking_id", ids)
    .eq("kind", "doc_ready");
  const have = new Set((existing ?? []).map((r) => r.booking_id as string));
  const missing = ids.filter((i) => !have.has(i));

  let enqueued = 0;
  for (const bookingId of missing) {
    // TODO(operator): once the consultation-report table name is confirmed,
    // gate this enqueue on doc-existence to avoid sending "ready" for bookings
    // with no document. For MVP, conservatively enqueue only if a hook has
    // already inserted a doc_ready row — i.e. skip this loop entirely until
    // the doc table is integrated. Leaving the structure in place.
    void bookingId;
    enqueued += 0;
  }

  return { enqueued };
}
```

- [ ] **Step 2: Add a separate cron route for the daily reconcile**

Create `src/app/api/cron/reminders-reconcile/route.ts`:

```ts
import { NextResponse } from "next/server";
import { reconcileDocReady } from "@/lib/reminders/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  if (!process.env.CRON_SECRET || (req.headers.get("authorization") ?? "") !== expected) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const result = await reconcileDocReady();
  return NextResponse.json({ ok: true, ...result });
}
```

- [ ] **Step 3: Add daily schedule to `vercel.json`**

```json
{
  "crons": [
    { "path": "/api/cron/reminders", "schedule": "*/5 * * * *" },
    { "path": "/api/cron/reminders-reconcile", "schedule": "0 18 * * *" }
  ]
}
```

(02:00 MYT = 18:00 UTC — runs in the patient quiet hour.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/reminders/scheduler.ts src/app/api/cron/reminders-reconcile/route.ts vercel.json
git commit -m "feat(bot): add daily doc-ready reconcile sweep stub"
```

> **Operator follow-up:** Before flipping `doc_ready` reminders on in production, identify the consultation-report / MC table and replace the placeholder loop in `reconcileDocReady` with a real existence check. Until then, the stub is a safe no-op.

---

## Phase 10 — Composite Test Script + Docs

### Task 10.1: Composite `test:reminders` script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add composite script**

Edit `package.json` `scripts`:

```json
"test:reminders": "bun run test:reminder-time && bun run test:error-classifier && bun run test:reminder-templates && bun run test:reminder-scheduler && bun run test:button-router && bun run test:reminder-optout && bun run test:reminder-sender",
```

- [ ] **Step 2: Run the composite**

Run: `bun run test:reminders`
Expected: all 7 sub-suites pass.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test(bot): add composite test:reminders script"
```

---

### Task 10.2: README + .env.example + smoke doc

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/bot-test-smoke.md`

- [ ] **Step 1: Add `CRON_SECRET` to `.env.example`**

Append (or insert in alphabetical order):
```
# Required for /api/cron/reminders. Set a strong random value; matches Vercel Cron header.
CRON_SECRET=
```

- [ ] **Step 2: Add `CRON_SECRET` to README env vars table**

Open `README.md`. Find the canonical environment variables table. Add:

| Variable | Required | Purpose |
|---|---|---|
| `CRON_SECRET` | yes | Authenticates Vercel Cron requests to `/api/cron/reminders` and `/api/cron/reminders-reconcile`. |

- [ ] **Step 3: Add a "Booking Reminders" section to README**

After the "Deep Linking" section, add:

```markdown
### Booking Reminders

Confirmed bookings trigger a reminder cascade via WhatsApp Message Templates:

- `appt_24h` — 24h before appointment
- `appt_2h`  — 2h before appointment
- `doc_ready` — when a consultation report or MC is ready

All templates are Utility-categorized and include a "Stop Reminders" quick-reply button.
Per-clinic opt-out is stored in `reminder_optouts`; auto-cleared on rebook (button-source only).

Scheduling is recompute-on-change: any booking write deletes existing pending rows and re-inserts current intent. A `*/5` Vercel Cron sweeps `reminder_jobs` and sends due rows.

Templates submitted to Meta:
- `appt_24h_with_doctor`, `appt_24h_no_doctor`
- `appt_2h_with_doctor`, `appt_2h_no_doctor`
- `doc_ready`

Spec: `docs/superpowers/specs/2026-05-03-booking-reminders-design.md`.
```

- [ ] **Step 4: Add smoke scenarios to `docs/bot-test-smoke.md`**

Append:

```markdown
## Booking Reminders

### Scenario R1 — T-24h reminder fires

1. Create a confirmed booking 25h in the future for a test phone.
2. Verify two rows in `reminder_jobs` for that booking_id (kinds appt_24h, appt_2h).
3. Wait until `send_at <= now()` for the appt_24h row, OR manually update `send_at` to `now()` in the DB.
4. Hit `/api/cron/reminders` with the CRON_SECRET header.
5. Verify the test phone receives the `appt_24h_*` template.
6. Verify the row's `sent_at` is populated.

### Scenario R2 — Stop Reminders mutes clinic

1. From a delivered reminder, tap "Stop reminders".
2. Verify a row in `reminder_optouts` for `(phone, clinic_id)` with `source='button'`.
3. Verify an ack reply is delivered.
4. Hit the cron again. Verify any remaining pending rows for that booking are marked cancelled (`failed_at` set, `last_error='cancelled:muted'`).

### Scenario R3 — Auto-unmute on rebook

1. Confirm `(phone, clinic_id, source='button')` exists from R2.
2. Create a new confirmed booking at the same clinic for the same phone.
3. Verify the opt-out row is gone and new reminder_jobs rows exist for the new booking.

### Scenario R4 — Reschedule cancels old + schedules new

1. Confirmed booking 30h out → 2 reminder rows.
2. Reschedule booking to 5h out (status flips to `reschedule_pending` then back to `confirmed` after clinic re-confirms — adjust to mirror real flow).
3. Verify old rows are gone; one new row (appt_2h only) exists with new send_at.

### Scenario R5 — View booking via template button

1. Tap "View booking" on a delivered reminder.
2. Verify thread `activeBookingId` is set; the AI loop returns a booking summary.

### Scenario R6 — Doc-ready delivery

1. Manually insert a `reminder_jobs` row with kind=`doc_ready`, send_at=now() for a confirmed completed booking.
2. Hit cron route.
3. Verify `doc_ready` template delivered with "Get document" button.
4. Tap "Get document" → bot runs verify_patient → search_documents flow.
```

- [ ] **Step 5: Commit**

```bash
git add README.md .env.example docs/bot-test-smoke.md
git commit -m "docs(bot): document booking reminders feature + env + smoke scenarios"
```

---

## Phase 11 — Manual Verification Before Launch

Operator-side, no code. Track here so nothing slips.

- [ ] Submit 5 templates to Meta for approval (Utility, English):
  `appt_24h_with_doctor`, `appt_24h_no_doctor`, `appt_2h_with_doctor`, `appt_2h_no_doctor`, `doc_ready`. Body text and button labels per the spec template catalog.
- [ ] Add `CRON_SECRET` to Vercel project env (Production + Preview).
- [ ] Verify Vercel project is on Pro tier (cron minute granularity required).
- [ ] Apply migration `004_reminders.sql` to production Supabase.
- [ ] Deploy. Hit `/api/cron/reminders` manually with the secret to confirm 200.
- [ ] Run smoke scenarios R1–R6 against staging.
- [ ] Identify the consultation-report / MC table; replace the `reconcileDocReady` stub loop with a real existence check (Operator follow-up from Task 9.2).
- [ ] Monitor Meta WhatsApp Business Manager for template performance + quality score for first week.

---

## Self-Review

Before declaring this plan complete:

**Spec coverage check** (every spec section → task):
- Goal / cascade (T-24h, T-2h, doc_ready) → Tasks 4.1, 5.1
- Architecture diagram → Tasks 4.1, 5.1, 5.2, 7.2, 7.3
- Module boundaries table → all phases
- `reminder_jobs` + `reminder_optouts` schema → Task 1.1
- Recompute model → Task 4.1 (`recomputeReminders`), Task 6.1 (hooks)
- Late-booking buffer (5min) → Task 4.1 (test + impl)
- doc_ready hook + reconcile → Tasks 4.1 (`enqueueDocReady`), 9.2
- Cron sweeper + auth → Tasks 5.1, 5.2
- Error classifier table → Task 1.3
- 5 templates + var maps + button payloads → Tasks 3.2, 11
- Per-clinic opt-out, auto_block global mute, auto-unmute on rebook → Tasks 2.1, 9.1
- Manual unmute command → Task 8.1
- Button payload routing → Tasks 7.1, 7.2, 7.3
- Failure handling (retry / permanent / cancelled) → Task 5.1
- Testing strategy → Tasks 1.2, 1.3, 2.1, 3.2, 4.1, 5.1, 7.2, 10.1, 10.2
- Env var `CRON_SECRET` → Task 10.2
- Out of scope items → not implemented (correct)

**Type consistency check:**
- `BookingForReminder.appointment_at` is `Date` everywhere ✓
- `ReminderJobRow.send_at`, `sent_at`, `failed_at` are ISO `string | null` (DB shape) — `computeReminderJobs` returns `send_at: Date`, sender uses string from DB row. Mismatch contained inside scheduler's INSERT path which converts via `toISOString()`. ✓
- Button kinds: `mute_clinic | unmute_clinic | view_booking | get_doc` consistent across parser, handler, payload builder ✓
- Template names: same 5 strings used in `pickTemplateName`, `buildComponents`, smoke doc ✓
- Opt-out source enum: `button | command | auto_block` consistent across migration CHECK constraint, optout module, sender, scheduler ✓

**Placeholder scan:** One `TODO(operator)` in `reconcileDocReady` — flagged in Phase 11 manual checklist with explicit instruction. No other TBD/TODO. The scheduler's lazy import in Task 9.1 is intentional (small change isolated from import block) and noted with refactor option.

No issues blocking execution. Plan ready.
