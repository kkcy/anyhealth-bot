# AnyHealth Bot Regression Test Checklist

Generated on: 2026-04-16

Goal: broader functional coverage before releases.

## Setup and Data Shapes

- [ ] Registered user with 1 patient.
- [ ] Registered user with multiple patients.
- [ ] Clinic with doctor selection ON and OFF.
- [ ] Services with no method, one method, and multiple methods.
- [ ] Method requiring time.
- [ ] Method requiring address.
- [ ] Clinic with `new_patient_limit`.
- [ ] Mixed booking statuses (`pending`, `reschedule_pending`, `cancelled`, `declined`).

## Entry, Identity, Language

- [ ] Invalid patient index -> error with valid range.
- [ ] Preferred language is respected.
- [ ] User message language overrides preferred language.
- [ ] Relative date phrases resolve correctly.

## Service Discovery

- [ ] Multi-clinic search flow works.
- [ ] Single-clinic auto-select flow works.
- [ ] No-result flow retries once with simpler query.
- [ ] Invalid clinic index handled.
- [ ] Price shown only when non-null.
- [ ] Service with no methods defaults to in-clinic.
- [ ] One method auto-selects.
- [ ] Multiple methods require explicit selection.
- [ ] Invalid method index handled.

## Doctor and Availability

- [ ] Doctor selection required clinic enforces select-doctor step.
- [ ] Doctor selection disabled clinic auto-assigns doctor.
- [ ] Single doctor auto-selected.
- [ ] Multiple doctors listed with indexes.
- [ ] Invalid doctor index handled.
- [ ] Closed day availability returns closed.
- [ ] Holiday availability returns holiday closure.
- [ ] Selected doctor filters booked slots correctly.
- [ ] No doctor selected uses clinic doctor scope.
- [ ] Lunch break is returned.
- [ ] `isNewPatient=true` returns slots-at-limit data.
- [ ] Zero-doctor clinic returns open day with empty slots.

## Booking Create (Validation Coverage)

- [ ] Missing `confirmed=true` blocks booking.
- [ ] Missing selection context blocks booking.
- [ ] Selected doctor outside clinic blocks booking.
- [ ] Time-required method without time blocks booking.
- [ ] Address-required method without address blocks booking.
- [ ] Invalid time format blocks booking.
- [ ] `new_patient_limit` clinic with missing `isNewPatient` blocks booking.
- [ ] New patient slot limit exceeded blocks booking.
- [ ] Successful booking clears in-thread selection state.

## View, Reschedule, Cancel

- [ ] View shows only upcoming (excludes cancelled/declined).
- [ ] View shows empty state when none.
- [ ] Reschedule date-only works.
- [ ] Reschedule date+time works.
- [ ] Reschedule not-owned booking blocked.
- [ ] Reschedule cancelled/declined blocked.
- [ ] Cancel active booking works.
- [ ] Cancel already-cancelled returns idempotent response.
- [ ] Invalid booking ID for cancel/reschedule handled.

## Documents

- [ ] Verification attempt 1/2 failure shows attempts remaining.
- [ ] Third failure locks verification.
- [ ] Post-lockout document access remains blocked.
- [ ] Date range document search works.
- [ ] Diagnosis keyword search works.
- [ ] No-match path returns clear message.
- [ ] Result includes consult report + related docs (MC/invoice/referral) when available.
- [ ] Multi-patient linked account documents are discoverable post-verification.

## Insurance

- [ ] List policies with none returns onboarding message.
- [ ] Ask insurance with explicit policy ID uses that policy.
- [ ] Ask insurance with no policy returns clear error.
- [ ] Out-of-scope coverage question returns policy-not-mentioned response.

## Operational Safeguards

- [ ] Queue behavior preserves ordering for rapid incoming messages.
- [ ] Session message cap behavior remains stable.
- [ ] Missing env vars fail fast with clear missing key list.
- [ ] Bot never confirms booking success unless `create_booking` succeeds.
- [ ] Bot does not fabricate clinic/doctor/price data not in tool output.

## Current Known Gaps

- [ ] Insurance upload end-to-end remains blocked until PDF extraction is implemented.
- [ ] Validate whether view bookings behavior should be patient-filtered or user-scoped.

