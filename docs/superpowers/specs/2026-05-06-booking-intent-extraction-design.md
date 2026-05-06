# Booking Intent Extraction — Design

**Date:** 2026-05-06
**Status:** Approved (pending implementation)
**Owner:** kkcy

## Problem

Today the WhatsApp bot's booking flow is strictly deterministic: service → clinic → method → (new patient?) → (doctor?) → date → time → confirm. Every step requires a separate turn. When a user opens with a fully-formed intent like *"book for gp tomorrow 9am"*, the bot ignores the supplied slots and walks them through every step anyway. Result: 5–7 turns to reach confirmation when 1 should suffice.

## Goal

Pre-fill booking state from free-form user input on the first booking-intent turn (or any re-entry turn that has no booking in flight), skipping every deterministic prompt whose slot is already supplied. When all slots resolve cleanly and availability is free, present a single fast-path confirmation card and create the booking on Yes. When any slot fails to resolve, fall through to the existing deterministic flow with whichever slots were extracted already filled.

Non-goal: replace the deterministic flow. Extraction is purely additive; if the LLM never calls the extractor, the bot behaves exactly as today.

## Approach

A new tool, `extract_booking_intent`, is registered alongside `create_booking` in `src/bot/tools/booking.ts`. Its Zod schema declares structured slots; the main LLM parses the user's message and calls the tool with whatever slots it can extract. The tool body validates each slot, merges into a new `state.extractedIntent` field, and returns a directive telling the LLM which existing tool to call next (typically `search_services` with the extracted keyword).

Each downstream deterministic step consults `state.extractedIntent` and skips its prompt when the relevant slot is filled. When all required slots resolve and availability is free, the bot posts a single confirmation card. On No, an interactive list lets the user edit one slot at a time. Free-text corrections (e.g. *"make it 10am"*) are routed back through `extract_booking_intent`, which patches the slot and re-checks availability.

## Architecture

### New tool: `extract_booking_intent`

Location: `src/bot/tools/booking.ts`.

Zod input:

```ts
{
  serviceKeyword: z.string().min(1).optional()
    .describe("Service the user wants, as a search keyword (e.g. 'gp', 'flu shot', 'house call'). Pass user's exact words; do NOT translate or canonicalize."),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe("ISO date YYYY-MM-DD. Resolve relative dates ('tomorrow', 'next Monday') against the Today line in the system prompt."),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional()
    .describe("24h HH:mm. Convert '9am' → '09:00', '3pm' → '15:00'."),
  method: z.enum(["in_clinic", "house_call", "video"]).optional()
    .describe("Only if the user explicitly mentioned it."),
  isNewPatient: z.boolean().optional()
    .describe("Only if the user said 'new patient' / 'first visit' / similar."),
}
```

Tool body responsibilities, in order:

