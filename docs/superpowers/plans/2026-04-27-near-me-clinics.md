# Near-Me Clinic Suggestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let WhatsApp users tap a "📍 Near me" row in the clinic list after a service search, share their WhatsApp location, and see clinics re-sorted by Haversine distance.

**Architecture:** Add `latitude`/`longitude` columns to `c_a_clinics` (manual backfill). Detect WhatsApp `location` messages in the webhook handler, persist coords to `ThreadState.lastLocation`, and inject a synthetic `[location shared: lat, lng]` user turn for the LLM. New tool `search_services_near_me` reuses the existing service-match query, computes Haversine in JS, returns clinics sorted ascending by distance with NULL-coord clinics in an `excluded` array. Interactive renderer appends a `NEAR_ME` row when the existing clinic-list result has `nearMeOption: true`; tapping it injects "near me" so the LLM calls the new tool.

**Tech Stack:** Next.js 16 + Vercel AI SDK + Supabase (postgres) + WhatsApp Cloud API. Bot lives in `anyhealth-bot/`.

**Spec:** `docs/superpowers/specs/2026-04-27-near-me-clinics-design.md`

---

## File Map

| File | Change |
|---|---|
| `supabase/migrations/002_clinic_geo.sql` | **Create** — add lat/lng columns. |
| `src/types.ts` | **Modify** — add `lastLocation` to `ThreadState`, add `latitude`/`longitude`/`distanceKm` to `ClinicOption`. |
| `src/lib/geo.ts` | **Create** — `haversineKm` helper. |
| `tests/lib/geo.test.ts` | **Create** — unit test for `haversineKm`. |
| `src/bot/index.ts` | **Modify** — `extractLocation`, location-message branch in `handleMessage`, `NEAR_ME` reply mapping, append NEAR_ME row in `buildInteractivePlanFromToolResults` when `nearMeOption: true`. |
| `src/bot/tools/lookup.ts` | **Modify** — `loadClinicsByIds` selects coords; `search_services` returns `nearMeOption`; new `search_services_near_me` tool. |
| `src/bot/prompt.ts` | **Modify** — three new rules, mention new tool. |
| `scripts/test-near-me.ts` | **Create** — integration script exercising the tool path. |

---

## Task 1: Schema migration for clinic geo columns

**Files:**
- Create: `supabase/migrations/002_clinic_geo.sql`

- [ ] **Step 1: Create migration**

```sql
-- 002_clinic_geo.sql
-- Add geographic coordinates to c_a_clinics for the bot's "near me" feature.

alter table c_a_clinics
  add column if not exists latitude double precision,
  add column if not exists longitude double precision;

comment on column c_a_clinics.latitude is 'Decimal degrees, WGS84. NULL until backfilled.';
comment on column c_a_clinics.longitude is 'Decimal degrees, WGS84. NULL until backfilled.';

-- Manual backfill happens in a separate one-off SQL run by an operator.
-- Do not invent coordinates here.
```

- [ ] **Step 2: Apply migration locally**

Run: `supabase db push` (from `anyhealth-bot/`) **or** apply the SQL via the Supabase SQL editor against the dev project.
Expected: no error; `\d c_a_clinics` shows `latitude` and `longitude` columns of type `double precision`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/002_clinic_geo.sql
git commit -m "feat(db): add latitude/longitude to c_a_clinics for near-me search"
```

> **Note for the operator (kkcy):** after this lands, run a one-off `update c_a_clinics set latitude = ..., longitude = ... where id = '...';` for the 2 active clinics + 1 TCM clinic with their real coordinates. The plan does not embed coordinates because they must be looked up out-of-band.

---

## Task 2: Extend ThreadState and ClinicOption types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add `lastLocation` to `ThreadState` and geo fields to `ClinicOption`**

Replace the `ClinicOption` and `ThreadState` interfaces in `src/types.ts` with:

```ts
export interface ClinicOption {
  clinicId: string;
  clinicName: string;
  clinicAddress: string;
  doctorSelection: boolean;
  newPatientLimit: number | null;
  matchingServiceCount: number;
  latitude?: number | null;
  longitude?: number | null;
  distanceKm?: number;
}

export interface ThreadState {
  phone: string;
  userId?: string;
  patients?: PatientRef[];
  activePatientId?: string;
  language?: string;
  verified: boolean;
  verifyAttempts: number;
  activeInsuranceId?: string;

