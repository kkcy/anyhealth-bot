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
2. Expect: parser matches but resolver returns null. No state change. LLM responds normally without claiming the clinic exists.
