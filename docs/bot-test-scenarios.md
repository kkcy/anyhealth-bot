# AnyHealth Bot Test Scenarios

Generated on: 2026-04-16

Use this as a QA checklist for current bot capabilities.

Split checklists:
- Smoke: `docs/bot-test-smoke.md`
- Regression: `docs/bot-test-regression.md`
- Security: `docs/bot-test-security.md`
- Automation guide: `docs/bot-test-automation.md`

## Setup Cases

- [ ] Registered WhatsApp user with 1 patient.
- [ ] Registered user with multiple linked patients.
- [ ] Unregistered WhatsApp number.
- [ ] Clinic with doctor selection ON (multiple doctors).
- [ ] Clinic with doctor selection OFF.
- [ ] Service with one method, multiple methods, and no methods.
- [ ] Method that requires time, and method that does not.
- [ ] Method that requires address (house call).
- [ ] Clinic with `new_patient_limit` and one without.
- [ ] Existing bookings in multiple statuses (`pending`, `reschedule_pending`, `cancelled`, `declined`).

## A. Entry, Identity, Language

- [ ] First message from registered user -> user greeted by name.
- [ ] First message from unregistered user -> told to register at clinic first.
- [ ] Single-patient user -> patient auto-selected.
- [ ] Multi-patient user -> bot asks who to act for.
- [ ] Invalid patient index selection -> clear error with valid range.
- [ ] Language preference returned by lookup -> bot responds in that language.
- [ ] User writes in different language than preference -> bot follows user message language.
- [ ] Relative date phrases (`tomorrow`, `next Monday`) resolve correctly.

## B. Service Discovery

- [ ] Search query returns multiple clinics -> bot presents numbered clinic list.
- [ ] Search query returns single clinic -> clinic auto-selected and services shown.
- [ ] No search result -> retry with simpler keyword once, then fail gracefully.
- [ ] Invalid clinic index -> clear correction prompt.
- [ ] Service list includes duration/price only when available.
- [ ] Service with no methods -> treated as in-clinic visit.
- [ ] Service with one method -> method auto-selected.
- [ ] Service with multiple methods -> bot asks for method selection.
- [ ] Invalid method index -> error + valid options.
- [ ] Doctor selection required clinic -> doctor step enforced.
- [ ] Doctor selection disabled clinic -> doctor auto-assigned or skipped.
- [ ] Single doctor -> auto-selected.
- [ ] Multiple doctors -> numbered doctor list.
- [ ] Invalid doctor index -> clear error.

## C. Availability Logic

- [ ] Open day -> returns hours + booked slots.
- [ ] Closed day -> clear `clinic closed` response.
- [ ] Holiday date -> clear holiday closure response.
- [ ] With selected doctor -> booked slots filtered to that doctor.
- [ ] Without selected doctor -> booked slots from clinic doctors.
- [ ] Lunch break returned and respected in recommendations.
- [ ] `isNewPatient=true` with limit -> slots-at-limit info returned.
- [ ] Clinic with zero doctors -> returns hours with empty booked slots.

## D. Booking Creation (Happy Paths)

- [ ] Standard booking (requires time) succeeds.
- [ ] Date-only method booking succeeds without time.
- [ ] House-call booking succeeds with address.
- [ ] Booking includes reminder remark and returns it in confirmation.
- [ ] New patient booking within allowed slot limit succeeds.
- [ ] Booking confirmation only after explicit user confirmation.

## E. Booking Validation and Failure Paths

- [ ] Try booking without `confirmed=true` -> blocked.
- [ ] Try booking without selected service/clinic -> blocked.
- [ ] Doctor required but not selected -> blocked with doctor options.
- [ ] Selected doctor not in clinic -> blocked.
- [ ] Method requires time but time missing -> blocked.
- [ ] Method requires address but address missing -> blocked.
- [ ] Invalid time format -> blocked.
- [ ] Clinic has new patient limit but `isNewPatient` not provided -> blocked.
- [ ] New patient slot limit exceeded -> blocked with limit context.
- [ ] After successful booking, prior service/doctor selections are cleared.

## F. View, Reschedule, Cancel

- [ ] View upcoming bookings when records exist.
- [ ] View bookings when none exist.
- [ ] Ensure `cancelled` and `declined` are excluded from upcoming list.
- [ ] Reschedule date only -> status becomes `reschedule_pending`.
- [ ] Reschedule date+time -> status becomes `reschedule_pending`.
- [ ] Reschedule booking not owned by user -> blocked.
- [ ] Reschedule cancelled/declined booking -> blocked.
- [ ] Cancel active booking -> status becomes `cancelled`.
- [ ] Cancel already cancelled booking -> idempotent response.
- [ ] Cancel or reschedule invalid booking ID -> clear error.

## G. Documents (Security and Retrieval)

- [ ] Request documents without verification -> blocked.
- [ ] Verify patient with correct full name + IC -> success.
- [ ] Verify with wrong credentials attempt 1 and 2 -> remaining attempts shown.
- [ ] Third failed verification -> lockout message.
- [ ] After lockout, document search stays blocked.
- [ ] Search documents by date range.
- [ ] Search documents by diagnosis/remark keyword.
- [ ] Search with no matches -> clear `no records found`.
- [ ] Returned result includes consultation report + related docs when available.
- [ ] Multi-patient account: search can return linked patient records after verification.

## H. Insurance

- [ ] Upload policy without verification -> blocked.
- [ ] List policies without verification -> blocked.
- [ ] Ask policy question without verification -> blocked.
- [ ] Verified patient with no policies -> clear onboarding message.
- [ ] Ask question with existing policy -> answer grounded in policy text.
- [ ] Ask with explicit policy ID -> uses correct policy.
- [ ] Ask with no policy found -> clear error.
- [ ] Ask out-of-scope question -> `This is not mentioned in your policy.`
- [ ] Upload non-text/scanned PDF -> extraction failure handled gracefully.

## I. Reliability, Safety, Ops

- [ ] Duplicate WhatsApp webhook message ID -> processed once.
- [ ] Rapid consecutive messages -> queue behavior keeps ordering stable.
- [ ] Very long conversation -> still works with session history cap.
- [ ] Tool/database failure -> user gets graceful error.
- [ ] LLM no-text fallback -> safe fallback reply is sent.
- [ ] Bot does not claim booking success unless booking tool succeeds.
- [ ] Bot does not invent clinic/doctor/price data not returned by tools.
- [ ] Startup with missing required env vars -> hard fail with explicit missing keys.

## Known Current Gaps to Track

- [ ] Insurance upload end-to-end cannot fully pass until PDF extraction is implemented (`extractTextFromPdf` currently throws).
- [ ] Validate patient-level filtering behavior for bookings (current flow may be user-scoped rather than patient-scoped).