  // Booking selections (set by search → select_clinic → select_service → select_doctor)
  lastSearchQuery?: string;
  clinicOptions?: ClinicOption[];
  serviceOptions?: ServiceOption[];
  doctorOptions?: DoctorOption[];
  activeClinicId?: string;
  activeServiceId?: string;
  activeMethodId?: string;
  activeDoctorId?: string;

  // Most recent WhatsApp location share. Cached for the session so the user
  // is not re-prompted for a second "near me" search.
  lastLocation?: {
    lat: number;
    lng: number;
    capturedAt: number;
  };
}
```

- [ ] **Step 2: Type-check**

Run: `bun run dev` briefly, OR `bunx tsc --noEmit` if a script exists; fastest is `bun x tsc --noEmit -p tsconfig.json`.
Expected: no errors related to `ThreadState` or `ClinicOption`.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add lastLocation to ThreadState and geo fields to ClinicOption"
```

---

## Task 3: Haversine helper + unit test

**Files:**
- Create: `src/lib/geo.ts`
- Create: `scripts/test-geo.ts`

- [ ] **Step 1: Write the failing unit test**

Create `scripts/test-geo.ts`:

```ts
import { haversineKm } from "../src/lib/geo";

function approxEqual(actual: number, expected: number, toleranceKm: number): boolean {
  return Math.abs(actual - expected) <= toleranceKm;
}

function assert(condition: boolean, label: string) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`PASS: ${label}`);
}

// KL Sentral → KLCC ~ 3.5 km
const klSentral = { lat: 3.1338, lng: 101.6869 };
const klcc = { lat: 3.1579, lng: 101.7116 };
assert(
  approxEqual(haversineKm(klSentral, klcc), 3.5, 0.4),
  "KL Sentral to KLCC ~ 3.5 km"
);

// Same point = 0
assert(haversineKm(klSentral, klSentral) === 0, "same point = 0 km");

// Symmetric
assert(
  Math.abs(
    haversineKm(klSentral, klcc) - haversineKm(klcc, klSentral)
  ) < 1e-9,
  "haversine is symmetric"
);

console.log("\nAll geo tests passed.");
```

- [ ] **Step 2: Run test, expect failure (file does not exist)**

Run: `bun run scripts/test-geo.ts`
Expected: error like `Cannot find module '../src/lib/geo'`.

- [ ] **Step 3: Implement `haversineKm`**

Create `src/lib/geo.ts`:

```ts
export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}
```

- [ ] **Step 4: Run test again, expect PASS**

Run: `bun run scripts/test-geo.ts`
Expected:
```
PASS: KL Sentral to KLCC ~ 3.5 km
PASS: same point = 0 km
PASS: haversine is symmetric

All geo tests passed.
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/geo.ts scripts/test-geo.ts
git commit -m "feat(geo): add haversineKm helper with unit test"
```

---

## Task 4: WhatsApp location ingestion in `handleMessage`

**Files:**
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Add `extractLocation` helper**

Insert after the `extractInteractiveReplyId` function in `src/bot/index.ts`:

```ts
function extractLocation(message: any): { lat: number; lng: number } | undefined {
  const loc =
    message?.location ??
    message?.payload?.location ??
    (message?.type === "location" ? message : undefined);
  if (!loc) return undefined;
  const lat = Number(loc.latitude ?? loc.lat);
  const lng = Number(loc.longitude ?? loc.lng ?? loc.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return { lat, lng };
}
```

- [ ] **Step 2: Wire location into `handleMessage`**

Inside `handleMessage`, **after** the existing line:

```ts
const isInteractiveClick = !!extractInteractiveReplyId(message);
```

add:

```ts
const incomingLocation = extractLocation(message);
if (incomingLocation) {
  await updateState({
    lastLocation: {
      lat: incomingLocation.lat,
      lng: incomingLocation.lng,
      capturedAt: Date.now(),
    },
  });
  console.log(
    `[BOT] Captured location ${incomingLocation.lat},${incomingLocation.lng}`
  );
}
```

- [ ] **Step 3: Inject synthetic location turn into LLM history**

Find the block (currently around `if (normalizedButtonReply) { ... }`) that pushes interactive-reply text into `history`. Immediately **after** it, add:

