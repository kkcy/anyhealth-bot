# AnyHealth Bot Automated Testing

Generated on: 2026-04-16

## What You Can Run Now

1. Guardrail checks (no seeded DB data required beyond env setup):

```bash
pnpm test:guards
```

2. Batch multi-turn smoke suite (pass/fail per scenario):

```bash
pnpm test:smoke
```

Optional:

```bash
pnpm test:smoke -- --phone=60123456789
pnpm test:smoke -- --full-reply
pnpm test:smoke -- --case=booking-flow
pnpm test:smoke -- --cases=booking-flow,reschedule-flow
```

3. Single-message end-to-end tool-orchestration check:

```bash
pnpm test:tools 60123456789 "Hi, I want to book a checkup"
```

4. Basic code health:

```bash
pnpm lint
pnpm build
```

## What `test:guards` Covers

- Protected flows blocked before verification (`search_documents`, `upload_insurance`, `list_insurance`, `ask_insurance`)
- Booking blocked without required context (`user_lookup`, selected patient, explicit confirmation)
- Availability blocked without clinic selection
- Booking management blocked before user context (`view_bookings`, `reschedule_booking`, `cancel_booking`)

## What `test:smoke` Covers

- Runs predefined multi-turn conversation flows:
  - booking flow (intent -> clinic selection -> service selection -> patient type -> booking create)
  - view bookings flow
  - reschedule flow
  - document retrieval flow (including verification)
  - insurance flow (including verification)
- For each scenario:
  - validates required tool usage per turn
  - validates bot returns a text response each turn
  - fails immediately when required turn behavior is not met
- Booking flow also enforces a success condition: at least one `create_booking` call must include `isNewPatient` as a boolean argument.
- Prints per-turn details, per-scenario status, and final summary.

## Environment Required

These must be present in environment (or `.env`):

- `AI_MODEL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_APP_SECRET`
- `POSTGRES_URL`

## Notes

- `test:tools` uses live LLM + DB/tool calls, so output can vary by data and model behavior.
- Insurance upload end-to-end is currently blocked by unimplemented PDF extraction (`src/lib/pdf.ts`).
