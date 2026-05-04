import "dotenv/config";
import { createLookupTools } from "../src/bot/tools/lookup";
import { createBookingTools } from "../src/bot/tools/booking";
import { getSupabase } from "../src/lib/supabase";
import type { ThreadState } from "../src/types";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else { console.error(`FAIL: ${label}`); failures++; }
}

async function runTool<T>(tool: unknown, args: T): Promise<any> {
  const execute = (tool as any).execute;
  if (typeof execute !== "function") throw new Error("Tool execute function not found");
  const raw = await execute(args);
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function main() {
  const state: ThreadState = {
    phone: "60123450001",
    verified: false,
    verifyAttempts: 0,
  };
  const updateState = async (patch: Partial<ThreadState>) => {
    Object.assign(state, patch);
  };
  const lookup = createLookupTools(state, updateState);

  const user = await runTool(lookup.user_lookup, {});
  assert(user.found === true, "user_lookup finds wa_user by phone_number");
  assert(state.userId === "da59f8c8-7efb-4d09-b522-ff135640f0c4", "user_lookup stores wa_user.id");
  assert((state.patients?.length ?? 0) > 0, "user_lookup loads patient rows");
  if (!state.activePatientId) {
    await runTool(lookup.select_patient, { index: 1 });
  }

  const search = await runTool(lookup.search_services, { query: "consultation" });
  assert(search.found === true || Array.isArray(search.services), "search_services finds new-schema services");
  assert((state.clinicOptions?.length ?? 0) > 0, "search_services stores clinic options");

  if (!state.activeClinicId) {
    await runTool(lookup.select_clinic, { index: 1 });
  }
  assert((state.serviceOptions?.length ?? 0) > 0, "select_clinic stores service options from c_a_service_info");

  const selected = await runTool(lookup.select_service, { index: 1 });
  if (selected.needsMethodSelection) {
    await runTool(lookup.select_service, { index: 1, methodIndex: 1 });
  }
  assert(Boolean(state.activeServiceId), "select_service stores c_a_service_list id");

  const doctors = await runTool(lookup.get_clinic_doctors, {});
  if (!state.activeDoctorId && Array.isArray(doctors.doctors) && doctors.doctors.length > 0) {
    await runTool(lookup.select_doctor, { index: 1 });
  }

  const availability = await runTool(lookup.get_clinic_availability, { date: "2026-05-05" });
  assert(typeof availability.open === "boolean", "get_clinic_availability reads c_a_clinic_time");

  const booking = createBookingTools(state, updateState);
  const view = await runTool(booking.view_bookings, {});
  assert(view.found === true || view.found === false, "view_bookings reads c_s_bookings with service_info_id");

  if (process.env.LIVE_WRITE === "1") {
    const created = await runTool(booking.create_booking, {
      date: "2026-05-05",
      time: "10:30",
      reminderRemark: "temporary schema smoke test",
      confirmed: true,
      bookingType: "consultation",
    });
    if (created.success !== true) console.error("create_booking result", JSON.stringify(created, null, 2));
    assert(created.success === true, "create_booking inserts new-schema c_s_bookings row");
    if (created.bookingId) {
      const { error } = await getSupabase()
        .from("c_s_bookings")
        .delete()
        .eq("id", created.bookingId)
        .eq("remark", "temporary schema smoke test");
      assert(!error, "temporary booking cleanup succeeds");
    }
  }

  if (failures > 0) { console.error(`\n${failures} failures`); process.exit(1); }
  console.log("\nAll tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
