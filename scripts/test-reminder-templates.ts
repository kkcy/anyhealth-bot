import "dotenv/config";
import {
  pickTemplateName,
  buildTemplateVars,
  buildComponents,
} from "../src/lib/reminders/templates";
import type { BookingForReminder } from "../src/lib/reminders/types";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else { console.error(`FAIL: ${label}`); failures++; }
}

const baseBooking: BookingForReminder = {
  id: "bk_1",
  user_id: "u_1",
  clinic_id: "cl_1",
  doctor_name: "Tan",
  patient_name: "Ali",
  clinic_name: "One Care Clinic",
  phone: "60123456789",
  status: "confirmed",
  appointment_at: new Date("2026-05-05T02:30:00Z"), // 10:30 AM MYT Tue 5 May
};

async function main() {
  // pickTemplateName
  assert(
    pickTemplateName("appt_24h", baseBooking) === "appt_24h_with_doctor",
    "appt_24h with doctor selects with_doctor variant",
  );
  assert(
    pickTemplateName("appt_24h", { ...baseBooking, doctor_name: null }) === "appt_24h_no_doctor",
    "appt_24h without doctor selects no_doctor variant",
  );
  assert(
    pickTemplateName("doc_ready", baseBooking) === "doc_ready",
    "doc_ready has single template",
  );

  // buildTemplateVars
  const v24 = buildTemplateVars("appt_24h", baseBooking);
  assert(
    v24.patient_name === "Ali" &&
      v24.clinic_name === "One Care Clinic" &&
      v24.time_string === "10:30 AM, Tue 5 May" &&
      v24.doctor_name === "Tan",
    "appt_24h_with_doctor vars include doctor_name",
  );
  const v24nd = buildTemplateVars("appt_24h", { ...baseBooking, doctor_name: null });
  assert(
    v24nd.doctor_name === undefined,
    "no_doctor variant omits doctor_name from vars",
  );

  // doc_ready vars require doc_type — passed via overrides
  const vDoc = buildTemplateVars("doc_ready", baseBooking, { doc_type: "medical certificate" });
  assert(
    vDoc.doc_type === "medical certificate" && vDoc.clinic_name === "One Care Clinic",
    "doc_ready vars include doc_type override",
  );

  // buildComponents — appt_24h_with_doctor
  const comps = buildComponents({
    template_name: "appt_24h_with_doctor",
    template_vars: v24,
    booking_id: "bk_1",
    clinic_id: "cl_1",
  });
  // 1 body + 2 buttons
  assert(comps.length === 3, "appt_24h_with_doctor produces 3 components");
  const body = comps.find((c) => c.type === "body");
  assert(
    !!body && body.parameters?.length === 4,
    "body has 4 text params for with_doctor variant",
  );
  const buttons = comps.filter((c) => c.type === "button");
  assert(buttons.length === 2, "two quick-reply buttons present");
  assert(
    (buttons[0].parameters?.[0] as any).payload === "view_booking:bk_1",
    "primary button payload is view_booking:<id>",
  );
  assert(
    (buttons[1].parameters?.[0] as any).payload === "mute_clinic:cl_1",
    "secondary button payload is mute_clinic:<id>",
  );

  // buildComponents — doc_ready uses get_doc payload
  const docComps = buildComponents({
    template_name: "doc_ready",
    template_vars: vDoc,
    booking_id: "bk_1",
    clinic_id: "cl_1",
  });
  const docBtns = docComps.filter((c) => c.type === "button");
  assert(
    (docBtns[0].parameters?.[0] as any).payload === "get_doc:bk_1",
    "doc_ready primary button payload is get_doc:<id>",
  );

  if (failures > 0) { console.error(`\n${failures} failures`); process.exit(1); }
  console.log("\nAll tests passed");
}

main();
