# Clinic Deep-Link Routing — Design

**Date:** 2026-04-27
**Project:** anyhealth-bot
**Status:** Approved, pending implementation plan

## Summary

Allow each clinic to publish a unique `wa.me` URL that opens the WhatsApp bot pre-scoped to that clinic. Patient taps the link, lands in the bot, the clinic-selection step is already done, the bot greets them by clinic name and proceeds straight to service selection.

URL form: `https://wa.me/<bot_phone>?text=clinic_<slug>`

Example: `https://wa.me/60107872318?text=clinic_acme-dental`

## Goals

- Patient skips the "which clinic?" turn when they arrive via a clinic-published link.
- Clinic-named welcome on entry ("You're booking at *Acme Dental*").
- Single mechanism serving three distribution channels: poster QR, marketing/SMS, repeat-patient bookmark.
- Deterministic, prompt-independent routing (token parsing in code, not LLM tool calls).

## Non-goals (v1)

- Per-clinic custom welcome text/images/logos. (Defer.)
- Pre-selecting service or doctor via URL. (Defer.)
- Self-serve clinic admin UI for slug management. (Operator sets slugs in DB.)
- Click-to-WhatsApp ad attribution / `referral` field handling.

## Key decisions

| # | Decision | Why |
|---|---|---|
| 1 | All three distribution channels supported by one mechanism. | Same URL works whether on a poster, in SMS, or bookmarked. |
| 2 | Identifier = `slug` column on `c_a_clinics`. | Human-readable, clinic-controlled. Not an auth boundary, so spoofing risk is low. |
| 3 | URL token format: `clinic_<slug>`, anchored to message start. | Simple regex, easy for clinics to construct, no collision with normal chat. |
| 4 | Mid-flow conflict → hard reset, always. | Mental model "deep link = fresh start" is simplest, avoids stuck states. Past bugs around state-clearing argue against time-windowed/confirm flows. |
| 5 | Welcome v1 = clinic-name-only template, multi-language. | Ships routing first. Custom-text per clinic can layer on later without rework. |
| 6 | Skip depth = clinic only. | Service slugs would double schema work; service-pick is one tap. |
| 7 | Unknown slug → friendly error, continue normally. | Patient didn't do anything wrong; clinic-onboarding mistakes are visible. |
| 8 | Architecture = pre-LLM webhook interception. | Deterministic; doesn't add a tool to the already-13-tool list; not vulnerable to prompt drift. |

## Architecture

```
WhatsApp inbound → handleMessage()
                     │
                     ├─► parseDeepLinkToken(text)  [NEW, deterministic]
                     │       │
                     │   ┌───┴───┐
                     │  none   match(slug, residual)
                     │   │       │
                     │   │   resolveClinicBySlug(slug)
                     │   │       │
                     │   │   ┌───┴───┐
                     │   │  found  unknown
                     │   │   │       │
                     │   │   │   set state.unknownSlugThisTurn (one-shot)
                     │   │   │       │
                     │   │  applyDeepLink(state, clinic) + sendWelcome()
                     │   │       │
                     │   │   if residual empty → end turn
                     │   │   else → forward residual to LLM
                     │   │       │
                     │   └───────┴───►
                     ▼
              existing LLM agent loop (unchanged)
```

The LLM never sees the raw `clinic_<slug>` token. By the time the agent runs, `activeClinicId` is set exactly as if the user had completed `select_clinic` manually. Existing `select_clinic` and `search_services` flow handle the rest unchanged.

## Data model

### `c_a_clinics.slug` (new column)

| Field | Type | Constraints |
|---|---|---|
| `slug` | `text` | `not null`, `unique`, lowercase kebab-case, 1–40 chars |

**Validation pattern** (regex, applied at write-time and URL parse-time):

```
^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$
```

**Backfill algorithm** (in migration):

1. Lowercase `name`.
2. Strip non-alphanumeric and non-space characters.
3. Collapse whitespace runs to single `-`.
4. Truncate to 40 chars.
5. On collision, append `-2`, `-3`, etc.

**Migration file:** `supabase/migrations/003_clinic_slug.sql`

Single transaction:
1. `ALTER TABLE c_a_clinics ADD COLUMN slug text;`
2. `UPDATE c_a_clinics SET slug = ...;` (backfill)
3. `ALTER TABLE c_a_clinics ALTER COLUMN slug SET NOT NULL;`
4. `ALTER TABLE c_a_clinics ADD CONSTRAINT c_a_clinics_slug_key UNIQUE (slug);` — implicit btree index covers lookup.

