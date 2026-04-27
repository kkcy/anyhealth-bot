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
