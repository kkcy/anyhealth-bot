# Booking Intent Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Short-circuit the WhatsApp bot's deterministic booking flow when the user supplies service/date/time/method up front, posting a single fast-path confirm card and falling back to the existing flow on any unresolved slot.

**Architecture:** A new `extract_booking_intent` tool (registered alongside `create_booking` in `src/bot/tools/booking.ts`) accepts structured slots from the LLM, validates them, and merges into a new `state.extractedIntent` field. The system prompt instructs the LLM to call this tool first whenever the user's message contains booking intent, then chain into the existing tools (`search_services`, `select_clinic`, `select_service`, `get_clinic_availability`, `create_booking`) using the extracted slots as args. No changes to those existing tools — short-circuiting falls out of slot-driven prompting. A new "edit picker" interactive list replaces the current free-text "what would you like to change?" reply when the user taps No on a confirm card.

**Tech Stack:** TypeScript, Vercel AI SDK (tool definition), Zod (schema), Supabase, WhatsApp Cloud API.

**Spec:** `docs/superpowers/specs/2026-05-06-booking-intent-extraction-design.md`

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/types.ts` | Modify | Add `extractedIntent` and `awaitingRemark` to `ThreadState`. |
| `src/bot/tools/booking.ts` | Modify | Add `extract_booking_intent` tool. |
| `src/bot/prompt.ts` | Modify | New "Extracting booking intent" section + tweaks to "Booking flow" to consume pre-filled slots. |
| `src/bot/index.ts` | Modify | Add edit-picker render on `booking_confirm_no`; add handlers for `edit_*` and `cancel_booking` rows; add `awaitingRemark` plain-text capture; add `extractedIntent` and `awaitingRemark` to the session-gap clear list. |
| `scripts/test-tools.ts` | Reference only | Existing single-prompt harness stays as-is; we add a new dedicated unit-test script. |
| `scripts/test-extract-intent.ts` | Create | New unit-test script targeting `extract_booking_intent` directly without an LLM. |
| `scripts/test-smoke.ts` | Modify | Add smoke cases for fast path, fallbacks, edit picker, free-text edits. |

---

## Task 1: Add state fields

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1.1: Add `extractedIntent` and `awaitingRemark` to `ThreadState`**

Append the following fields to the `ThreadState` interface in `src/types.ts`, immediately after the existing `awaitingDocVerification` field (last field today):

```ts
  /**
   * Pre-resolution slots extracted from free-form user input by
   * extract_booking_intent. Consumed by the deterministic chain to skip
   * prompts when the slot is supplied. Cleared on booking commit, explicit
   * cancel, or session gap.
   */
  extractedIntent?: {
    serviceKeyword?: string;
    date?: string; // ISO YYYY-MM-DD
    time?: string; // 24h HH:mm
    method?: "in_clinic" | "house_call" | "video";
    isNewPatient?: boolean;
  };

  /**
   * Set when the user picks "Add a note" in the edit picker. The next
   * plain-text turn is captured into pendingBooking.reminderRemark and
   * the confirm card is re-posted.
   */
  awaitingRemark?: boolean;
```

- [ ] **Step 1.2: Verify TypeScript compiles**

Run: `bun x tsc --noEmit`
Expected: No new errors. (Pre-existing dependency errors unrelated to this change are acceptable — note them and continue.)

- [ ] **Step 1.3: Commit**

```bash
git add src/types.ts
git commit -m "feat(bot): add extractedIntent and awaitingRemark to ThreadState"
```

---

## Task 2: Create `extract_booking_intent` tool — schema and happy path

**Files:**
- Modify: `src/bot/tools/booking.ts`
- Create: `scripts/test-extract-intent.ts`

- [ ] **Step 2.1: Write the failing test — happy path**

Create `scripts/test-extract-intent.ts` with this content:

```ts
import "dotenv/config";
import { createBookingTools } from "../src/bot/tools/booking";
import type { ThreadState } from "../src/types";

type TestCase = {
  name: string;
  state: Partial<ThreadState>;
  args: Record<string, unknown>;
  expect: (result: unknown, finalState: ThreadState) => string | null; // null = pass, string = failure message
};

const baseState = (overrides: Partial<ThreadState> = {}): ThreadState => ({
  phone: "60123456789",
  verified: false,
  verifyAttempts: 0,
  ...overrides,
});

const cases: TestCase[] = [
  {
    name: "happy path — all slots",
    state: {},
    args: { serviceKeyword: "gp", date: "2099-05-07", time: "09:00", method: "in_clinic" },
    expect: (result, st) => {
      const r = result as any;
      if (r?.nextAction !== "search_services") return `expected nextAction=search_services, got ${r?.nextAction}`;
      if (r?.nextArgs?.query !== "gp") return `expected nextArgs.query=gp, got ${r?.nextArgs?.query}`;
      if (st.extractedIntent?.serviceKeyword !== "gp") return "serviceKeyword not stored";
      if (st.extractedIntent?.date !== "2099-05-07") return "date not stored";
      if (st.extractedIntent?.time !== "09:00") return "time not stored";
      if (st.extractedIntent?.method !== "in_clinic") return "method not stored";
      return null;
    },
  },
];