```ts
if (incomingLocation) {
  const locText = `[location shared: ${incomingLocation.lat}, ${incomingLocation.lng}]`;
  const lastMessage = (history as any[])[history.length - 1];
  const lastContent = typeof lastMessage?.content === "string" ? lastMessage.content : "";
  if (!lastContent.includes(locText)) {
    (history as any[]).push({ role: "user", content: locText });
  }
}
```

- [ ] **Step 4: Prevent the location share from being treated as a new booking intent**

In the existing block that derives `looksLikeNewBookingIntent`, change:

```ts
const looksLikeNewBookingIntent =
  !isInteractiveClick &&
  /\b(book|booking|appointment|schedule|checkup|consult)\b/i.test(incomingText);
```

to:

```ts
const looksLikeNewBookingIntent =
  !isInteractiveClick &&
  !incomingLocation &&
  /\b(book|booking|appointment|schedule|checkup|consult)\b/i.test(incomingText);
```

(Reason: a stray location share must NOT clear the existing booking selections — it is a continuation of the current search.)

- [ ] **Step 5: Smoke-test with a synthetic location payload**

Run: `bun run scripts/test-tools.ts 60123456789 ""` — this is a smoke check that the file still imports cleanly. (Full e2e is in Task 9.)
Expected: process exits 0 (no import or runtime errors).

- [ ] **Step 6: Commit**

```bash
git add src/bot/index.ts
git commit -m "feat(bot): ingest WhatsApp location messages and inject into LLM history"
```

---

## Task 5: Add coords to clinic loader + `nearMeOption` to `search_services`

**Files:**
- Modify: `src/bot/tools/lookup.ts`

- [ ] **Step 1: Extend `loadClinicsByIds` to attempt selecting `latitude` and `longitude`**

Replace the `selectAttempts` array inside `loadClinicsByIds` with:

```ts
const selectAttempts = [
  "id, name, address, doctor_selection, dr_selection, new_patient_limit, latitude, longitude",
  "id, name, address, doctor_selection, new_patient_limit, latitude, longitude",
  "id, name, address, doctor_selection, latitude, longitude",
  // Fallbacks for older schemas without coords (degraded distance ranking)
  "id, name, address, doctor_selection, dr_selection, new_patient_limit",
  "id, name, address, doctor_selection, new_patient_limit",
  "id, name, address, doctor_selection",
];
```

(The existing fallback chain pattern is preserved — coords are tried first and degraded if the column is missing.)

- [ ] **Step 2: Populate `latitude`/`longitude` in `clinicOptions` mapping inside `search_services`**

Find the `clinicOptions: ClinicOption[] = clinics.map((c) => { ... })` block in `search_services` and replace the returned object with:

```ts
return {
  clinicId,
  clinicName: String(c.name ?? ""),
  clinicAddress: String(c.address ?? ""),
  doctorSelection: normalizeDoctorSelection(c),
  newPatientLimit: normalizeNewPatientLimit(c.new_patient_limit),
  matchingServiceCount: clinicCounts[clinicId] ?? 0,
  latitude:
    typeof c.latitude === "number" && Number.isFinite(c.latitude)
      ? c.latitude
      : null,
  longitude:
    typeof c.longitude === "number" && Number.isFinite(c.longitude)
      ? c.longitude
      : null,
};
```

- [ ] **Step 3: Add `nearMeOption` to the multi-clinic return JSON**

Find the multi-clinic `return JSON.stringify({ found: true, clinics: ... })` at the bottom of `search_services` and replace with:

```ts
return JSON.stringify({
  found: true,
  clinics: clinicOptions.map((c, i) => ({
    index: i + 1,
    name: c.clinicName,
    address: c.clinicAddress,
    matchingServices: c.matchingServiceCount,
  })),
  nearMeOption: clinicOptions.length >= 2,
  instruction:
    "Present these clinics to the user. When they choose, call select_clinic with the index number. " +
    "If nearMeOption is true, the system will append a 'Near me' option to the interactive list — if the user picks it, call search_services_near_me.",
});
```

- [ ] **Step 4: Type-check**

Run: `bun x tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/bot/tools/lookup.ts
git commit -m "feat(tools): load clinic coords + return nearMeOption from search_services"
```

