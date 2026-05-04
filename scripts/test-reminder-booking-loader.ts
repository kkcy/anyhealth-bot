import "dotenv/config";
import { getBookingForReminderWithClient } from "../src/lib/reminders/booking-loader";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else { console.error(`FAIL: ${label}`); failures++; }
}

type QueryRecord = { table: string; select?: string };

function fakeSupabase(records: QueryRecord[]) {
  return {
    from(table: string) {
      const record: QueryRecord = { table };
      records.push(record);

      const builder = {
        select(columns: string) {
          record.select = columns;
          return builder;
        },
        eq() {
          return builder;
        },
        maybeSingle: async () => {
          if (table === "c_s_bookings") {
            return {
              data: {
                id: "bk_1",
                wa_user_id: "u_1",
                status: "confirmed",
                original_date: "2026-05-05",
                original_time: "10:30",
                reschedule_date: null,
                reschedule_time: null,
                service_info: {
                  id: "info_1",
                  doctor: { id: "dr_1", name: "Tan", clinic_id: "cl_1" },
                  service: { id: "svc_1", clinic_id: "cl_1", service_name: "General Consultation" },
                },
              },
              error: null,
            };
          }
          if (table === "c_a_clinics") {
            return { data: { id: "cl_1", name: "One Care" }, error: null };
          }
          if (table === "wa_user") {
            return {
              data: { id: "u_1", phone_number: "+60111", username: "Ali" },
              error: null,
            };
          }
          return { data: null, error: null };
        },
      };

      return builder;
    },
  };
}

async function main() {
  const records: QueryRecord[] = [];
  const booking = await getBookingForReminderWithClient(fakeSupabase(records) as any, "bk_1");

  assert(booking?.user_id === "u_1", "booking loader maps wa_user_id to reminder user_id");
  assert(booking?.patient_name === "Ali", "booking loader uses wa_user.username for patient_name");
  assert(booking?.phone === "60111", "booking loader strips plus from wa_user.phone_number");
  assert(booking?.clinic_id === "cl_1", "booking loader resolves clinic id through service_info service");
  assert(booking?.doctor_name === "Tan", "booking loader resolves doctor through service_info");

  const bookingQuery = records.find((r) => r.table === "c_s_bookings");
  assert(
    bookingQuery?.select?.includes("wa_user_id") === true &&
      bookingQuery.select.includes("reschedule_date") &&
      bookingQuery.select.includes("service_info:service_info_id"),
    "booking loader selects new c_s_bookings columns and service_info join",
  );

  const userQuery = records.find((r) => r.table === "wa_user");
  assert(
    userQuery?.select?.includes("phone_number") === true &&
      userQuery.select.includes("username"),
    "booking loader selects phone_number and username from wa_user",
  );

  if (failures > 0) { console.error(`\n${failures} failures`); process.exit(1); }
  console.log("\nAll tests passed");
}

main();
