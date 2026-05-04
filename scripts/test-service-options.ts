import "dotenv/config";
import { buildServiceOptions, collectMethodIds } from "../src/bot/tools/service-options";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else { console.error(`FAIL: ${label}`); failures++; }
}

async function main() {
  const rows = [
    {
      id: "info_1",
      service_id: "svc_1",
      price: 35,
      duration: 30,
      reminder_remark: "Bring medication",
      service: {
        id: "svc_1",
        clinic_id: "clinic_1",
        service_name: "General Consultation",
        description: "Fever, cough, flu",
      },
      doctor: { id: "doctor_1", name: "Dr. Tan", clinic_id: "clinic_1" },
      method: {
        id: "method_walkin",
        method: "Walk-in",
        time_required: null,
        address_required: false,
      },
    },
    {
      id: "info_2",
      service_id: "svc_1",
      price: 35,
      duration: 30,
      reminder_remark: "Bring medication",
      service: {
        id: "svc_1",
        clinic_id: "clinic_1",
        service_name: "General Consultation",
        description: "Fever, cough, flu",
      },
      doctor: { id: "doctor_2", name: "Dr. Lim", clinic_id: "clinic_1" },
      method: {
        id: "method_appt",
        method: "Appointment",
        time_required: 30,
        address_required: false,
      },
    },
  ];

  const options = buildServiceOptions(rows);

  assert(options.length === 1, "service_info rows for the same service collapse into one service option");
  assert(options[0].serviceId === "svc_1", "service option id is c_a_service_list.id");
  assert(options[0].serviceName === "General Consultation", "service option uses c_a_service_list.service_name");
  assert(options[0].durationMinutes === 30, "duration comes from c_a_service_info.duration");
  assert(options[0].price === 35, "price comes from c_a_service_info.price");
  assert(options[0].methods.length === 2, "unique c_a_method rows become method choices");
  assert(options[0].methods[0].methodId === "method_walkin", "method id is c_a_method.id");
  assert(options[0].methods[0].methodName === "Walk-in", "method name is c_a_method.method");
  assert(options[0].methods[0].requiresTime === false, "null time_required does not require time");
  assert(options[0].methods[1].requiresTime === true, "non-null time_required requires time");

  const ids = collectMethodIds(rows);
  assert(
    ids.length === 2 && ids.includes("method_walkin") && ids.includes("method_appt"),
    "collectMethodIds returns unique new-schema method ids",
  );

  if (failures > 0) { console.error(`\n${failures} failures`); process.exit(1); }
  console.log("\nAll tests passed");
}

main();
