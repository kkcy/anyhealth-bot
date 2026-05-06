# AnyHealth WhatsApp Chatbot

A WhatsApp chatbot for AnyHealth patients to discover services, book appointments, manage bookings, retrieve consultation documents, query insurance policies, and log meal nutrition from food photos.

## Status

**In development** — Built on the current Supabase architecture as a standalone project, with a clear migration path to the anyhealth-fullstack monorepo.

## Architecture

```
Patient (WhatsApp) → Meta Cloud API → Vercel Next.js → Chat SDK webhook
                                              ↓
                                    AI SDK generateText + tools (13 tools)
                                              ↓
                                    Next.js API routes → Supabase
```

- **Runtime:** Vercel (Next.js, serverless)
- **WhatsApp:** Meta Cloud API via `@chat-adapter/whatsapp`
- **LLM:** Model-agnostic via `AI_MODEL` env var. Default: `google/gemini-3-flash`. Supports Anthropic, OpenAI, Google via Vercel AI Gateway.
- **Conversation state:** Postgres via `@chat-adapter/state-pg`
- **Conversation engine:** Vercel AI SDK `generateText` with tool loop (`stepCountIs(8)`)
- **Database:** Supabase (existing AnyHealth instance)
- **Reference project:** `donorcare-receipt` — same Chat SDK + AI SDK pattern

## Features

### 1. Service Discovery
Patient describes what they need → bot searches clinic services → shows matching clinics and available methods (in-clinic, house call, virtual, etc.)

### 2. Appointment Booking
Full booking flow: service → clinic → method → doctor → date/time → confirmation.
- **House calls:** Captures address via WhatsApp location sharing
- **Time logic:** Driven by `service_method.priority` — `true` = ask date+time, `false` = date only
- **Interactive messages:** WhatsApp buttons for confirmation, list messages for selections

### 3. View Bookings
Shows upcoming bookings for the user's patients, filterable by patient.

### 4. Edit Bookings
Reschedule (date/time/doctor) or cancel. Rescheduling sets status to `reschedule_pending`. Service/patient/clinic changes require a new booking.

### 5. Document Retrieval
Retrieve consultation reports by date range or diagnosis description (e.g., "the report from last week" or "the one about heart condition"). Requires identity verification (patient name + IC) before access. 3-attempt lockout.

### 6. Insurance Q&A
Patient uploads insurance policy PDF → bot extracts and stores text → patient can ask coverage questions. Bot answers strictly from policy text — responds "not mentioned in your policy" if information isn't found. Supports multiple policies per patient.

### 7. Meal Photo Nutrition Logging
Patient sends a meal photo → bot identifies items and estimates macros → user confirms/edits/cancels via WhatsApp buttons → confirmed meal is logged to `meal_logs` with photo storage path persisted from Supabase Storage.

Test guide: `docs/bot-test-meal.md`.

## Deep Linking

### Branded short URL

Patient-facing entry point. Clinics share `https://<your-public-domain>/c/<clinic-slug>` (e.g. on a website button, business card, QR). The route 302s to `wa.me` with a human-readable prefill the bot recognises:

- Visible to user: `Hi! I'd like to book at One Care Clinic`
- Bot effect: same as the legacy `clinic_<slug>` token — pre-scopes the booking to that clinic and sends the welcome template.

Required env: `WHATSAPP_BUSINESS_PHONE` (E.164 without `+`). Optional: `PUBLIC_BASE_URL` for `buildShortUrl()` callers.

The legacy `clinic_<slug>` text token still works for any links already in the wild.

### Booking Reminders

Confirmed bookings trigger a reminder cascade via WhatsApp Message Templates:

- `appt_24h` — 24h before appointment
- `appt_2h`  — 2h before appointment
- `doc_ready` — when a consultation report or MC is ready

All templates are Utility-categorized and include a "Stop Reminders" quick-reply button.
Per-clinic opt-out is stored in `reminder_optouts`; auto-cleared on rebook (button-source only).

Scheduling is recompute-on-change: any booking write deletes existing pending rows and re-inserts current intent. A `*/5` Vercel Cron sweeps `reminder_jobs` and sends due rows.

Templates submitted to Meta:
- `appt_24h_with_doctor`, `appt_24h_no_doctor`
- `appt_2h_with_doctor`, `appt_2h_no_doctor`
- `doc_ready`

Spec: `docs/superpowers/specs/2026-05-03-booking-reminders-design.md`.

## Identity Model

