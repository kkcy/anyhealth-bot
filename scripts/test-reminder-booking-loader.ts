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
                user_id: "u_1",
                status: "confirmed",
                original_date: "2026-05-05",
                original_time: "10:30",
                new_date: null,
                new_time: null,
                doctor: { id: "dr_1", name: "Tan", clinic_id: "cl_1" },
              },
              error: null,
            };
          }
          if (table === "c_a_clinics") {
            return { data: { id: "cl_1", name: "One Care" }, error: null };
          }
          if (table === "whatsapp_users") {
            return {
              data: { id: "u_1", whatsapp_number: "+60111", user_name: "Ali" },
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

  assert(booking?.patient_name === "Ali", "booking loader uses whatsapp_users.user_name for patient_name");

  const userQuery = records.find((r) => r.table === "whatsapp_users");
  assert(
    userQuery?.select?.includes("user_name") === true,
    "booking loader selects user_name from whatsapp_users",
  );
  assert(
    userQuery?.select?.includes(" name") !== true,
    "booking loader does not select missing whatsapp_users.name column",
  );

  if (failures > 0) { console.error(`\n${failures} failures`); process.exit(1); }
  console.log("\nAll tests passed");
}

main();
