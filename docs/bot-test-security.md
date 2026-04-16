# AnyHealth Bot Security and Abuse Test Checklist

Generated on: 2026-04-16

Goal: verify data access controls, sensitive-flow protection, and failure handling.

## Identity and Access Control

- [ ] Unregistered WhatsApp number cannot access account data.
- [ ] Multi-patient account cannot proceed with protected actions until patient context is selected/verified as required.
- [ ] Document retrieval blocked before identity verification.
- [ ] Insurance upload/list/ask blocked before identity verification.
- [ ] Verification requires exact name + IC match (IC normalization for spaces/dashes still accepted).
- [ ] Verification lock triggers after 3 failed attempts.
- [ ] Locked user remains blocked from document/insurance access.

## Cross-Account and Ownership Safety

- [ ] Cancel booking with another user's booking ID is blocked.
- [ ] Reschedule booking with another user's booking ID is blocked.
- [ ] Document search only returns documents linked to patients under the authenticated WhatsApp user.
- [ ] Insurance query only uses policies for active verified patient.

## Data Integrity and Non-Fabrication

- [ ] Bot does not claim booking confirmed unless tool returns success.
- [ ] Bot surfaces tool errors and does not mask failure as success.
- [ ] Bot does not invent clinic names, doctor details, prices, or coverage facts.
- [ ] Insurance Q&A answers only from policy content.
- [ ] Missing policy data returns explicit not-found behavior.

## Input Validation and Guardrails

- [ ] Invalid selection indexes (patient/clinic/service/method/doctor) are rejected with safe error.
- [ ] Invalid time format is rejected in booking.
- [ ] Required conditional inputs are enforced (time/address/new-patient flag).
- [ ] Booking cannot proceed without explicit user confirmation.

## Webhook and Messaging Robustness

- [ ] Duplicate webhook message IDs are deduplicated within TTL window.
- [ ] Webhook exceptions return HTTP 200 error-handled response to avoid replay storms.
- [ ] Rapid incoming messages are serialized by queue concurrency.

## Sensitive Document and Insurance Handling

- [ ] Scanned/non-text PDF upload fails gracefully (no partial unsafe state).
- [ ] Policy text too short/empty blocks insurance Q&A.
- [ ] Upload failure paths do not leak internal secrets in user-visible messages.

## Environment and Deployment Safety

- [ ] Missing required env vars cause immediate startup failure.
- [ ] Supabase credentials missing cause explicit failure at client init.

## Known Security-Relevant Gaps

- [ ] PDF extraction is not implemented yet; insurance upload cannot complete securely end-to-end.
- [ ] Review whether booking view should support strict patient-level filtering in addition to user ownership.

