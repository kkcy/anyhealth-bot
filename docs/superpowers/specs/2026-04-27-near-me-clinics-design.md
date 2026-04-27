# Near-Me Clinic Suggestion — Design Spec

**Date:** 2026-04-27
**Project:** anyhealth-bot (WhatsApp patient bot)
**Author:** kkcy + Claude
**Status:** Approved (pending implementation plan)

## Goal

After a patient searches for a service, let them tap a "📍 Near me" option in the clinic list. The bot asks them to share their WhatsApp location, then re-renders the clinic list sorted by distance (closest first).

## Non-Goals

- Geocoding clinic addresses on demand (manual SQL backfill only — 3 rows today).
- UI for clinic admins to enter lat/lng during clinic creation (`CreateClinic.tsx`).
- Distance cap / pagination — all matches returned, sorted ascending.
- PostGIS / `cube` / `earthdistance` extensions — Haversine in JS is fine for MVP scale.

## Architecture

### 1. Schema — `c_a_clinics`

Add two nullable columns:

```sql
alter table c_a_clinics
  add column latitude double precision,
  add column longitude double precision;
```

Backfill via one-off SQL for the 2 active clinics + 1 TCM clinic (coords looked up manually). Future clinics: NULL until clinic admin form is updated (out of scope here).

Clinics with NULL coords are excluded from near-me results (returned in a separate `excluded` array so the LLM can mention them as "no map data").

### 2. WhatsApp Location Ingestion

WhatsApp sends `messages[].type = "location"` with `location.latitude`, `location.longitude`, `location.name`, `location.address`.

Changes in `src/bot/index.ts`:

- New helper `extractLocation(message): {lat: number, lng: number} | undefined`.
- In `handleMessage`, when location present:
  - Persist `state.lastLocation = {lat, lng, capturedAt: Date.now()}`.
  - Inject synthetic user text into LLM history: `"[location shared: <lat>, <lng>]"`. This way the LLM treats it like any other turn.
- `state.lastLocation` is reused for any near-me call in the same session — bot does not re-ask if already cached.

### 3. ThreadState Additions

```ts
// src/types.ts
export interface ThreadState {
  // ...existing fields
  lastLocation?: {
    lat: number;
    lng: number;
    capturedAt: number; // epoch ms
  };
}
```

`ClinicOption` gains optional fields used only for near-me ranking:

```ts
export interface ClinicOption {
  // ...existing fields
  latitude?: number | null;
  longitude?: number | null;
  distanceKm?: number; // populated only by near-me path
}
```

### 4. Tool Changes — `src/bot/tools/lookup.ts`

**`search_services` (modify):**
- Return JSON adds `nearMeOption: boolean`.
  - `true` when `clinicOptions.length >= 2`.
  - `false` when 1 clinic auto-selects (pointless to offer near-me on single match).
- No change to `clinicOptions` array — the "📍 Near me" row is rendered at the interactive layer (see §5), so `select_clinic` index integrity is preserved.

**`search_services_near_me` (new):**
- Inputs:
  - `query: string` — service search keyword. If absent, falls back to `state.lastSearchQuery`.
- Behavior:
  1. If `state.lastLocation` is missing → return `{needsLocation: true, instruction: "Ask user to share location via WhatsApp 📎 → Location."}`.
  2. Same service-matching path as `search_services` (reuse the `or` query against `c_a_clinic_service` + `tcm_a_clinic_service`).
  3. `loadClinicsByIds` extended to include `latitude, longitude` columns.
  4. For each matched clinic: compute Haversine distance from `state.lastLocation` to `(clinic.lat, clinic.lng)`.
  5. Clinics with NULL lat/lng → pushed to `excluded` array, not main results.
  6. Sort remaining ascending by `distanceKm`.
  7. Return same shape as `search_services` plus `distanceKm` per clinic and `excluded: ClinicOption[]`.

**Haversine helper** (small util, inline in `lookup.ts` or `src/lib/geo.ts`):

```ts
function haversineKm(a: {lat: number; lng: number}, b: {lat: number; lng: number}): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}
```

### 5. Interactive Rendering — `src/bot/index.ts`

The auto-list-from-numbered-text rendering already exists (`drainCapturedInteractive`, decide-interactive logic ~line 354).

Two changes:

1. When the most recent tool result includes `nearMeOption: true`, the renderer appends one extra row to the last section:
   ```ts
   { id: "NEAR_ME", title: "📍 Near me" }
   ```