One phone number can have multiple patients (e.g., parent managing children's appointments).

| Action | Verification needed? |
|--------|---------------------|
| Service discovery | None |
| Booking / view / edit | Patient selection only |
| Document retrieval | Name + IC verification |
| Insurance upload + Q&A | Name + IC verification |

## Tools (13)

| Group | Tool | Description |
|-------|------|-------------|
| Lookup | `user_lookup` | Find user by phone, load linked patients |
| Lookup | `search_services` | Search services by description across clinics |
| Lookup | `get_clinic_availability` | Check open slots for a clinic/service/date |
| Booking | `create_booking` | Create appointment with status `pending` |
| Booking | `view_bookings` | List upcoming bookings |
| Booking | `reschedule_booking` | Change date/time, set `reschedule_pending` |
| Booking | `cancel_booking` | Cancel a booking |
| Document | `verify_patient` | Verify identity via name + IC match |
| Document | `search_documents` | Search reports by date/diagnosis text |
| Insurance | `upload_insurance` | Extract PDF text, store policy |
| Insurance | `list_insurance` | List stored policies for a patient |
| Insurance | `ask_insurance` | Answer question using full policy text (nested LLM call) |

Security-sensitive tools (document, insurance) enforce verification in code — not just in the prompt.

## Database

### New table

```sql
CREATE TABLE patient_insurance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id    text REFERENCES patient_id(id),
  insurer_name  text,
  policy_number text,
  raw_text      text,           -- full extracted PDF text
  file_url      text,           -- original PDF in Supabase storage
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);
```

### Existing tables used

`whatsapp_users`, `patient_id`, `c_a_clinic_service`, `c_a_service_method`, `c_a_clinic_available_time`, `c_a_doctors`, `c_s_bookings`, `c_report_consult`, `actual_visiting_history`, `actual_diagnosis`

## Project Structure

```
anyhealth-bot/
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   └── api/
│   │       ├── webhooks/
│   │       │   └── whatsapp/route.ts       # Chat SDK webhook handler
│   │       └── bot/                         # Backend API routes → Supabase
│   │           ├── user/route.ts
│   │           ├── services/route.ts
│   │           ├── bookings/route.ts
│   │           ├── documents/route.ts
│   │           └── insurance/route.ts
│   ├── bot/
│   │   ├── index.ts                         # Chat instance, message handler
│   │   ├── prompt.ts                        # System prompt builder
│   │   └── tools/
│   │       ├── index.ts                     # Tool assembly
│   │       ├── lookup.ts                    # user_lookup, search_services, get_clinic_availability
│   │       ├── booking.ts                   # create, view, reschedule, cancel
│   │       ├── documents.ts                 # verify_patient, search_documents
│   │       └── insurance.ts                 # upload, list, ask
│   ├── lib/
│   │   ├── config.ts                        # Model selection
│   │   ├── supabase.ts                      # Supabase client
│   │   └── pdf.ts                           # PDF text extraction
│   └── types.ts                             # ThreadState, PatientRef
├── package.json
├── next.config.ts
└── .env.local
```

## Environment Variables

```env
# LLM
AI_MODEL=google/gemini-3-flash
AI_GATEWAY_API_KEY=              # Vercel AI Gateway (production)

# WhatsApp
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=           # Webhook verification
WHATSAPP_APP_SECRET=             # Meta App Secret for signature verification
WHATSAPP_BUSINESS_PHONE=         # Dialable E.164 number (no '+'); used in /c/[slug] wa.me redirects

# Database
SUPABASE_URL=
SUPABASE_SECRET_KEY=
POSTGRES_URL=                    # Chat SDK thread state (separate from Supabase)

# App
APP_URL=                         # Vercel deployment URL

# Reminders
CRON_SECRET=                    # Authenticates Vercel Cron requests to /api/cron/reminders
```

## Postponed Features (Phase 2)

### Insurance Panel List
Panel clinic lookups ("is clinic X in my insurance network?") are deferred. Panel lists are published separately by insurers (PDFs or webpages) and change frequently. When AnyHealth partners with insurance firms, panel data will be provided as structured data, enabling a `panel_clinics` table and `check_panel` tool.

### Consultation Cross-Reference
"Is my recent visit claimable?" requires cross-referencing consultation data (diagnosis, treatment, cost) with policy coverage. Deferred until insurer partnerships provide structured coverage rules.

## Migration to anyhealth-fullstack

When the Supabase → Elysia migration is complete, this bot moves into the monorepo.

### What changes

| Layer | Current | After migration |
|-------|---------|-----------------|
| Location | Standalone `anyhealth-bot/` | `apps/bot/` in Turborepo monorepo |
| Backend API | Next.js API routes → Supabase | Eden Treaty → Elysia API |
| Database access | Supabase JS client | Drizzle ORM via Elysia |
| Auth | Supabase service key | Better-Auth |
| Insurance table | Supabase | Drizzle schema in `packages/db/` |

### What does NOT change

- **Bot layer** (`src/bot/`): Chat SDK setup, system prompt, tools, state — all unchanged
- **WhatsApp integration**: Webhook handler, adapter, interactive messages — unchanged
- **Tool schemas**: Zod input schemas stay the same
- **State storage**: Chat SDK Postgres state is independent from app database
- **LLM config**: Model selection, AI SDK usage — unchanged

### Migration steps

1. Move `anyhealth-bot/` into `apps/bot/` in the monorepo
2. Update `package.json` to use workspace dependencies (`@anyhealth/db`, `@anyhealth/api`)
3. Replace each `/api/bot/*` route implementation: Supabase calls → Eden Treaty calls
4. Move `patient_insurance` table to `packages/db/src/schema/clinic.ts`
5. Update env vars: remove `SUPABASE_*`, add Elysia API URL
6. `src/bot/` requires zero changes

### Design decisions that enable this

- **API routes as abstraction**: Tools call `/api/bot/*`, not Supabase directly. Swapping route implementations is contained.
- **Independent state DB**: Chat SDK Postgres state is separate from app database.
- **No Supabase-specific features**: No realtime subscriptions, RLS, or Edge Functions in the bot.

## Cost Estimates

### Per-conversation costs
- WhatsApp Business API: ~RM 0.04-0.35 per conversation (Meta pricing, varies by category)
- LLM (Gemini Flash): ~RM 0.04-0.20 per conversation
- Vercel: Free tier sufficient initially

### External dependencies
- Meta Business Manager verified account (required for production WhatsApp API)
- Vercel account
- Supabase instance (existing)
- Postgres instance for Chat SDK state (can use Vercel Postgres or Neon free tier)