1. **Re-entry guard.** Two cases:
   - **Confirm-card edit carve-out.** If `state.pendingBooking` is set AND at least one supplied slot differs from current state (e.g. `time` arg `"10:00"` differs from `pendingBooking.time` `"09:00"`, or `date` arg differs from `pendingBookingDate`, or `serviceKeyword` differs from the active service's name keyword), proceed with merge. The downstream prompt is responsible for clearing the affected post-resolution slot (e.g. `pendingBooking.time`) and re-running availability.
   - **Otherwise block.** If any of `state.pendingBooking`, `state.activeBookingId`, `state.pendingDocRetrievalBookingId`, `state.activeServiceId`, `state.awaitingAddress`, `state.awaitingTime`, `state.awaitingDate`, `state.awaitingDocVerification`, `state.awaitingRemark` is set, return `{skipped: true, reason: "<which guard fired>"}` without modifying state.
2. **Past-date validation.** If `date` is set and is before today (resolved in clinic timezone, default `Asia/Kuala_Lumpur`), return `{error: "date_in_past"}` and do not merge.
3. **Merge.** Set `state.extractedIntent` to a new object containing only the validated slots. Do not write to the post-resolution slots (`activeServiceId`, `activeMethodId`, `pendingBookingDate`, etc.); those are populated by the deterministic chain consuming `extractedIntent`.
4. **Directive.** Return `{ extracted: {...}, nextAction: "search_services" | null, nextArgs: {...} | null }`. Today the only directive is `search_services` whenever `serviceKeyword` is set; otherwise `nextAction: null` and the LLM continues with the existing flow.

### State changes

`src/types.ts`:

```ts
extractedIntent?: {
  serviceKeyword?: string;
  date?: string;        // ISO YYYY-MM-DD
  time?: string;        // HH:mm
  method?: "in_clinic" | "house_call" | "video";
  isNewPatient?: boolean;
};
awaitingRemark?: boolean;
```

`extractedIntent` is cleared:
- when `create_booking` returns success
- when the user cancels (`cancel_booking` row in the edit picker)
- when `clearStateForSessionGap` fires (existing function — add the field to its clear list)

`awaitingRemark` is one-shot: set when the user picks "Add a note" in the edit picker, cleared on the next plain-text turn.

### Deterministic chain consumption

Each existing step reads `state.extractedIntent` and skips its prompt when the relevant slot is filled.

| Step | Behavior with intent slot present |
|---|---|
| `search_services` | LLM calls with `query: extractedIntent.serviceKeyword`. Existing tool unchanged. |
| `select_clinic` | If exactly one clinic returned, auto-select (existing). Else clinic picker (existing). |
| `select_service` | If exactly one service returned post-clinic-select, auto-select. Else service picker. |
| Method | Auto-pick if `extractedIntent.method` matches a method offered by the chosen service; else method picker. |
| `pendingIsNewPatient` | If clinic has `newPatientLimit !== null` and `extractedIntent.isNewPatient !== undefined`, set `pendingIsNewPatient` from intent and skip the prompt. Else prompt. |
| Doctor | Existing flow (extraction does not pre-fill doctor). |
| Date | If `extractedIntent.date` set, call `get_clinic_availability` directly with that date. If clinic closed that day, fall to date picker with a one-line note. |
| Time | If `extractedIntent.time` set, check availability for that exact slot. If free, stage in `pendingBooking.time` and proceed. If taken, fall to time picker for that date. |

### Fast-path confirm card

After the deterministic chain runs, the LLM is instructed: if `activeClinicId`, `activeServiceId`, `activeMethodId`, `pendingBookingDate`, `pendingBooking.time` are all set AND `pendingIsNewPatient` is resolved (or not required) AND no doctor selection is pending AND (method does not require address OR `pendingBooking.address` is set), post a single confirmation message of the form:

> Confirm booking:
> • <service> at <clinic>
> • <date>, <time>
> • <method>
> • [Address: <address>] *(only if applicable)*
>
> Tap Yes to confirm or No to edit.

The message contains the words "confirm" and "booking" so the existing interactive-rendering layer in `src/bot/index.ts` renders Yes/No buttons. On Yes, the existing handler calls `create_booking` with staged args. The LLM does NOT call `create_booking` until the user confirms.

Reminder remark is omitted on the fast path. Users who want to add one tap No → "Add a note" in the edit picker.

If method requires address and `extractedIntent` did not include one, fast-path is not triggered; the existing flow asks for address, then re-evaluates fast-path conditions.

### Edit picker (No button)

When the user taps No, the deterministic interactive switch in `src/bot/index.ts` renders an interactive list:

> What would you like to change?
> • Service
> • Date
> • Time
> • Method
> • Add a note
> • Cancel booking

Row IDs and handlers:

| Row ID | Action |
|---|---|
| `edit_service` | Clear `activeServiceId`, `activeMethodId`, `pendingBookingDate`, `pendingBooking`, `extractedIntent.serviceKeyword`. Re-render service picker for current clinic. |
| `edit_date` | Clear `pendingBookingDate`, `pendingBooking`. Re-render date list. |
| `edit_time` | Clear `pendingBooking.time`. Re-render time picker for current `pendingBookingDate`. |
| `edit_method` | Clear `activeMethodId`, `pendingBookingDate`, `pendingBooking`. Re-render method picker for current service. |
| `edit_note` | Set `awaitingRemark = true`. Send "Type your note." Next plain-text turn captures into `pendingBooking.reminderRemark` and re-renders confirm card. |
| `cancel_booking` | Clear all booking state (`activeClinicId`, `activeServiceId`, `activeMethodId`, `activeDoctorId`, `pendingBooking*`, `extractedIntent`). Acknowledge and stop. |

After any single-slot edit completes, the flow re-evaluates fast-path conditions and re-posts the confirm card.

### Free-text edits

Prompt addition:

> If the user replies to a confirmation summary with a correction (e.g. "make it 10am", "Wednesday instead", "actually new patient"), call `extract_booking_intent` again with only the changed slot.

The tool body's re-entry guard (see Architecture §1) has a confirm-card carve-out: when `pendingBooking` is set AND a supplied slot differs from current state, the guard allows the merge. The prompt then instructs the LLM to clear the downstream slot affected by the change (`pendingBooking.time` for a time edit, `pendingBookingDate` for a date edit, etc.) and re-run availability before re-posting the confirm card.

Alternative considered: make the LLM call `cancel_booking` first, then `extract_booking_intent`. Rejected because it loses the unchanged slots and forces a full re-extract.

### Prompt additions

`src/bot/prompt.ts` — add a new section after "Booking flow":

> ## Extracting booking intent up-front
> If the user's message contains any combination of a service hint, a date, or a time (e.g. "book gp tomorrow 9am", "I'd like a flu shot next Monday at 3pm"), your FIRST tool call MUST be `extract_booking_intent` with whatever slots you can extract. Pass the user's exact wording for `serviceKeyword`. Resolve relative dates against the Today line above. Convert times to 24h HH:mm.
>
> The tool returns `{nextAction, nextArgs}`. If `nextAction` is set, immediately call that tool with `nextArgs` and continue the deterministic flow. Do NOT call `extract_booking_intent` again in the same turn.
>
> If the tool returns `{skipped: true}`, ignore extraction and follow the deterministic flow as today. If it returns `{error: "date_in_past"}`, tell the user the date is in the past and ask for a different date.
>
> If the user replies to a confirmation summary with a correction, call `extract_booking_intent` again with only the changed slot.

## Failure modes

| Condition | Behavior |
|---|---|
| Past date | Tool returns `{error: "date_in_past"}`. LLM asks for a different date. |
| Invalid time format | Zod rejects the tool call; LLM omits the time slot and falls back to time picker. |
| Service keyword returns zero results | Existing `search_services` retry-once-then-fail logic. Unchanged. |
| Service keyword returns multiple clinics | Clinic picker (existing). Date/time/method stay in `extractedIntent`. |
| Service keyword returns multiple services in chosen clinic | Service picker (existing). Date/time stay staged. |
| Method extracted but service does not offer it | Clear `extractedIntent.method`, fall to method picker with one-line note. |
| Time extracted but taken | Time picker for `pendingBookingDate`. |
| Clinic closed on extracted date | Date picker with one-line note. |
| Re-entry while booking staged | Tool returns `skipped: true`. Existing flow handles. |
| Free-text edit attempt with no actual slot change | Tool merges no-op; no resulting state change; LLM re-posts confirm card unchanged. |
| Session gap | `clearStateForSessionGap` clears `extractedIntent` along with other booking state. |

## Tests

### Unit tests (`scripts/test-tools.ts`-style)

`extract_booking_intent` with mocked state:

1. Happy path — `{serviceKeyword:"gp", date:"2026-05-07", time:"09:00"}` → returns `{nextAction:"search_services", nextArgs:{query:"gp"}}`, `state.extractedIntent` populated.
2. Past date — `date:"2020-01-01"` → returns `{error:"date_in_past"}`, state unchanged.
3. Guard fires — `state.pendingBooking` set → returns `{skipped:true, reason:"pendingBooking"}`.
4. Guard fires — `state.activeServiceId` set → returns `{skipped:true, reason:"activeServiceId"}`.
5. Partial extraction — only `serviceKeyword` → directive returned, only that slot in `extractedIntent`.
6. Free-text edit carve-out — `state.pendingBooking` set BUT new `time:"10:00"` differs from `pendingBooking.time:"09:00"` → guard relaxed, merge proceeds.

### Smoke tests (`scripts/test-smoke.ts`)

Multi-turn flows asserting tool sequence and message content:

1. **Fast path** — user: "book gp tomorrow 9am" → confirm card in one bot turn → user: "yes" → booking created. Assert: `extract_booking_intent` called once, `search_services`/`select_clinic`/`select_service`/`get_clinic_availability` all called, exactly one user-facing message before "yes", `create_booking` called once after "yes".
2. **Multi-clinic fallback** — query matches 2 clinics → clinic picker shown, then proceed with date/time pre-filled to confirm card. Assert: clinic picker shown, no date prompt, no time prompt.
3. **Time taken fallback** — extracted time conflicts → time picker shown for that date. Assert: `pendingBookingDate` set before time picker, no date prompt.
4. **Method mismatch** — extracted `method:"video"` but service in-clinic only → method picker shown with note.
5. **Edit picker — change time** — fast-path confirm → No → "Time" → pick → re-confirm. Assert: clinic/service/date unchanged across edit.
6. **Free-text edit** — fast-path confirm → "make it 10am" → `extract_booking_intent` called with only time slot, availability re-checked, confirm card re-posted with new time.
7. **Guard re-entry** — user mid-flow says "actually flu shot" → `extract_booking_intent` returns `skipped:true`; existing flow handles intent change via service picker.
8. **No booking intent** — user: "what services do you offer?" → extractor not called, existing search-only behavior.
9. **Past date** — user: "book gp last Monday 9am" → `extract_booking_intent` returns `date_in_past`; bot asks for a different date.

### Existing tests

`scripts/test-guards.ts` (11 tests) must continue to pass without changes — extraction is additive.

## Out of scope

- Pre-resolving `activeClinicId` from a clinic name in user text (Q2-C). Defer.
- Pre-resolving `activeDoctorId` from doctor name. Defer.
- Multi-language extraction quality tuning. Rely on the main LLM's existing language handling.
- Pagination on the edit picker. Six rows max — fits one WhatsApp interactive list.
- Persistence of `extractedIntent` across session gaps. Cleared with the rest of booking state.

## Open questions resolved during brainstorming

| Question | Decision |
|---|---|
| Where does parsing live? | LLM fills Zod schema; tool validates and merges. No nested LLM call. |
| Which slots? | `serviceKeyword`, `date`, `time`, `method`, `isNewPatient`. |
| When does extraction run? | Any turn with no booking in flight (`pendingBooking`, `activeBookingId`, `activeServiceId`, etc. all unset). |
| Confirm UX? | Hybrid — single fast-path card when all slots clear and availability free; otherwise skip-filled deterministic flow. |
| Ambiguity / parse-failure? | Silent fallback — extractor only emits a slot if confident; confirm card is the safety net. |
| Edit UX? | No button → interactive edit picker. Free-text corrections also patch state via the same tool. |