2. `extractInteractiveReplyId` already returns the tapped row id. New branch in `handleMessage`: if reply id == `"NEAR_ME"`, replace the user text with the literal `"near me"` so the LLM picks it up and calls `search_services_near_me` (using `state.lastSearchQuery`).

### 6. System Prompt Updates — `src/bot/prompt.ts`

Additions:

- Tool list mentions `search_services_near_me`.
- Rule: *"If a user shares a location pin (you'll see `[location shared: lat, lng]`), treat it as implicit near-me on the most recent search. Call `search_services_near_me` with the previous query."*
- Rule: *"When a tool returns `needsLocation: true`, reply warmly asking the user to share their location via WhatsApp's 📎 attachment menu → Location. Do not call the tool again until they do."*
- Rule: *"When presenting a near-me result, mention the distance in km next to each clinic. Mention any excluded clinics by name with a note that we don't have their map data yet."*

## Data Flow

```
Patient: "I need a heart checkup"
  ↓
LLM → search_services({query: "heart"})
  ↓ returns clinics + nearMeOption: true
LLM renders → WhatsApp interactive list:
  1. Clinic A (3 services)
  2. Clinic B (1 service)
  📍 Near me
  ↓
Patient taps "📍 Near me"
  ↓ webhook receives interactive reply id = "NEAR_ME"
handleMessage injects "near me" as user text
  ↓
LLM → search_services_near_me({query: "heart"})
  ↓ returns needsLocation: true (no cached location)
LLM replies: "Could you share your location? Tap 📎 → Location → Send."
  ↓
Patient shares location
  ↓ webhook detects message.type = "location"
handleMessage stores state.lastLocation, injects "[location shared: 3.139, 101.687]"
  ↓
LLM → search_services_near_me({query: "heart"})
  ↓ Haversine sort → clinics [{Clinic B, 1.2km}, {Clinic A, 4.5km}]
LLM renders interactive list with distances.
  ↓
Patient taps clinic → existing select_clinic flow continues unchanged.
```

## Edge Cases

| Case | Behavior |
|---|---|
| Stray location share (no prior search) | LLM asks "What service are you looking for?" — no `lastSearchQuery` to feed `search_services_near_me`. |
| Clinic with NULL lat/lng | Excluded from sort, returned in `excluded` array, LLM mentions by name. |
| Only 1 clinic matches the keyword | `nearMeOption: false`, no row offered (auto-select path runs). |
| Second near-me in same session | `state.lastLocation` cached → no re-prompt. |
| Location older than session boundary | `state.lastLocation` cleared along with rest of session state on session reset. |

## Testing

Add to `scripts/test-tools.ts` and bot scenario tests:

- `search_services` returns `nearMeOption: true` when matches ≥ 2, `false` when 1.
- `search_services_near_me` with no `state.lastLocation` → `{needsLocation: true}`.
- `search_services_near_me` with location → results sorted ascending by `distanceKm`, fixture coords (e.g. KL Sentral) verified to within 0.1 km.
- Clinic with NULL lat/lng appears in `excluded`, not main results.
- Stray location share with no `lastSearchQuery` → bot replies asking for service, does not call near-me tool.
- Cached `lastLocation` not re-prompted on second near-me call.

## Files Touched

- `src/types.ts` — `ThreadState.lastLocation`, `ClinicOption.latitude/longitude/distanceKm`.
- `src/bot/index.ts` — `extractLocation`, location injection, `NEAR_ME` reply branch, near-me row append in interactive render.
- `src/bot/tools/lookup.ts` — `search_services` returns `nearMeOption`, new `search_services_near_me` tool, `loadClinicsByIds` selects coords.
- `src/bot/tools/index.ts` — register new tool.
- `src/bot/prompt.ts` — three new rules + tool name.
- `src/lib/geo.ts` *(new, optional — could inline)* — `haversineKm`.
- `supabase/migrations/002_clinic_geo.sql` — new migration adding lat/lng columns + manual backfill statements for 3 clinics.
- `scripts/test-tools.ts` + bot test scenarios — new cases.

## Open Decisions Resolved

- **Geo source:** A — columns on `c_a_clinics`, manual backfill.
- **Distance compute:** A — Haversine in JS.
- **Near-me UX placement:** B — appended row, only when ≥2 clinics.
- **Filter vs sort:** A — sort all, no distance cap.
- **Stray location share:** Implicit near-me on last query (no cap).
- **Missing coords:** Excluded with note.
- **Location cache:** Per session, no re-prompt.
