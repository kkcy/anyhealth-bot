# AnyHealth Bot Smoke Test Checklist

Generated on: 2026-04-16

Goal: quick confidence that core user journeys still work.

Automation command:

```bash
pnpm test:smoke
```

Show full reply text for each scenario:

```bash
pnpm test:smoke -- --full-reply
```

## Prerequisites

- [ ] Registered WhatsApp user with 1 patient.
- [ ] Registered WhatsApp user with multiple patients.
- [ ] At least one clinic/service/doctor available.
- [ ] At least one existing booking.

## Core Conversation Start

- [ ] Registered first message -> greeted by name.
- [ ] Unregistered number -> asked to register at clinic first.
- [ ] Single-patient user -> patient auto-selected.
- [ ] Multi-patient user -> asked which patient.

## Core Discovery and Booking

- [ ] Search service -> returns clinic options or auto-selects one clinic.
- [ ] Select clinic -> service list returned.
- [ ] Select service and method -> doctor/date flow proceeds.
- [ ] Availability check on open day -> hours + booked slots returned.
- [ ] Booking create happy path -> returns success and booking ID.
- [ ] Booking create with missing required field (time or address) -> correctly blocked.

## Core Booking Management

- [ ] View bookings -> upcoming bookings shown.
- [ ] Reschedule booking -> status becomes `reschedule_pending`.
- [ ] Cancel booking -> status becomes `cancelled`.

## Core Documents and Insurance Gating

- [ ] Search documents without verification -> blocked.
- [ ] Insurance question without verification -> blocked.
- [ ] Verify patient (valid name + IC) -> success.

## Reliability Smoke

- [ ] Duplicate webhook message ID is processed only once.
- [ ] Bot returns graceful fallback on runtime/tool failure.

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
1. From a thread that already has `activeClinicId` set (or any other booking-scope field: `activeServiceId`, `activeDoctorId`, `lastSearchQuery`), send `Hi! I'd like to book at Some Other Clinic`.
2. Expect: bot does NOT switch clinics. The message is forwarded to the LLM as-is.
3. Reason: friendly-prefill parser only fires when no booking is in progress.

### Scenario: friendly prefill, unknown clinic name
1. Fresh thread (no booking-scope state set). Send `Hi! I'd like to book at Made Up Clinic`.

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