### State (`ThreadState`) — no schema changes

Reuse existing fields:
- **Set by deep link:** `activeClinicId`
- **Wiped by deep link:** `clinicOptions`, `activeServiceId`, `activeMethodId`, `activeDoctorId`, `lastSearchQuery`, in-flight booking draft fields
- **Preserved:** `userId`, `phone`, `patients`, `activePatientId`, `verified`, `language`

Transient one-shot field used only within a single turn:
- `unknownSlugThisTurn?: boolean` — added as an optional field on `ThreadState`. Set to `true` when an inbound slug fails to resolve; consumed by the system-prompt builder as a presence check; cleared at end of turn (in the same place that already finalizes per-turn state). The slug itself is not retained — only the fact that resolution failed.

## Components

### `src/bot/deep-link.ts` (new)

Pure module, no I/O.

```ts
const TOKEN_RE = /^clinic_([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\b\s*/i;

export type DeepLinkParse =
  | { kind: 'none' }
  | { kind: 'match'; slug: string; residual: string };

export function parseDeepLinkToken(text: string): DeepLinkParse {
  const m = text.match(TOKEN_RE);
  if (!m) return { kind: 'none' };
  return {
    kind: 'match',
    slug: m[1].toLowerCase(),
    residual: text.slice(m[0].length).trim(),
  };
}
```

### `src/bot/clinic-resolver.ts` (new or extend existing lookup module)

```ts
export async function resolveClinicBySlug(slug: string)
  : Promise<{ id: string; name: string } | null>;
```

Single Supabase query:
```sql
select id, name from c_a_clinics where slug = $1 limit 1
```

(Add `and deleted_at is null` if the column exists; verify at impl time.)

### `applyDeepLink(state, clinic)` — in `src/bot/deep-link.ts`

Pure state transform.

