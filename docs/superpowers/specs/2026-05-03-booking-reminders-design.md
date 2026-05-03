# Booking Reminders — Design

**Date:** 2026-05-03
**Status:** Design approved, awaiting implementation plan
**Scope:** anyhealth-bot (Next.js + Supabase + Meta WhatsApp Cloud API)

## Goal

Send WhatsApp reminders for confirmed bookings without violating Meta messaging policy:
- Outside 24h customer-service window → must use pre-approved Message Templates.
- Templates must be Utility-categorized (Marketing reclassification = ~5x cost).
- Every reminder must include a "Stop Reminders" opt-out button (protects quality score vs. Block / Report).

## Reminder Cascade

Three reminder kinds per booking, all Utility:

| Kind | Trigger | Purpose |
|---|---|---|
| `appt_24h` | 24h before appointment time | Day-before reminder |
| `appt_2h` | 2h before appointment time | Same-day reminder |
| `doc_ready` | Document (MC / consultation report) created post-visit | Retrieval CTA |

No standalone "thanks for visiting" / rating message — too easily reclassified Marketing, low utility.

## Architecture

```
Booking write (create / reschedule / cancel / status flip)
        ↓
recomputeReminders(booking_id)
   delete pending reminder_jobs for booking
   re-insert 0..N rows where send_at > now()+5min AND status='confirmed' AND not muted

Doc creation hook (or daily reconcile sweep)
        ↓
enqueueDocReady(booking_id) — single row in reminder_jobs

Vercel Cron */5 * * * * → POST /api/cron/reminders
        ↓
Sweep due rows, re-validate booking + mute, send template via Meta API
        ↓
Success: sent_at = now()
Transient fail: attempts++, retry next tick, give up after 3
Permanent block (131049): mark failed + global mute phone
Permanent template error (132xxx): mark failed, no retry

Inbound webhook (template button tap)
        ↓
parseButtonPayload (NEW) — short-circuits before AI tool loop
        ↓
mute_clinic / view_booking / get_doc / unmute_clinic handlers
```

### Module boundaries

| File (new) | Responsibility |
|---|---|
| `src/lib/reminders/scheduler.ts` | `recomputeReminders(bookingId)`, `enqueueDocReady(bookingId)` |
| `src/lib/reminders/sender.ts` | Cron sweep loop, send-time re-validation, retry / failure classification |
| `src/lib/reminders/templates.ts` | Template name registry, `buildComponents()` for Meta API payload |
| `src/lib/reminders/optout.ts` | `isMuted`, `muteClinic`, `unmuteClinic`, `muteGlobally` |
| `src/bot/messages/button-router.ts` | `parseButtonPayload`, `handleButtonAction` |
| `src/bot/tools/manage-optouts.ts` | New AI tool for `"resume reminders"` / unmute command flow |
| `src/app/api/cron/reminders/route.ts` | Vercel Cron entry point (auth via `CRON_SECRET`) |

### Modified files

- `src/lib/whatsapp.ts` — add `sendTemplate(to, name, lang, components)` helper + Meta error classifier
- `src/bot/tools/booking.ts` — call `recomputeReminders()` after create / reschedule / cancel
- `src/bot/index.ts` — slot `parseButtonPayload` into receive flow before AI loop
- `src/bot/types.ts` — extend `ThreadState` with `activeBookingId?`, `pendingDocRetrievalBookingId?`
- `vercel.json` — add cron schedule

## Data Model

Migration: `004_reminders.sql`.

```sql
CREATE TABLE reminder_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    text NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  patient_id    text NOT NULL REFERENCES patient_id(id),
  clinic_id     text NOT NULL REFERENCES clinics(id),
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

CREATE INDEX reminder_jobs_due_idx
  ON reminder_jobs (send_at)
  WHERE sent_at IS NULL AND failed_at IS NULL;

CREATE INDEX reminder_jobs_booking_idx
  ON reminder_jobs (booking_id);

CREATE TABLE reminder_optouts (
  phone     text NOT NULL,
  clinic_id text,                                   -- NULL = global mute
  muted_at  timestamptz NOT NULL DEFAULT now(),
  source    text NOT NULL CHECK (source IN ('button','command','auto_block')),
  PRIMARY KEY (phone, clinic_id)
);
```

