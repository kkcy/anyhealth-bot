import {
  appendSmokeTag,
  collectBookingId,
  cleanupSmokeBookings,
  injectSmokeBookingTag,
} from "./smoke-cleanup";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

async function main() {
  const runId = "case-123";
  assert(
    appendSmokeTag("please remind me", runId) === "please remind me [smoke-test:case-123]",
    "appendSmokeTag appends marker to existing remark"
  );
  assert(
    appendSmokeTag(undefined, runId) === "[smoke-test:case-123]",
    "appendSmokeTag creates marker-only remark when absent"
  );

  const originalArgs = { date: "2026-05-05", reminderRemark: "bring IC" };
  const taggedArgs = injectSmokeBookingTag(originalArgs, runId);
  assert(
    taggedArgs.reminderRemark === "bring IC [smoke-test:case-123]",
    "injectSmokeBookingTag tags reminderRemark"
  );
  assert(
    originalArgs.reminderRemark === "bring IC",
    "injectSmokeBookingTag does not mutate original args"
  );

  const ids: string[] = [];
  collectBookingId(JSON.stringify({ success: true, bookingId: "booking-1" }), ids);
  collectBookingId({ success: true, bookingId: "booking-2" }, ids);
  collectBookingId("not json", ids);
  assert(ids.join(",") === "booking-1,booking-2", "collectBookingId records ids from string and object results");

  const calls: Array<{ action: string; value: unknown }> = [];
  const supabase = {
    from(table: string) {
      calls.push({ action: "from", value: table });
      return {
        delete() {
          calls.push({ action: "delete", value: null });
          return {
            in(column: string, values: string[]) {
              calls.push({ action: `in:${column}`, value: values });
              return Promise.resolve({ error: null });
            },
            ilike(column: string, value: string) {
              calls.push({ action: `ilike:${column}`, value });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };

  const cleanup = await cleanupSmokeBookings(supabase as any, "case-456", ["booking-3", "booking-3"]);
  assert(cleanup.deletedById === 1, "cleanupSmokeBookings deduplicates booking ids");
  assert(cleanup.deletedByMarker === true, "cleanupSmokeBookings deletes rows containing smoke marker");
  assert(
    calls.some((c) => c.action === "ilike:remark" && c.value === "%[smoke-test:case-456]%"),
    "cleanupSmokeBookings uses marker fallback"
  );

  if (failures > 0) {
    console.error(`\n${failures} failures`);
    process.exit(1);
  }
  console.log("\nAll tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
