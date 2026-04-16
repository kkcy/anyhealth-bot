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