Notes:
- `reminder_jobs` uses **recompute** model: on booking change, all unsent rows for that booking are deleted and re-inserted. Trades audit history for simpler invariants. Add `reminder_audit_log` later if support needs it.
- `template_vars` snapshotted at schedule time (patient name, clinic name, formatted time, optional doctor name). Reschedule → recompute → fresh vars.
- `phone` denormalized for sender simplicity.
- `(phone, clinic_id=NULL)` row = global mute set by `auto_block` source when Meta returns "user unreachable / blocked" permanent error.

## Scheduling Logic

```
function recomputeReminders(bookingId):
  booking = getBooking(bookingId)        # joins clinic, patient, doctor

  DELETE FROM reminder_jobs
   WHERE booking_id = bookingId
     AND sent_at IS NULL

  if booking.status != 'confirmed': return
  if isMuted(booking.phone, booking.clinic_id): return

  apptAt = booking.appointment_at
  buffer = 5 minutes

  for offset in [24h, 2h]:
    sendAt = apptAt - offset
    if sendAt > now() + buffer:
      jobs.append(buildJob(booking, kind=offset, sendAt))

  # doc_ready is enqueued separately via enqueueDocReady() — not time-based

  INSERT INTO reminder_jobs ...
```

Booking-status gate: only `confirmed` schedules. `pending`, `reschedule_pending`, `cancelled` → 0 jobs.

Late-booking edge case (booking made <24h or <2h before appointment): past-due reminders silently skipped via the `sendAt > now() + buffer` check. Booking confirmation message (existing flow) covers immediate ack — no need to fire compressed reminders right after booking.

`buildJob` selects `*_with_doctor` vs `*_no_doctor` template based on whether the booking has a chosen doctor. Time formatted in Asia/Kuala_Lumpur (UTC+8, no DST — covers Malaysia + Singapore).

### `doc_ready` enqueue paths

Two paths to maximize coverage:
1. **Direct hook** — when consultation report or MC is inserted into DB by the bot or fullstack API, call `enqueueDocReady(booking_id)` synchronously.
2. **Reconcile sweep (daily cron)** — finds completed bookings with documents but no `doc_ready` row enqueued; backfills. Catches docs created by legacy clinic web app outside our hook surface.

### Hook points calling `recomputeReminders`

- `tools/booking.ts` — `create_booking` after status flip to `confirmed`
- `tools/booking.ts` — `reschedule_booking` after success
- `tools/booking.ts` — `cancel_booking` after success (will result in 0 rows since status is no longer `confirmed`)
- External writers (clinic admin app) flagged as MVP gap; daily reconcile sweep reduces drift until fullstack migration consolidates booking writes.

## Cron Sweeper

`POST /api/cron/reminders` (auth: `Authorization: Bearer ${CRON_SECRET}`):

1. `SELECT FROM reminder_jobs WHERE send_at <= now() AND sent_at IS NULL AND failed_at IS NULL AND attempts < 3 ORDER BY send_at ASC LIMIT 100`
2. For each row, **re-validate at send time:**
   - Booking still exists and `status = 'confirmed'`? Else mark cancelled (`failed_at = now()`, `last_error = 'cancelled:<reason>'`).
   - Phone still un-muted for this clinic? Else mark cancelled.
3. Build template components from `template_vars` + `booking_id` + `clinic_id` (button payloads).
4. Call `sendTemplate(...)` → returns `{ ok, kind, detail }`.
5. Update row based on result:
   - `ok` → `sent_at = now()`
   - `kind = 'transient'` → `attempts++`, leave for next tick
   - `kind = 'permanent_block'` → `failed_at = now()`, `muteGlobally(phone, 'auto_block')`
   - `kind = 'permanent_template'` → `failed_at = now()` (no retry, fix template & redeploy)

`vercel.json`:
```json
{ "crons": [{ "path": "/api/cron/reminders", "schedule": "*/5 * * * *" }] }
```

### Error classifier (`sendTemplate`)