---

## Task 6: New `search_services_near_me` tool

**Files:**
- Modify: `src/bot/tools/lookup.ts`

- [ ] **Step 1: Add the import for `haversineKm`**

At the top of `src/bot/tools/lookup.ts`, add:

```ts
import { haversineKm } from "@/lib/geo";
```

- [ ] **Step 2: Add the new tool inside the `return { ... }` of `createLookupTools`**

Insert this tool **immediately after** `search_services` (before `select_clinic`):

```ts
search_services_near_me: tool({
  description:
    "Find clinics matching a service keyword sorted by distance from the user's shared location. " +
    "Call ONLY after the user has shared their WhatsApp location. " +
    "If the user has not shared a location, this tool returns {needsLocation: true} — " +
    "in that case ask the user to share their location via WhatsApp's attachment menu (📎 → Location).",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe(
        "Service keyword. If omitted, falls back to the most recent search query in state."
      ),
  }),
  execute: async ({ query }) => {
    const effectiveQuery = (query ?? state.lastSearchQuery ?? "").trim();
    if (!effectiveQuery) {
      return JSON.stringify({
        error:
          "No search query available. Ask the user what service they are looking for, then call search_services first.",
      });
    }

    if (!state.lastLocation) {
      return JSON.stringify({
        needsLocation: true,
        instruction:
          "Ask the user to share their location via WhatsApp's attachment menu (📎 → Location → Send). " +
          "Do not call this tool again until they share it.",
      });
    }

    const words = effectiveQuery
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1);

    const orConditions = words
      .flatMap((word) => [
        `service_name.ilike.%${word}%`,
        `description.ilike.%${word}%`,
        `category.ilike.%${word}%`,
      ])
      .join(",");

    const { data: cServices, error: cError } = await supabase
      .from("c_a_clinic_service")
      .select("clinic_id")
      .eq("is_active", true)
      .or(orConditions)
      .limit(30);

    const { data: tcmServices, error: tcmError } = await supabase
      .from("tcm_a_clinic_service")
      .select("clinic_id")
      .eq("is_active", true)
      .or(orConditions)
      .limit(30);

    if (cError || tcmError) {
      return JSON.stringify({
        error: "Failed to search services",
        detail: cError?.message || tcmError?.message,
      });
    }

    const allMatches = [...(cServices ?? []), ...(tcmServices ?? [])];
    if (allMatches.length === 0) {
      return JSON.stringify({
        found: false,
        message: "No clinics found matching that service.",
      });
    }

    const clinicCounts: Record<string, number> = {};
    for (const m of allMatches) {
      clinicCounts[m.clinic_id] = (clinicCounts[m.clinic_id] ?? 0) + 1;
    }

    const clinicIds = Object.keys(clinicCounts);
    const { data: clinics, error: clinicLoadError } = await loadClinicsByIds(clinicIds);
    if (clinicLoadError) {
      return JSON.stringify({
        error: "Failed to load clinics",
        detail: clinicLoadError,
      });
    }

    const userLoc = { lat: state.lastLocation.lat, lng: state.lastLocation.lng };

    const ranked: ClinicOption[] = [];
    const excluded: ClinicOption[] = [];

    for (const c of clinics ?? []) {
      const clinicId = String(c.id ?? "");
      const lat =
        typeof c.latitude === "number" && Number.isFinite(c.latitude)
          ? c.latitude
          : null;
      const lng =
        typeof c.longitude === "number" && Number.isFinite(c.longitude)
          ? c.longitude
          : null;

      const opt: ClinicOption = {
        clinicId,
        clinicName: String(c.name ?? ""),
        clinicAddress: String(c.address ?? ""),
        doctorSelection: normalizeDoctorSelection(c),
        newPatientLimit: normalizeNewPatientLimit(c.new_patient_limit),
        matchingServiceCount: clinicCounts[clinicId] ?? 0,
        latitude: lat,
        longitude: lng,
      };

      if (lat === null || lng === null) {
        excluded.push(opt);
      } else {
        opt.distanceKm = haversineKm(userLoc, { lat, lng });
        ranked.push(opt);
      }
    }

    ranked.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));

    const sortedClinics = [...ranked, ...excluded];

    await updateState({
      clinicOptions: sortedClinics,
      lastSearchQuery: effectiveQuery,
      activeClinicId: undefined,
      activeServiceId: undefined,
      activeMethodId: undefined,
      activeDoctorId: undefined,
      serviceOptions: undefined,
      doctorOptions: undefined,
    });

    return JSON.stringify({
      found: true,
      clinics: ranked.map((c, i) => ({
        index: i + 1,
        name: c.clinicName,
        address: c.clinicAddress,
        matchingServices: c.matchingServiceCount,
        distanceKm: c.distanceKm !== undefined
          ? Number(c.distanceKm.toFixed(1))
          : null,
      })),
      excluded: excluded.map((c) => ({
        name: c.clinicName,
        address: c.clinicAddress,
        reason: "no map data",
      })),
      nearMeOption: false,
      instruction:
        "Present these clinics with their distances. When the user chooses, call select_clinic with the index number. " +
        "If any clinics are in 'excluded', mention them by name and note that we don't have their map location yet.",
    });
  },
}),
```