async function run() {
  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    const state = baseState(c.state);
    const updateState = async (partial: Partial<ThreadState>) => {
      Object.assign(state, partial);
    };
    const tools = createBookingTools(state, updateState);
    const tool = (tools as any).extract_booking_intent;
    if (!tool) {
      console.log(`FAIL: ${c.name} — extract_booking_intent tool not registered`);
      fail++;
      continue;
    }
    const raw = await tool.execute(c.args);
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const err = c.expect(parsed, state);
    if (err) {
      console.log(`FAIL: ${c.name} — ${err}`);
      fail++;
    } else {
      console.log(`PASS: ${c.name}`);
      pass++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `bun run scripts/test-extract-intent.ts`
Expected: `FAIL: happy path — all slots — extract_booking_intent tool not registered` and exit code 1.

- [ ] **Step 2.3: Implement `extract_booking_intent` (skeleton + happy path)**

Edit `src/bot/tools/booking.ts`. Inside the `return { ... }` block of `createBookingTools` (after the existing `create_booking: tool({...})` definition, before the closing brace), add:

```ts
    extract_booking_intent: tool({
      description:
        "Extract pre-filled booking slots from a user's free-text message. " +
        "Call this BEFORE search_services whenever the message mentions a service, date, or time. " +
        "Pass only slots you can extract with confidence. Returns a directive telling you which tool to call next.",
      inputSchema: z.object({
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
      }),
      execute: async ({ serviceKeyword, date, time, method, isNewPatient }) => {
        // Build merged intent (only include defined slots).
        const merged: NonNullable<ThreadState["extractedIntent"]> = {
          ...(state.extractedIntent ?? {}),
        };
        if (serviceKeyword !== undefined) merged.serviceKeyword = serviceKeyword;
        if (date !== undefined) merged.date = date;
        if (time !== undefined) merged.time = time;
        if (method !== undefined) merged.method = method;
        if (isNewPatient !== undefined) merged.isNewPatient = isNewPatient;

        await updateState({ extractedIntent: merged });

        const nextAction = merged.serviceKeyword ? "search_services" : null;
        const nextArgs = merged.serviceKeyword ? { query: merged.serviceKeyword } : null;

        return JSON.stringify({
          extracted: merged,
          nextAction,
          nextArgs,
        });
      },
    }),
```

- [ ] **Step 2.4: Run test to verify it passes**

Run: `bun run scripts/test-extract-intent.ts`
Expected: `PASS: happy path — all slots` and `1 passed, 0 failed`.

- [ ] **Step 2.5: Commit**

```bash
git add src/bot/tools/booking.ts scripts/test-extract-intent.ts
git commit -m "feat(bot): add extract_booking_intent tool with happy path"
```

---

## Task 3: Past-date validation

**Files:**
- Modify: `src/bot/tools/booking.ts`
- Modify: `scripts/test-extract-intent.ts`

- [ ] **Step 3.1: Write the failing test — past date rejected**

Append to the `cases` array in `scripts/test-extract-intent.ts`:

```ts
  {
    name: "past date returns date_in_past error and does not store date",
    state: {},
    args: { date: "2020-01-01", time: "09:00" },
    expect: (result, st) => {
      const r = result as any;
      if (r?.error !== "date_in_past") return `expected error=date_in_past, got ${JSON.stringify(r)}`;
      if (st.extractedIntent?.date) return `date should not be stored, got ${st.extractedIntent.date}`;
      // Other slots also should not be stored when validation fails.
      if (st.extractedIntent?.time) return `no slots should be stored on validation error`;
      return null;
    },
  },
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `bun run scripts/test-extract-intent.ts`
Expected: `FAIL: past date returns date_in_past error and does not store date` (the tool currently stores the date instead of rejecting).

- [ ] **Step 3.3: Implement past-date validation**

Edit `src/bot/tools/booking.ts`. Above the `createBookingTools` function (alongside the other helpers like `parseTimeToMinutes`), add:

```ts
function isPastDate(iso: string): boolean {
  // Resolve "today" in clinic timezone (default Asia/Kuala_Lumpur).
  const tz = process.env.CLINIC_TIMEZONE || "Asia/Kuala_Lumpur";
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const todayIso = fmt.format(now); // YYYY-MM-DD
  return iso < todayIso;
}
```

Then in the `extract_booking_intent` `execute` body, replace its current contents with:

```ts
      execute: async ({ serviceKeyword, date, time, method, isNewPatient }) => {
        if (date !== undefined && isPastDate(date)) {
          return JSON.stringify({ error: "date_in_past" });
        }

        const merged: NonNullable<ThreadState["extractedIntent"]> = {
          ...(state.extractedIntent ?? {}),
        };
        if (serviceKeyword !== undefined) merged.serviceKeyword = serviceKeyword;
        if (date !== undefined) merged.date = date;
        if (time !== undefined) merged.time = time;
        if (method !== undefined) merged.method = method;
        if (isNewPatient !== undefined) merged.isNewPatient = isNewPatient;

        await updateState({ extractedIntent: merged });

        const nextAction = merged.serviceKeyword ? "search_services" : null;
        const nextArgs = merged.serviceKeyword ? { query: merged.serviceKeyword } : null;

        return JSON.stringify({
          extracted: merged,
          nextAction,
          nextArgs,
        });
      },
```

- [ ] **Step 3.4: Run tests to verify both pass**

Run: `bun run scripts/test-extract-intent.ts`
Expected: `2 passed, 0 failed`.

- [ ] **Step 3.5: Commit**

```bash
git add src/bot/tools/booking.ts scripts/test-extract-intent.ts
git commit -m "feat(bot): reject past dates in extract_booking_intent"
```

---

## Task 4: Re-entry guard with confirm-card carve-out

**Files:**
- Modify: `src/bot/tools/booking.ts`
- Modify: `scripts/test-extract-intent.ts`

- [ ] **Step 4.1: Write failing tests — guard cases**

Append to the `cases` array in `scripts/test-extract-intent.ts`:

```ts
  {
    name: "guard fires when activeServiceId is set",
    state: { activeServiceId: "svc-abc" },
    args: { serviceKeyword: "gp", date: "2099-05-07" },
    expect: (result, st) => {
      const r = result as any;
      if (r?.skipped !== true) return `expected skipped=true, got ${JSON.stringify(r)}`;
      if (r?.reason !== "activeServiceId") return `expected reason=activeServiceId, got ${r?.reason}`;
      if (st.extractedIntent) return `extractedIntent should not be set, got ${JSON.stringify(st.extractedIntent)}`;
      return null;
    },
  },
  {
    name: "guard fires when awaitingAddress is set",
    state: { awaitingAddress: true },
    args: { serviceKeyword: "gp" },
    expect: (result) => {
      const r = result as any;
      if (r?.skipped !== true) return `expected skipped=true`;
      if (r?.reason !== "awaitingAddress") return `expected reason=awaitingAddress, got ${r?.reason}`;
      return null;
    },
  },
  {
    name: "confirm-card carve-out: pendingBooking set + new time differs → merge",
    state: {
      activeClinicId: "c1",
      activeServiceId: "s1",
      activeMethodId: "m1",
      pendingBookingDate: "2099-05-07",
      pendingBooking: { date: "2099-05-07", time: "09:00" },
    },
    args: { time: "10:00" },
    expect: (result, st) => {
      const r = result as any;
      if (r?.skipped) return `expected merge, got skipped=${r.skipped} reason=${r.reason}`;
      if (st.extractedIntent?.time !== "10:00") return `expected time=10:00 in extractedIntent, got ${st.extractedIntent?.time}`;
      return null;
    },
  },
  {
    name: "confirm-card carve-out: pendingBooking set + same time → blocked",
    state: {
      activeClinicId: "c1",
      activeServiceId: "s1",
      activeMethodId: "m1",
      pendingBookingDate: "2099-05-07",
      pendingBooking: { date: "2099-05-07", time: "09:00" },
    },
    args: { time: "09:00" },
    expect: (result) => {
      const r = result as any;
      if (r?.skipped !== true) return `expected skipped=true (no diff), got ${JSON.stringify(r)}`;
      return null;
    },
  },
  {
    name: "confirm-card carve-out: pendingBooking set + new date differs → merge",
    state: {
      activeClinicId: "c1",
      activeServiceId: "s1",
      activeMethodId: "m1",
      pendingBookingDate: "2099-05-07",
      pendingBooking: { date: "2099-05-07", time: "09:00" },
    },
    args: { date: "2099-05-08" },
    expect: (result, st) => {
      const r = result as any;
      if (r?.skipped) return `expected merge, got skipped`;
      if (st.extractedIntent?.date !== "2099-05-08") return `expected date stored`;
      return null;
    },
  },
  {
    name: "confirm-card carve-out: pendingBooking set + isNewPatient differs → merge",
    state: {
      activeClinicId: "c1",
      activeServiceId: "s1",
      activeMethodId: "m1",
      pendingBookingDate: "2099-05-07",
      pendingBooking: { date: "2099-05-07", time: "09:00" },
      pendingIsNewPatient: false,
    },
    args: { isNewPatient: true },
    expect: (result, st) => {
      const r = result as any;
      if (r?.skipped) return `expected merge, got skipped`;
      if (st.extractedIntent?.isNewPatient !== true) return `expected isNewPatient=true stored`;
      return null;
    },
  },
```

- [ ] **Step 4.2: Run tests to verify they fail**

Run: `bun run scripts/test-extract-intent.ts`
Expected: at least 6 new FAIL lines (guards not implemented).

- [ ] **Step 4.3: Implement the re-entry guard with carve-out**

Edit `src/bot/tools/booking.ts`. Above the `createBookingTools` function, add:

```ts
type IntentArgs = {
  serviceKeyword?: string;
  date?: string;
  time?: string;
  method?: "in_clinic" | "house_call" | "video";
  isNewPatient?: boolean;
};

/**
 * Returns null if the merge should proceed, or a skip reason string if blocked.
 * Confirm-card carve-out: when pendingBooking is set AND a comparable slot
 * (time, date, isNewPatient) in args differs from current state, merge is allowed.
 * serviceKeyword and method are NOT comparable (no canonical state form), so
 * they cannot trigger the carve-out — service/method changes mid-confirm
 * require the user to tap No.
 */
function evaluateIntentGuard(state: ThreadState, args: IntentArgs): string | null {
  const hasConfirmCardDiff =
    !!state.pendingBooking &&
    (
      (args.time !== undefined && args.time !== state.pendingBooking.time) ||
      (args.date !== undefined && args.date !== state.pendingBookingDate) ||
      (args.isNewPatient !== undefined && args.isNewPatient !== state.pendingIsNewPatient)
    );

  if (hasConfirmCardDiff) return null; // carve-out: allow merge

  if (state.pendingBooking) return "pendingBooking";
  if (state.activeBookingId) return "activeBookingId";
  if (state.pendingDocRetrievalBookingId) return "pendingDocRetrievalBookingId";
  if (state.activeServiceId) return "activeServiceId";
  if (state.awaitingAddress) return "awaitingAddress";
  if (state.awaitingTime) return "awaitingTime";
  if (state.awaitingDate) return "awaitingDate";
  if (state.awaitingDocVerification) return "awaitingDocVerification";
  if (state.awaitingRemark) return "awaitingRemark";

  return null;
}
```

Replace the `extract_booking_intent` `execute` body with:

```ts
      execute: async ({ serviceKeyword, date, time, method, isNewPatient }) => {
        const skipReason = evaluateIntentGuard(state, { serviceKeyword, date, time, method, isNewPatient });
        if (skipReason) {
          return JSON.stringify({ skipped: true, reason: skipReason });
        }

        if (date !== undefined && isPastDate(date)) {
          return JSON.stringify({ error: "date_in_past" });
        }

        const merged: NonNullable<ThreadState["extractedIntent"]> = {
          ...(state.extractedIntent ?? {}),
        };
        if (serviceKeyword !== undefined) merged.serviceKeyword = serviceKeyword;
        if (date !== undefined) merged.date = date;
        if (time !== undefined) merged.time = time;
        if (method !== undefined) merged.method = method;
        if (isNewPatient !== undefined) merged.isNewPatient = isNewPatient;

        await updateState({ extractedIntent: merged });

        const nextAction = merged.serviceKeyword ? "search_services" : null;
        const nextArgs = merged.serviceKeyword ? { query: merged.serviceKeyword } : null;

        return JSON.stringify({
          extracted: merged,
          nextAction,
          nextArgs,
        });
      },
```

- [ ] **Step 4.4: Run all unit tests**

Run: `bun run scripts/test-extract-intent.ts`
Expected: All 8 tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add src/bot/tools/booking.ts scripts/test-extract-intent.ts
git commit -m "feat(bot): re-entry guard with confirm-card carve-out for extract_booking_intent"
```

---

## Task 5: Session-gap clear list

**Files:**
- Modify: `src/bot/index.ts`

- [ ] **Step 5.1: Add `extractedIntent` and `awaitingRemark` to the session-gap clear**

Open `src/bot/index.ts` and locate the session-gap `updateState` block near line 1466–1482:

```ts
    await updateState({
      activeClinicId: undefined,
      ...
      awaitingDate: undefined,
    });
```

Append two lines inside the call so the block ends with:

```ts
      awaitingDate: undefined,
      awaitingRemark: undefined,
      extractedIntent: undefined,
    });
```

- [ ] **Step 5.2: Verify TypeScript compiles**

Run: `bun x tsc --noEmit`
Expected: No new errors.

- [ ] **Step 5.3: Commit**

```bash
git add src/bot/index.ts
git commit -m "feat(bot): clear extractedIntent and awaitingRemark on session gap"
```

---

## Task 6: Prompt — extraction instructions and slot consumption

**Files:**
- Modify: `src/bot/prompt.ts`

- [ ] **Step 6.1: Add the extraction section and update booking flow guidance**

Open `src/bot/prompt.ts`. Locate the line beginning `## Booking flow` (line 68 today). Just BEFORE that section, insert a new section:

```
## Extracting booking intent up-front
If the user's message contains any combination of a service hint, a date, or a time (e.g. "book gp tomorrow 9am", "I'd like a flu shot next Monday at 3pm"), your FIRST tool call MUST be \`extract_booking_intent\` with whatever slots you can extract.
- Pass the user's exact wording for \`serviceKeyword\` (do not translate or canonicalize).
- Resolve relative dates against the Today line above and pass ISO YYYY-MM-DD.
- Convert times to 24h HH:mm.
- Only set \`method\` if the user explicitly mentioned in-clinic / house call / video.
- Only set \`isNewPatient\` if the user said new patient / first visit / similar.

The tool returns one of:
- \`{nextAction, nextArgs, extracted}\` — immediately call the tool named in \`nextAction\` with \`nextArgs\` and continue. Do NOT call \`extract_booking_intent\` again in the same turn.
- \`{skipped: true, reason}\` — ignore extraction and follow the deterministic flow as today.
- \`{error: "date_in_past"}\` — tell the user the date is in the past and ask for a different one.

If the user replies to a confirmation summary with a correction (e.g. "make it 10am", "Wednesday instead", "actually new patient"), call \`extract_booking_intent\` again with ONLY the changed slot. The tool will merge into state; then re-run the affected step (e.g. \`get_clinic_availability\` for a date or time change) and re-post the confirmation.

```

Then, inside the existing `## Booking flow` section, append the following bullet at the end of step 1's paragraph (the line "1. Understand what service they need → call search_services"). Replace step 1 with:

```
1. Understand what service they need. If state.extractedIntent.serviceKeyword is set (i.e. you just called extract_booking_intent), call search_services with that keyword as the query. Otherwise call search_services with the user's stated service.
```

Replace step 4's last sentence with these additions:

```
4. After a clinic is selected, present the matching services returned by the tool. These are search matches, not necessarily the clinic's complete catalogue. Say "I found these matching services", not "the clinic offers the following services". When user chooses → call select_service with the index. If the service has multiple methods, also ask which method and pass methodIndex.
   - If state.extractedIntent.method is set AND a method offered by the chosen service matches it, call select_service immediately with that method's methodIndex — do not show the method picker.
```

Replace step 5 with:

```
5. If clinic has newPatientLimit (non-null): if state.extractedIntent.isNewPatient is set, use that value (no prompt). Otherwise ask whether this booking is for a new patient.
```

Replace step 7 with:

```
7. Ask for date (and time if the method requires it, and address if required)
   - If state.extractedIntent.date is set, USE THAT EXACT DATE — do not show the date picker.
   - If the user already provided a specific date in any earlier message (e.g., "2026-04-27", "next Monday", "tomorrow"), USE THAT EXACT DATE. Do NOT default to today.
   - Resolve relative dates ("tomorrow", "next Monday") against the "Today" line above.
```

Replace step 8 with:

```
8. Call get_clinic_availability with the date the user provided. Pass that exact date — never substitute today's date.
   - If state.extractedIntent.time is set AND the slot is available, stage that time and proceed to confirmation — do NOT list all available times.
   - If the user already mentioned a specific time (e.g., "3pm"), check if that time is available. If it is, proceed to confirmation — do NOT list all available times.
   - Only show available time slots if the user hasn't specified a preferred time.
   - If the clinic is closed on the requested date, ask the user for a different date. Do NOT call search_services again — the clinic and service are already selected.
```

Add a new bullet after step 8 (before the existing step 9):

```
8a. Fast-path confirmation: if all of activeClinicId, activeServiceId, activeMethodId are set AND a date is staged AND a time is confirmed available AND newPatient is resolved (or not required) AND no doctor is pending AND (method does not require address OR address is staged), call create_booking with confirmed:false using the staged values — skip asking for a reminder remark. The user can add a note via the No-button edit picker.
```

- [ ] **Step 6.2: Verify the file is well-formed by reading it back**

Run: `bun x tsx -e 'import { buildSystemPrompt } from "./src/bot/prompt"; console.log(buildSystemPrompt({ phone: "1", verified: false, verifyAttempts: 0 }).length);'`
Expected: A number greater than 4000 prints. No syntax error.

- [ ] **Step 6.3: Commit**

```bash
git add src/bot/prompt.ts
git commit -m "feat(bot): prompt — extraction instructions and slot-driven shortcuts"
```

---

## Task 7: Replace `booking_confirm_no` with edit picker

**Files:**
- Modify: `src/bot/index.ts`

- [ ] **Step 7.1: Replace the `booking_confirm_no` handler with an edit-picker render**

In `src/bot/index.ts` find the block at lines ~941–953:

```ts
    if (interactiveReplyId === "booking_confirm_no") {
      console.log(`[DET] booking_confirm_no`);
      await updateState({
        pendingBooking: undefined,
        pendingBookingDate: undefined,
        pendingIsNewPatient: undefined,
        awaitingAddress: undefined,
        awaitingTime: undefined,
        awaitingDate: undefined,
      });
      await thread.post("No problem — what would you like to change?");
      return;
    }
```

Replace it with (keep `sendInteractivePlan` — the local helper at line ~547 — for consistency with existing call sites; do NOT clear `pendingBooking` here, the user is editing it):

```ts
    if (interactiveReplyId === "booking_confirm_no") {
      console.log(`[DET] booking_confirm_no → edit picker`);
      const sent = await sendInteractivePlan(extractPhone(thread), {
        body: "What would you like to change?",
        options: [
          { id: "edit_service", title: "Service" },
          { id: "edit_date", title: "Date" },
          { id: "edit_time", title: "Time" },
          { id: "edit_method", title: "Method" },
          { id: "edit_note", title: "Add a note" },
          { id: "cancel_booking", title: "Cancel booking" },
        ],
      });
      if (!sent) {
        await thread.post(
          "What would you like to change? Reply with: service, date, time, method, note, or cancel.",
        );
      }
      return;
    }
```

No new imports — `sendInteractivePlan` and `extractPhone` are already in scope in this file.

- [ ] **Step 7.2: Add the `edit_*` and `cancel_booking` IDs to the deterministic-tap-prefix allowlist**

Locate the array `deterministicTapPrefixes` near line 1495:

```ts
  const deterministicTapPrefixes = [
    "patient_select_",
    ...
  ];
```

Add these strings to the array:

```ts
    "edit_service",
    "edit_date",
    "edit_time",
    "edit_method",
    "edit_note",
    "cancel_booking",
```

- [ ] **Step 7.3: Verify TypeScript compiles**

Run: `bun x tsc --noEmit`
Expected: No new errors.

- [ ] **Step 7.4: Commit**

```bash
git add src/bot/index.ts
git commit -m "feat(bot): render edit picker on booking_confirm_no"
```

---

## Task 8: Edit-picker handlers

**Files:**
- Modify: `src/bot/index.ts`

- [ ] **Step 8.1: Add handlers for `edit_service`, `edit_date`, `edit_time`, `edit_method`, `cancel_booking`**

In `src/bot/index.ts`, find the section where deterministic interactive handlers are defined (near line 1016, after the comment `// Deterministic interactive handlers to avoid LLM guesswork loops.`). Insert the following handlers in that section:

```ts
  if (interactiveReplyId === "cancel_booking") {
    console.log(`[DET] cancel_booking`);
    await updateState({
      activeClinicId: undefined,
      activeServiceId: undefined,
      activeMethodId: undefined,
      activeDoctorId: undefined,
      clinicOptions: undefined,
      serviceOptions: undefined,
      doctorOptions: undefined,
      lastSearchQuery: undefined,
      pendingBooking: undefined,
      pendingBookingDate: undefined,
      pendingIsNewPatient: undefined,
      awaitingAddress: undefined,
      awaitingTime: undefined,
      awaitingDate: undefined,
      awaitingRemark: undefined,
      extractedIntent: undefined,
    });
    await thread.post("Booking cancelled. Let me know if you'd like to start a new one.");
    return;
  }

  if (interactiveReplyId === "edit_service") {
    console.log(`[DET] edit_service`);
    await updateState({
      activeServiceId: undefined,
      activeMethodId: undefined,
      pendingBookingDate: undefined,
      pendingBooking: undefined,
      awaitingAddress: undefined,
      awaitingTime: undefined,
      awaitingDate: undefined,
      extractedIntent: state.extractedIntent
        ? { ...state.extractedIntent, serviceKeyword: undefined, method: undefined, time: undefined, date: undefined }
        : undefined,
    });
    // Re-render the service picker from cached serviceOptions.
    const services = state.serviceOptions ?? [];
    if (services.length === 0) {
      await thread.post("Which service would you like? Reply with the service name.");
      return;
    }
    const sent = await sendInteractivePlan(extractPhone(thread), {
      body: "Which service?",
      options: services.slice(0, 10).map((s, i) => ({
        id: `service_select_${i + 1}`,
        title: clip(s.serviceName, 24),
        description: s.durationMinutes ? `${s.durationMinutes} min` : undefined,
      })),
    });
    if (!sent) {
      await thread.post("Which service? Reply with the service name.");
    }
    return;
  }

  if (interactiveReplyId === "edit_date") {
    console.log(`[DET] edit_date`);
    await updateState({
      pendingBookingDate: undefined,
      pendingBooking: undefined,
      awaitingTime: undefined,
      awaitingDate: undefined,
      extractedIntent: state.extractedIntent
        ? { ...state.extractedIntent, date: undefined, time: undefined }
        : undefined,
    });
    // Reuse the existing "show the date list" pathway by setting awaitingDate and prompting.
    await updateState({ awaitingDate: true });
    await thread.post("Which date would you like? Reply with a date like 2026-05-15 or tap a quick option.");
    return;
  }

  if (interactiveReplyId === "edit_time") {
    console.log(`[DET] edit_time`);
    await updateState({
      pendingBooking: state.pendingBooking ? { ...state.pendingBooking, time: undefined } : undefined,
      awaitingTime: undefined,
      extractedIntent: state.extractedIntent
        ? { ...state.extractedIntent, time: undefined }
        : undefined,
    });
    if (!state.pendingBookingDate) {
      await thread.post("Pick a date first, then I'll show available times.");
      return;
    }
    // Re-trigger the existing period/time picker by re-invoking get_clinic_availability,
    // then handing the result through buildInteractivePlanFromToolResults — this is the
    // same path used at the original time-pick point, so the synthesis is already known
    // to handle the result shape.
    const raw = await (tools as any).get_clinic_availability.execute({ date: state.pendingBookingDate });
    const plan = buildInteractivePlanFromToolResults(
      [{ toolName: "get_clinic_availability", result: raw }],
      state,
    );
    const sent = plan ? await sendInteractivePlan(extractPhone(thread), plan) : false;
    if (!sent) {
      await thread.post("Which time would you like? Reply with HH:mm.");
    }
    return;
  }

  if (interactiveReplyId === "edit_method") {
    console.log(`[DET] edit_method`);
    await updateState({
      activeMethodId: undefined,
      pendingBookingDate: undefined,
      pendingBooking: undefined,
      awaitingAddress: undefined,
      awaitingTime: undefined,
      awaitingDate: undefined,
      extractedIntent: state.extractedIntent
        ? { ...state.extractedIntent, method: undefined, date: undefined, time: undefined }
        : undefined,
    });
    const svc = state.serviceOptions?.find((s) => s.serviceId === state.activeServiceId);
    if (!svc || svc.methods.length === 0) {
      await thread.post("Please pick a service first.");
      return;
    }
    const sent = await sendInteractivePlan(extractPhone(thread), {
      body: "Which method?",
      options: svc.methods.slice(0, 10).map((m, i) => ({
        id: `method_select_${i + 1}`,
        title: clip(m.methodName, 24),
      })),
    });
    if (!sent) {
      await thread.post("Which method? Reply with: in-clinic, house call, or video.");
    }
    return;
  }
```

- [ ] **Step 8.2: Verify TypeScript compiles**

Run: `bun x tsc --noEmit`
Expected: No new errors. If `buildInteractivePlanFromToolResults` doesn't accept the synthesized result shape, adjust the construction to match its expected schema by reading lines ~334–540 in `src/bot/index.ts`.

- [ ] **Step 8.3: Commit**

```bash
git add src/bot/index.ts
git commit -m "feat(bot): edit picker handlers for service/date/time/method/cancel"
```

---

## Task 9: `edit_note` handler + `awaitingRemark` plain-text capture

**Files:**
- Modify: `src/bot/index.ts`

- [ ] **Step 9.1: Add the `edit_note` handler**

In the same deterministic-handler section (after the handlers from Task 8), add:

```ts
  if (interactiveReplyId === "edit_note") {
    console.log(`[DET] edit_note → awaitingRemark`);
    await updateState({ awaitingRemark: true });
    await thread.post("Type the note you'd like attached to this booking.");
    return;
  }
```

- [ ] **Step 9.2: Extract `postBookingConfirmCard` helper**

The summary-builder at lines ~858–902 in `src/bot/index.ts` is currently inline. Lift it into a top-level helper so the `awaitingRemark` flow can re-post the same card without re-staging via `create_booking`.

Add this top-level helper above the main handler in `src/bot/index.ts`:

```ts
async function postBookingConfirmCard(thread: any, state: ThreadState): Promise<void> {
  const staged = state.pendingBooking;
  if (!staged?.date) return;
  const svc = (state.serviceOptions ?? []).find((s) => s.serviceId === state.activeServiceId);
  const meth = svc?.methods.find((mm) => mm.methodId === state.activeMethodId);
  const clinicOpt = (state.clinicOptions ?? []).find((c) => c.clinicId === state.activeClinicId);
  const doctor = (state.doctorOptions ?? []).find((d) => d.doctorId === state.activeDoctorId);
  const summary = [
    "Here are your booking details — does this look right?",
    clinicOpt ? `Clinic: ${clinicOpt.clinicName}` : null,
    svc ? `Service: ${svc.serviceName}${meth?.methodName ? ` (${meth.methodName})` : ""}` : null,
    doctor ? `Doctor: ${doctor.name}` : null,
    `Date: ${humanDay(staged.date)}`,
    staged.time ? `Time: ${staged.time}` : null,
    staged.address ? `Address: ${staged.address}` : null,
    staged.reminderRemark ? `Note: ${staged.reminderRemark}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const sent = await sendReplyButtons(extractPhone(thread), summary, [
    { id: "booking_confirm_yes", title: "Yes, confirm" },
    { id: "booking_confirm_no", title: "Change details" },
  ]);
  if (!sent) await thread.post(summary);
}
```

Then replace the inline block at ~854–902 (the `if (state.pendingBooking?.date && state.pendingBooking?.time && ...)` confirm-card block, ending at the existing `return;`) with:

```ts
  if (
    state.pendingBooking?.date &&
    state.pendingBooking?.time &&
    !isInteractiveClick
    // (preserve any other guards that were on the original block — copy them here verbatim)
  ) {
    await postBookingConfirmCard(thread, state);
    return;
  }
```

When extracting, read the original `if (...)` condition carefully and reproduce all guard clauses unchanged — only the body becomes the helper call.

- [ ] **Step 9.3: Add the plain-text capture path for `awaitingRemark`**

Find the section where other `awaiting*` plain-text captures live — `awaitingAddress` is captured around line ~830–870 (search for `state.awaitingAddress`). Just below that block, add:

```ts
  if (state.awaitingRemark && !isInteractiveClick) {
    const note = String(activeMessage?.text?.body ?? activeMessage?.text ?? "").trim();
    if (!note) {
      await thread.post("Please type the note text.");
      return;
    }
    const updatedPending = state.pendingBooking
      ? { ...state.pendingBooking, reminderRemark: note }
      : undefined;
    await updateState({
      awaitingRemark: undefined,
      pendingBooking: updatedPending,
    });
    if (updatedPending?.date && updatedPending?.time) {
      await postBookingConfirmCard(thread, { ...state, awaitingRemark: undefined, pendingBooking: updatedPending });
    } else {
      await thread.post("Note saved.");
    }
    return;
  }
```

- [ ] **Step 9.4: Verify TypeScript compiles**

Run: `bun x tsc --noEmit`
Expected: No new errors.

- [ ] **Step 9.5: Commit**

```bash
git add src/bot/index.ts
git commit -m "feat(bot): edit_note handler, awaitingRemark capture, postBookingConfirmCard helper"
```

---

## Task 10: Clear `extractedIntent` on successful booking

**Files:**
- Modify: `src/bot/tools/booking.ts`

- [ ] **Step 10.1: Locate the success path in `create_booking`**

In `src/bot/tools/booking.ts`, find where `create_booking` returns `{ success: true, ... }`. There is also a state cleanup `updateState({...})` call near that point that clears `pendingBooking`, `activeServiceId`, etc. (search for `pendingBooking: undefined` inside the tool body).

- [ ] **Step 10.2: Add `extractedIntent: undefined` to the cleanup**

In each of those `updateState` calls within `create_booking`'s success path, append `extractedIntent: undefined` so the field is cleared once the booking commits. Example:

```ts
        await updateState({
          activeServiceId: undefined,
          activeMethodId: undefined,
          activeDoctorId: undefined,
          pendingBooking: undefined,
          pendingBookingDate: undefined,
          pendingIsNewPatient: undefined,
          awaitingAddress: undefined,
          awaitingTime: undefined,
          awaitingDate: undefined,
          extractedIntent: undefined, // ← add this
        });
```

If there are multiple cleanup blocks in `create_booking`, update each one.

- [ ] **Step 10.3: Verify TypeScript compiles**

Run: `bun x tsc --noEmit`
Expected: No new errors.

- [ ] **Step 10.4: Commit**

```bash
git add src/bot/tools/booking.ts
git commit -m "feat(bot): clear extractedIntent on successful booking"
```

---

## Task 11: Smoke test — fast path

**Files:**
- Modify: `scripts/test-smoke.ts`

- [ ] **Step 11.1: Add the fast-path smoke case**

Find the `cases` (or equivalent) array in `scripts/test-smoke.ts` that holds `SmokeCase` definitions. Append a new case:

```ts
  {
    id: "intent-fast-path",
    requireCreatedBooking: true,
    turns: [
      {
        id: "user-message",
        message: "book gp tomorrow 9am",
        requireAllTools: [
          "user_lookup",
          "extract_booking_intent",
          "search_services",
          "select_clinic",
          "select_service",
          "get_clinic_availability",
          "create_booking",
        ],
        forbidTools: [],
        requireToolArgs: [
          { tool: "extract_booking_intent", arg: "serviceKeyword", expectedType: "string" },
          { tool: "extract_booking_intent", arg: "time", equals: "09:00" },
          { tool: "create_booking", arg: "confirmed", equals: false },
        ],
        requireReplyContains: ["confirm"],
      },
      {
        id: "user-confirm",
        message: "yes",
        requireAllTools: ["create_booking"],
        requireToolArgs: [{ tool: "create_booking", arg: "confirmed", equals: true }],
      },
    ],
  },
```

- [ ] **Step 11.2: Run the smoke suite for just this case**

Identify the CLI flag the existing smoke runner uses to filter by ID (read the top of `test-smoke.ts` for an `--only` or `--id` option). If one exists:

Run: `bun run test:smoke -- --only intent-fast-path`

If no filter exists, run the whole suite and confirm the new case both runs and passes:

Run: `bun run test:smoke`
Expected: `intent-fast-path` reports PASS (or the equivalent success marker the script uses). Pre-existing cases continue to pass.

- [ ] **Step 11.3: Commit**

```bash
git add scripts/test-smoke.ts
git commit -m "test(bot): smoke case for fast-path booking via extract_booking_intent"
```

---

## Task 12: Smoke test — multi-clinic fallback and time-taken fallback

**Files:**
- Modify: `scripts/test-smoke.ts`

- [ ] **Step 12.1: Add multi-clinic fallback case**

Append to the cases array:

```ts
  {
    id: "intent-multi-clinic-fallback",
    turns: [
      {
        id: "user-message",
        // Choose a service keyword that is offered at ≥2 clinics in the dev DB.
        // (Pick one before running; "general consultation" is typically broad enough.)
        message: "book general consultation tomorrow 9am",
        requireAllTools: [
          "extract_booking_intent",
          "search_services",
        ],
        // Should NOT auto-pick a clinic when multiple match — picker should appear.
        forbidTools: ["select_clinic"],
        requireReplyContains: ["clinic"],
      },
    ],
  },
```

NOTE: the smoke runner needs to be able to assert "the bot's reply rendered a clinic picker." If `requireReplyContains` only checks plain text, also assert tool-call sequence: `select_clinic` is NOT called in this turn (because the user hasn't tapped a row yet). Adjust the case shape if the runner has a different way to assert "interactive list rendered."

- [ ] **Step 12.2: Add time-taken fallback case**

Append:

```ts
  {
    id: "intent-time-taken-fallback",
    turns: [
      {
        // Use a time that is known to be booked in the dev DB. Seed one if needed,
        // or pick a date/time pair that hits the clinic's lunch break.
        id: "user-message",
        message: "book gp tomorrow 12:30pm",
        requireAllTools: ["extract_booking_intent", "get_clinic_availability"],
        // Should NOT skip past the time picker when 12:30 is unavailable.
        forbidTools: ["create_booking"],
        requireReplyContains: ["available", "time"],
      },
    ],
  },
```

- [ ] **Step 12.3: Run**

Run: `bun run test:smoke`
Expected: Both new cases pass.

- [ ] **Step 12.4: Commit**

```bash
git add scripts/test-smoke.ts
git commit -m "test(bot): smoke cases for multi-clinic and time-taken fallbacks"
```

---

## Task 13: Smoke test — edit picker (change time)

**Files:**
- Modify: `scripts/test-smoke.ts`

- [ ] **Step 13.1: Add the edit-time smoke case**

Append:

```ts
  {
    id: "intent-edit-time",
    turns: [
      {
        id: "user-message",
        message: "book gp tomorrow 9am",
        requireAllTools: ["create_booking"],
        requireToolArgs: [{ tool: "create_booking", arg: "confirmed", equals: false }],
        requireReplyContains: ["confirm"],
      },
      {
        id: "tap-no",
        message: "[interactive: booking_confirm_no]",
        requireReplyContains: ["change"],
        forbidTools: ["create_booking"],
      },
      {
        id: "tap-edit-time",
        message: "[interactive: edit_time]",
        forbidTools: ["create_booking"],
        requireReplyContains: ["time"],
      },
    ],
  },
```

NOTE: the smoke runner's interactive-tap input format may differ. Read the runner's TurnSpec parser at the top of `test-smoke.ts` for the exact syntax — adapt the `message` strings to match.

- [ ] **Step 13.2: Run**

Run: `bun run test:smoke`
Expected: `intent-edit-time` passes.

- [ ] **Step 13.3: Commit**

```bash
git add scripts/test-smoke.ts
git commit -m "test(bot): smoke case for edit picker (change time)"
```

---

## Task 14: Smoke test — free-text edit

**Files:**
- Modify: `scripts/test-smoke.ts`

- [ ] **Step 14.1: Add the free-text-edit smoke case**

Append:

```ts
  {
    id: "intent-free-text-edit",
    turns: [
      {
        id: "user-message",
        message: "book gp tomorrow 9am",
        requireAllTools: ["create_booking"],
        requireReplyContains: ["confirm"],
      },
      {
        id: "user-correction",
        message: "actually make it 10am",
        requireAllTools: ["extract_booking_intent", "get_clinic_availability"],
        requireToolArgs: [
          { tool: "extract_booking_intent", arg: "time", equals: "10:00" },
        ],
        requireReplyContains: ["confirm"],
      },
    ],
  },
```

- [ ] **Step 14.2: Run**

Run: `bun run test:smoke`
Expected: `intent-free-text-edit` passes.

- [ ] **Step 14.3: Commit**

```bash
git add scripts/test-smoke.ts
git commit -m "test(bot): smoke case for free-text edit via extract_booking_intent"
```

---

## Task 15: Smoke test — guard re-entry and no-intent baseline

**Files:**
- Modify: `scripts/test-smoke.ts`

- [ ] **Step 15.1: Add guard re-entry case**

Append:

```ts
  {
    id: "intent-guard-reentry",
    turns: [
      {
        id: "start-flow",
        message: "book gp",
        // Sets activeServiceId after select_service.
        requireAllTools: ["search_services"],
      },
      {
        id: "intent-change-mid-flow",
        message: "actually flu shot tomorrow 10am",
        // Tool should be called and return skipped:true; LLM should fall back
        // to the existing flow (search_services again or service picker) — NOT
        // crash and NOT silently overwrite active selections.
        forbidTools: ["create_booking"],
      },
    ],
  },
```

- [ ] **Step 15.2: Add no-intent baseline case**

Append:

```ts
  {
    id: "intent-no-booking-intent",
    turns: [
      {
        id: "user-message",
        message: "what services do you offer?",
        forbidTools: ["extract_booking_intent", "create_booking"],
      },
    ],
  },
```

- [ ] **Step 15.3: Run**

Run: `bun run test:smoke`
Expected: All cases pass.

- [ ] **Step 15.4: Commit**

```bash
git add scripts/test-smoke.ts
git commit -m "test(bot): smoke cases for guard re-entry and no-intent baseline"
```

---

## Task 16: Final verification

- [ ] **Step 16.1: Type check the whole project**

Run: `bun x tsc --noEmit`
Expected: No new errors introduced by this work. Pre-existing dependency errors are acceptable; document them in the final commit message if any.

- [ ] **Step 16.2: Run all unit tests**

Run: `bun run scripts/test-extract-intent.ts`
Expected: All tests pass.

- [ ] **Step 16.3: Run guards suite (regression check)**

Run: `bun run test:guards`
Expected: 11/11 pass — no regression.

- [ ] **Step 16.4: Run full smoke suite**

Run: `bun run test:smoke`
Expected: All cases — both pre-existing and new — pass.

- [ ] **Step 16.5: Manual smoke (optional, recommended)**

Start the bot locally (`bun run dev`) and message it from a real WhatsApp test number with each of:
- "book gp tomorrow 9am" → expect single confirm card.
- Tap No → expect edit picker.
- Tap "Time" → expect time picker.
- Tap a time → expect re-rendered confirm card.
- Tap Yes → expect booking creation message.

- [ ] **Step 16.6: Final commit (if anything was tweaked during verification)**

```bash
git status
# If files changed:
git add -A
git commit -m "chore(bot): final tweaks after verification of intent-extraction flow"
```

---

## Out of scope (do not implement in this plan)

- Pre-resolving `activeClinicId` from a clinic name in user text.
- Pre-resolving `activeDoctorId` from doctor name.
- Multi-language extraction quality tuning.
- Pagination on the edit picker (six rows fits one WhatsApp interactive list).
- Persistence of `extractedIntent` across session gaps (cleared with the rest of booking state).