| Meta response | Kind |
|---|---|
| HTTP 200 | `ok` |
| HTTP 5xx, network timeout | `transient` |
| Code 131026 (recipient not on WhatsApp) | `permanent_block` |
| Code 131047 (re-engagement required) | `permanent_block` (defensive — shouldn't fire with templates) |
| Code 131049 (user blocked / unreachable) | `permanent_block` |
| Code 132xxx (template not approved / paused / wrong params) | `permanent_template` |
| Default unknown | `transient` (fail-safe — retry rather than drop) |

## Template Catalog

5 templates submitted to Meta for approval. All Utility, English. (No `with_doctor` variant for `doc_ready` — doctor name irrelevant for document retrieval.)

| Internal name | Vars | Body | Buttons (quick reply) |
|---|---|---|---|
| `appt_24h_with_doctor` | 4 | `Hi {{1}}, reminder: your appointment with Dr. {{4}} at {{2}} is tomorrow at {{3}}. Reply or tap below if you need to make changes.` | `View booking`, `Stop reminders` |
| `appt_24h_no_doctor` | 3 | `Hi {{1}}, reminder: your appointment at {{2}} is tomorrow at {{3}}. Reply or tap below if you need to make changes.` | `View booking`, `Stop reminders` |
| `appt_2h_with_doctor` | 4 | `Hi {{1}}, your appointment with Dr. {{4}} at {{2}} starts in about 2 hours ({{3}}). See you soon.` | `View booking`, `Stop reminders` |
| `appt_2h_no_doctor` | 3 | `Hi {{1}}, your appointment at {{2}} starts in about 2 hours ({{3}}). See you soon.` | `View booking`, `Stop reminders` |
| `doc_ready` | 3 | `Hi {{1}}, your {{2}} from {{3}} is ready. Tap below to retrieve.` | `Get document`, `Stop reminders` |

Variable order:
- `appt_*_with_doctor`: `{{1}}=patient_name, {{2}}=clinic_name, {{3}}=time_string, {{4}}=doctor_name`
- `appt_*_no_doctor`: `{{1}}=patient_name, {{2}}=clinic_name, {{3}}=time_string`
- `doc_ready`: `{{1}}=patient_name, {{2}}=doc_type ("medical certificate" / "consultation report"), {{3}}=clinic_name`

Button payload (sent back to webhook on tap):
- Primary on `appt_*` → `view_booking:<bookingId>`
- Primary on `doc_ready` → `get_doc:<bookingId>`
- Secondary on all → `mute_clinic:<clinicId>`

Time format: `formatTimeMYT(date)` → e.g. `"10:30 AM, Tue 5 May"`. Asia/Kuala_Lumpur fixed.

## Opt-Out / Re-Opt-In

**Opt-out scope: per-clinic.** Patient muting Clinic A still receives reminders for unrelated bookings at Clinic B.

### Mute paths

| Path | `source` value | Effect |
|---|---|---|
| Tap "Stop reminders" button | `button` | `INSERT INTO reminder_optouts (phone, clinic_id, source='button')` |
| Type "stop reminders for X" / use `manage_reminder_optouts` tool | `command` | Same insert, source distinguishes intent |
| Meta returns permanent block (131049 / 131026) | `auto_block` | `INSERT (phone, NULL, 'auto_block')` — global mute |

### Unmute paths

| Path | Effect |
|---|---|
| Manual command via bot | `DELETE WHERE phone=? AND clinic_id=?`, regardless of source |
| Auto on rebooking same clinic | `DELETE WHERE phone=? AND clinic_id=? AND source='button'` only — does NOT clear `auto_block` (user is unreachable per Meta; clearing on rebook would re-spam) |

`isMuted(phone, clinicId)` returns true if either `(phone, clinicId)` row OR `(phone, NULL)` row exists.

### Manual unmute UX

New AI tool `manage_reminder_optouts`:
- Lists muted clinics for the phone (with names) via WhatsApp list message.
- Patient picks → row deleted → ack reply.
- Excludes `auto_block` global mutes from unmute list (those are technical, not user-initiated).

## Button Payload Routing

`parseButtonPayload(text)` matches `^(view_booking|get_doc|mute_clinic|unmute_clinic):([a-zA-Z0-9_-]+)$`.

Webhook receive order:
```
incoming text →
  parseFriendlyPrefill (existing) →
  parseDeepLinkToken (existing) →
  parseButtonPayload (NEW) →
    if handled: short-circuit, skip AI loop
    else if hint: prepend hint to thread, run AI loop
  AI generateText tool loop (existing)
```

Handler outcomes:
- `mute_clinic` → mute + ack reply, `handled=true`. Skip AI loop.
- `unmute_clinic` → unmute + ack reply, `handled=true`. Skip AI loop.
- `view_booking` → set `thread.activeBookingId`, return `handled=false` with hint `"User wants to review booking <id>"` so AI loop loads context.
- `get_doc` → set `thread.pendingDocRetrievalBookingId`, return `handled=false` with hint so AI loop runs `verify_patient` → `search_documents`.

Thread fields (`ThreadState` extension): `activeBookingId?`, `pendingDocRetrievalBookingId?`. Cleared on next non-button user message (same pattern as `unknownSlugThisTurn`).

## Failure Handling

- **Transient send error:** `attempts++`, retry on next 5-min tick. Cap at 3 attempts → mark failed.
- **Permanent block:** mark row failed AND insert global mute (`source='auto_block'`). Prevents future template sends piling up rejections.
- **Permanent template error:** mark row failed (no retry). Operations team must fix template config and redeploy.
- **Booking cancelled / muted between schedule and send:** sweeper's send-time re-validation marks row as terminal-failed with `last_error='cancelled:<reason>'` for debuggability.

## Testing Strategy

Mirror existing `scripts/test-*.ts` pattern. Run via `bun run test:<name>`.

### `test:reminder-scheduler` (logic, no DB writes)
- Booking 48h out → 2 jobs, correct send_at and template names
- Booking 3h out → only T-2h job
- Booking 1h out → 0 jobs (under 5-min buffer for T-2h, T-24h obviously past)
- With doctor → `*_with_doctor` template, 4 vars
- Without doctor → `*_no_doctor` template, 3 vars
- Status `pending`, `cancelled`, `reschedule_pending` → 0 jobs
- Reschedule from 48h-out → 3h-out: old rows deleted, only new T-2h inserted
- Muted clinic → 0 jobs

### `test:button-router`
- `mute_clinic:abc-123` → mutes clinic, ack reply, `handled=true`
- `view_booking:xyz` → `handled=false`, thread updated, hint returned
- `get_doc:xyz` → same with doc-retrieval thread field
- `mute_clinic:` (missing id) → null, falls through
- Random text → null, falls through

### `test:error-classifier`
- 131049, 131026, 131047 → `permanent_block`
- 132001..132010 → `permanent_template`
- 500 / network timeout → `transient`
- Unknown code → `transient`

### `test:reminder-sender` (integration, mocked Meta API)
- Seed 5 bookings: 3 confirmed + un-muted, 1 cancelled, 1 muted clinic
- `recomputeReminders` for all → 6 jobs (2 per eligible booking)
- Advance to T-24h → sweep sends 3 templates (mock Meta 200)
- Advance to T-2h → sweep sends 3 more
- Verify `sent_at` populated, no double-sends on second sweep run
- Inject 131049 → row failed + global mute inserted
- Inject 5xx then 200 → attempts=1 then sent_at populated

### `test:reminder-optout`
- Mute clinic A; recompute booking at A → 0 jobs
- Mute clinic A; recompute booking at B → 2 jobs
- `auto_block` global mute → 0 jobs at any clinic
- Auto-unmute on rebook clears `button` source only, not `auto_block`
- Manual unmute via tool flow

### Manual smoke (extend `docs/bot-test-smoke.md`)
1. Real booking 25h out → confirm 2 rows in `reminder_jobs`
2. Cron tick at T-24h → real WhatsApp delivery
3. Tap "Stop reminders" → mute confirmed in DB + ack reply received
4. New booking same clinic → mute auto-cleared, fresh rows enqueued
5. Tap "View booking" → bot replies with booking details
6. Doc upload → `doc_ready` row enqueued + delivered

### CI

Composite script `bun run test:reminders` runs all 4 unit/integration scripts. Add to existing test-suite invocation if one exists.

## Environment Variables

| Variable | Purpose |
|---|---|
| `CRON_SECRET` | Validates Vercel Cron `Authorization: Bearer` header on `/api/cron/reminders` |
| Existing `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` | Reused by `sendTemplate` |

Add to README env vars table and `.env.example`.

## Out of Scope (defer)

- Reminder audit log table (recompute model loses history; add later if support needs)
- Per-tier opt-out granularity (all reminders for a clinic share one mute)
- Multi-language templates (English only at MVP)
- Rating / NPS surveys (deliberately omitted to avoid Marketing reclassification)
- Get-directions button (omitted with address removal from T-2h template)
- Reschedule-from-template button (would require URL or rich CTA flow; defer until Meta CTA buttons evaluated)
- Reminder analytics dashboard (delivered / read / clicked rates) — future
- External booking-writer integration (clinic admin app) — daily reconcile sweep is the MVP bridge