- [ ] **Step 3: Type-check**

Run: `bun x tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/bot/tools/lookup.ts
git commit -m "feat(tools): add search_services_near_me with Haversine ranking"
```

---

## Task 7: Interactive renderer — `NEAR_ME` row + reply mapping

**Files:**
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Append `NEAR_ME` row in `buildInteractivePlanFromToolResults`**

In `src/bot/index.ts`, find the block:

```ts
if (
  toolName === "search_services" &&
  data.found === true &&
  Array.isArray(data.clinics) &&
  !state.activeClinicId
) {
  const options = data.clinics
    .slice(0, 10)
    .map((c: any) => ({
      id: `clinic_select_${Number(c.index)}`,
      title: clip(String(c.name ?? `Clinic ${c.index}`), 24),
      description: c.address ? clip(String(c.address), 72) : undefined,
    }));
  if (options.length > 0) {
    return { body: "Please choose a clinic.", options };
  }
}
```

Replace with:

```ts
if (
  (toolName === "search_services" || toolName === "search_services_near_me") &&
  data.found === true &&
  Array.isArray(data.clinics) &&
  !state.activeClinicId
) {
  // WhatsApp list rows max out at 10 entries (across all sections),
  // so when nearMeOption is true we cap data clinics to 9 to leave room
  // for the synthetic "Near me" row.
  const cap = data.nearMeOption === true ? 9 : 10;
  const options = data.clinics
    .slice(0, cap)
    .map((c: any) => ({
      id: `clinic_select_${Number(c.index)}`,
      title: clip(String(c.name ?? `Clinic ${c.index}`), 24),
      description:
        typeof c.distanceKm === "number"
          ? clip(`${c.distanceKm.toFixed(1)} km · ${String(c.address ?? "")}`, 72)
          : c.address
          ? clip(String(c.address), 72)
          : undefined,
    }));
  if (data.nearMeOption === true) {
    options.push({
      id: "NEAR_ME",
      title: "📍 Near me",
      description: "Sort clinics by distance from you",
    });
  }
  if (options.length > 0) {
    return { body: "Please choose a clinic.", options };
  }
}
```

- [ ] **Step 2: Map `NEAR_ME` reply to synthetic user text**

In `mapInteractiveReplyToText`, add this branch **before** the existing `booking_confirm_yes` branch:

```ts
if (replyId === "NEAR_ME") {
  return "I'd like to see clinics near me. Please call search_services_near_me with the previous query.";
}
```

- [ ] **Step 3: Type-check**

Run: `bun x tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/bot/index.ts
git commit -m "feat(bot): render Near me row in clinic list and map NEAR_ME reply"
```

---

## Task 8: System prompt updates

**Files:**
- Modify: `src/bot/prompt.ts`

- [ ] **Step 1: Add three rules + tool mention**

In `src/bot/prompt.ts`, locate the "Booking flow" section (the numbered list starting at `1. Understand what service they need...`). Replace step 3 with:

```
3. search_services returns a list of clinics. If only one clinic, it auto-selects and shows services. If multiple clinics, present them and ask the user to choose → call select_clinic with the index. The system will append a "📍 Near me" option to the interactive list when nearMeOption is true; if the user picks it, call search_services_near_me with the previous query.
```