- **Idempotent same-clinic:** if `state.activeClinicId === clinic.id`, return state unchanged regardless of booking draft. (Re-tapping the same clinic shouldn't punish a mid-booking user.)
- **Different-clinic or no clinic set:** wipe booking-scoped fields, set `activeClinicId`.
- Identity-scoped fields preserved unconditionally.

### `sendWelcome(thread, clinic)` — in `src/bot/messages/welcome.ts` (new)

Deterministic template by language. Sends WhatsApp text via existing helper.

```ts
const TEMPLATES = {
  en: (n: string) => `Hi! You're booking at *${n}*. What service do you need today?`,
  ms: (n: string) => `Hai! Anda sedang menempah di *${n}*. Apakah perkhidmatan yang anda perlukan hari ini?`,
  zh: (n: string) => `您好！您正在 *${n}* 预约。请问您需要什么服务？`,
};
```

Default language: `en` if `state.language` unset.

### Integration in `src/bot/index.ts` `handleMessage()`

Insert at the top of `handleMessage`, before the existing LLM agent loop:

```ts
const parse = parseDeepLinkToken(message.text);
if (parse.kind === 'match') {
  const clinic = await resolveClinicBySlug(parse.slug);
  if (clinic) {
    applyDeepLink(thread.state, clinic);
    await sendWelcome(thread, clinic);
    logDeepLink({ slug: parse.slug, resolved: true, clinicId: clinic.id });
    if (!parse.residual) return;
    message = { ...message, text: parse.residual };
  } else {
    thread.state.unknownSlugThisTurn = parse.slug;
    logDeepLink({ slug: parse.slug, resolved: false });
    message = { ...message, text: parse.residual || message.text };
  }
}
// existing LLM agent loop continues...
```

### System prompt builder (existing, edited)

If `state.unknownSlugThisTurn` is set, prepend a single instruction to this turn's system prompt:

> "User opened the bot via a deep link with an unrecognized clinic identifier. Briefly tell them you couldn't find that clinic, then continue helping them normally."

Clear `unknownSlugThisTurn` at the end of the turn.

## Welcome message — full behavior matrix

| Scenario | Welcome | LLM call this turn |
|---|---|---|
| Valid slug, no residual | Template sent | No |
| Valid slug + residual | Template sent, then LLM runs on residual | Yes |
| Same-clinic re-tap, no in-progress booking, no residual | Template sent (idempotent) | No |
| Same-clinic re-tap, in-progress booking, no residual | Template sent, booking state preserved | No |
| Different-clinic tap, no residual (any prior state) | Template sent, booking state wiped | No |
| Different-clinic tap + residual | Template sent, state wiped, LLM runs on residual | Yes |
| Unknown slug, no residual | None (LLM apologizes) | Yes |
| Unknown slug + residual | None (LLM apologizes + responds to residual) | Yes |

"In-progress booking" = any of `activeServiceId`, `activeMethodId`, `activeDoctorId`, or a populated booking-draft field is set.

## Edge cases

| Case | Behavior |
|---|---|
| Token mid-message (`hey clinic_acme`) | Ignored. Regex anchored to `^`. |
| Token with trailing junk (`clinic_acme$$$`) | `\b` boundary stops match; junk becomes `residual`. |
| Slug for soft-deleted clinic | Treated as unknown. |
| Token case (`Clinic_AcmeDental`) | Regex `i` flag; slug lowercased. Note: uppercase letters in the slug body itself fail validation — those URLs would fall to the unknown-slug path. |
| Unverified user + deep link | `activeClinicId` set; `verified` unchanged. Verification still gates verification-only tools. |
| Patient context (parent w/ multiple kids) | `activePatientId` unchanged. Patient identity is independent of booking-clinic scope. |
| Bot phone number changes | URLs become invalid — out of scope. |
| Concurrent messages racing | Existing thread serialization handles ordering. |
| Clinic name contains `*` or other Markdown | v1: pass through; document as known minor render quirk. |
| Slug column UNIQUE collision on backfill | Migration appends `-2`, `-3`. Verify zero post-migration duplicates. |
| DB unreachable during slug resolve | Bubbles to existing error path → generic "something went wrong." Don't reset state. |
| WhatsApp send failure on welcome | Existing retry/log path. Don't reset state. |

## Telemetry

Single log line per deep-link arrival:

```ts
logDeepLink({
  event: 'deep_link',
  slug,
  resolved: boolean,
  clinicId?: string,
  switchedFromClinicId?: string,
});
```

Uses existing logger. No new infrastructure. Useful for debugging clinic-onboarding ("is the QR code working?").

## Testing

### Unit — `src/bot/__tests__/deep-link.test.ts`

`parseDeepLinkToken`:
- valid slug, no residual
- valid slug + residual
- token mid-message → none
- junk after slug → match with junk in residual
- 50-char slug → none (over cap)
- trailing-hyphen slug → none
- empty input → none

`applyDeepLink`:
- full wipe on different-clinic switch
- idempotent on same-clinic re-tap (no booking)
- identity fields preserved across wipe
- `activeClinicId` set correctly

### Integration — `scripts/test-deep-link.ts`

Mirrors existing `scripts/test-near-me.ts` style. Hits real Supabase with a seeded test clinic (slug `test-clinic`). Expose via `bun run test:deep-link`.

| Scenario | Assertion |
|---|---|
| Fresh thread, valid slug, no residual | `activeClinicId === testClinicId`; one outbound text = welcome |
| Fresh thread, valid slug + "I need cleaning" | activeClinicId set; LLM proceeds to service selection |
| Mid-booking at A, deep link to B | activeClinicId switches; service/method/doctor null; welcome sent |
| Same clinic re-tap mid-booking | activeClinicId unchanged; service/method/doctor preserved |
| Unknown slug | No state mutation; LLM apologizes |
| Unverified user + deep link | activeClinicId set; verified unchanged |

### Manual smoke

Real WhatsApp send via dev test number. Cover: valid token, unknown token, user-edited prefilled text (e.g. user appends "hi I need an appointment").

## Operator workflow (out of code)

For each clinic:
1. Set `slug` in DB (initially via `psql` / Drizzle Studio).
2. Construct URL: `https://wa.me/<BOT_PHONE>?text=clinic_<slug>`.
3. Hand to clinic for QR/print/SMS use.

A small helper script (`scripts/print-clinic-link.ts`) that takes a slug and prints the URL is nice-to-have, not required for v1.

## Open questions

None blocking. Decisions documented above.

## Future extensions (not in this spec)

- Per-clinic custom welcome text and/or logo.
- Pre-selecting service via URL (`clinic_<slug>__<service-slug>`).
- Self-serve slug management in clinic admin UI (lands with fullstack migration).
- Click-to-WhatsApp ad referral attribution.