Then, immediately **after** the closing line of the "Booking flow" section (step 11/end of the numbered list, before `## Document access (SECURITY)`), insert:

```
## Location-based clinic search
- search_services_near_me ranks the matching clinics by distance from the user's shared WhatsApp location.
- If a tool returns {needsLocation: true}, reply warmly asking the user to share their location via WhatsApp's attachment menu (📎 → Location → Send). Do NOT call the tool again until they share it.
- When the user shares a location pin, you will see a synthetic user turn formatted exactly like "[location shared: <lat>, <lng>]". Treat this as an implicit "near me" request on the most recent search query — call search_services_near_me with the previous query. If there is no previous query, ask the user what service they are looking for first.
- When presenting near-me results, include the distance in km next to each clinic (e.g., "Clinic Foo — 1.2 km").
- If the result includes any 'excluded' clinics, mention them by name and note that we don't have their map data yet.
- Never invent distances or coordinates — only show values returned by search_services_near_me.
```

- [ ] **Step 2: Verify file is syntactically valid**

Run: `bun x tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/bot/prompt.ts
git commit -m "feat(prompt): teach the bot about near-me clinic search and location pins"
```

---

## Task 9: Integration test script

**Files:**
- Create: `scripts/test-near-me.ts`
- Modify: `package.json` (add `test:near-me` npm script)

- [ ] **Step 1: Write the integration test script**

Create `scripts/test-near-me.ts`:

```ts
import "dotenv/config";
import { createTools } from "../src/bot/tools";
import type { ThreadState } from "../src/types";

function assert(condition: boolean, label: string) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`PASS: ${label}`);
}

function makeState(partial: Partial<ThreadState> = {}): ThreadState {
  return {
    phone: "60123456789",
    verified: false,
    verifyAttempts: 0,
    ...partial,
  };
}

async function main() {
  const query = process.argv[2] ?? "checkup";

  // ---- Case 1: search_services returns nearMeOption when matches >= 2 ----
  const state1 = makeState();
  const tools1 = createTools(state1, async (p) => {
    Object.assign(state1, p);
  });
  const search = (tools1 as any).search_services;
  const result1Raw = await search.execute({ query });
  const result1 = JSON.parse(result1Raw);
  if (result1.found === true && Array.isArray(result1.clinics)) {
    if (result1.clinics.length >= 2) {
      assert(result1.nearMeOption === true, "nearMeOption=true when 2+ clinics match");
    } else {
      assert(
        result1.nearMeOption === false,
        "nearMeOption=false when <2 clinics match (auto-select)"
      );
    }
  } else {
    console.warn(
      `[skip] search_services returned no multi-clinic result for "${query}" — pick a query that matches >= 2 clinics to exercise nearMeOption=true`
    );
  }

  // ---- Case 2: search_services_near_me without location → needsLocation ----
  const state2 = makeState({ lastSearchQuery: query });
  const tools2 = createTools(state2, async (p) => {
    Object.assign(state2, p);
  });
  const nearMe = (tools2 as any).search_services_near_me;
  const result2 = JSON.parse(await nearMe.execute({}));
  assert(result2.needsLocation === true, "needsLocation=true when no lastLocation");

  // ---- Case 3: search_services_near_me with location → ranked clinics ----
  const state3 = makeState({
    lastSearchQuery: query,
    // KL Sentral approx
    lastLocation: { lat: 3.1338, lng: 101.6869, capturedAt: Date.now() },
  });
  const tools3 = createTools(state3, async (p) => {
    Object.assign(state3, p);
  });
  const nearMe3 = (tools3 as any).search_services_near_me;
  const result3 = JSON.parse(await nearMe3.execute({}));
  if (result3.found === true) {
    assert(Array.isArray(result3.clinics), "ranked clinics array present");
    assert(Array.isArray(result3.excluded), "excluded array present");
    // Distances must be ascending (or null for excluded; excluded array is separate)
    let prev = -Infinity;
    let monotonic = true;
    for (const c of result3.clinics) {
      if (typeof c.distanceKm === "number") {
        if (c.distanceKm < prev) monotonic = false;
        prev = c.distanceKm;
      }
    }
    assert(monotonic, "ranked clinics are sorted ascending by distanceKm");
  } else {
    console.warn(
      `[skip] no near-me match for "${query}" — try a more common service keyword`
    );
  }

  // ---- Case 4: stray location-only call without lastSearchQuery ----
  const state4 = makeState({
    lastLocation: { lat: 3.1338, lng: 101.6869, capturedAt: Date.now() },
  });
  const tools4 = createTools(state4, async (p) => {
    Object.assign(state4, p);
  });
  const nearMe4 = (tools4 as any).search_services_near_me;
  const result4 = JSON.parse(await nearMe4.execute({}));
  assert(
    typeof result4.error === "string",
    "error returned when no query and no lastSearchQuery"
  );

  console.log("\nAll near-me integration tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add npm script to `package.json`**

Locate the `"scripts"` block of `package.json` and add:

```json
"test:near-me": "tsx scripts/test-near-me.ts",
"test:geo": "tsx scripts/test-geo.ts"
```

- [ ] **Step 3: Run the geo test**

Run: `bun run test:geo`
Expected: all assertions pass.

- [ ] **Step 4: Run the near-me integration test against the dev DB**

Run: `bun run test:near-me checkup` (replace `checkup` with a service keyword that matches at least one clinic in the dev DB).
Expected: PASS lines for each case; the case-1 / case-3 assertions may print `[skip]` warnings depending on what is in the dev DB — that is acceptable, but at least one of cases 1 or 3 must produce a `PASS` for `nearMeOption` or `monotonic` to validate the wiring end-to-end.

- [ ] **Step 5: Commit**

```bash
git add scripts/test-near-me.ts scripts/test-geo.ts package.json
git commit -m "test: add near-me and geo integration scripts"
```

---

## Task 10: Manual end-to-end smoke

**Files:** none (manual verification).

- [ ] **Step 1: Backfill clinic coordinates in the dev DB**

Action for the operator (kkcy): open Supabase SQL editor against the dev project and run an UPDATE for the 2 active clinics + 1 TCM clinic with their real lat/lng. Example shape (do **not** copy these placeholder values — look up real coords):

```sql
update c_a_clinics set latitude = 3.1390, longitude = 101.6869 where id = '<clinic-1-uuid>';
update c_a_clinics set latitude = 3.1579, longitude = 101.7116 where id = '<clinic-2-uuid>';
update c_a_clinics set latitude = 3.1500, longitude = 101.7000 where id = '<tcm-clinic-uuid>';
```

- [ ] **Step 2: Run the dev server and exercise the flow on WhatsApp**

Run: `bun run dev`. From a real WhatsApp client paired to the dev bot:
1. Send "I want a checkup" (or any keyword that matches ≥ 2 clinics).
2. Verify the interactive list contains the matching clinics **plus** a "📍 Near me" row at the bottom.
3. Tap "📍 Near me".
4. Verify the bot replies asking you to share your location via 📎 → Location.
5. Share your location.
6. Verify the bot returns the same clinic list re-sorted by distance, with `X.X km` shown in each row's description, closest first.
7. Tap a clinic and confirm the existing booking flow proceeds normally.

Also exercise the "stray share" path: in a fresh chat, send your location with no prior search. The bot should ask what service you are looking for, not crash and not call `search_services_near_me`.

- [ ] **Step 3: Commit nothing (manual verification)**

If any defect is found, open a follow-up commit fixing the specific bug. Do not edit the migration retroactively.

---

## Self-Review Notes

- Spec coverage:
  - §1 Schema → Task 1.
  - §2 Location ingestion → Task 4.
  - §3 ThreadState additions → Task 2.
  - §4 Tool changes → Tasks 5 and 6.
  - §5 Interactive rendering → Task 7.
  - §6 System prompt → Task 8.
  - Edge cases (stray share, missing coords, single-match suppression, cached location) → covered by Tasks 4 (no clear on location), 6 (excluded array), 5 (`>= 2`), 4 (cache). Stray share with no prior search is verified in Task 9 case 4 and Task 10 step 2.
  - Tests → Tasks 3, 9, 10.
- Type consistency: `lastLocation`, `latitude`, `longitude`, `distanceKm`, `nearMeOption`, `NEAR_ME`, `search_services_near_me` are spelled identically in every task that references them.
- No placeholders: clinic UUIDs in Task 10 are intentionally placeholder (operator-supplied); plan does not invent real coordinates. All other code blocks are complete.
