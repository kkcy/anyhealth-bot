import "dotenv/config";
import { computeReminderJobs } from "../src/lib/reminders/scheduler";
import type { BookingForReminder } from "../src/lib/reminders/types";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else { console.error(`FAIL: ${label}`); failures++; }
}

function bookingAt(offsetMs: number, overrides: Partial<BookingForReminder> = {}): BookingForReminder {
  return {
    id: "bk_x",
    user_id: "u_1",
    clinic_id: "cl_1",
    doctor_name: "Tan",
    patient_name: "Ali",
    clinic_name: "One Care",
    phone: "60111",
    status: "confirmed",
    appointment_at: new Date(Date.now() + offsetMs),
    ...overrides,
  };
}

async function main() {
  const ms = (h: number) => h * 3600 * 1000;

  // 48h out -> both T-24h and T-2h scheduled
  {
    const jobs = computeReminderJobs(bookingAt(ms(48)));
    assert(jobs.length === 2, "48h out -> 2 jobs");
    assert(
      jobs.some((j) => j.kind === "appt_24h") && jobs.some((j) => j.kind === "appt_2h"),
      "48h out -> kinds appt_24h + appt_2h",
    );
    assert(jobs[0].template_name.endsWith("_with_doctor"), "with-doctor template selected");
  }

  // 3h out -> only T-2h
  {
    const jobs = computeReminderJobs(bookingAt(ms(3)));
    assert(jobs.length === 1 && jobs[0].kind === "appt_2h", "3h out -> only T-2h");
  }

  // 1h out -> 0 (under buffer for T-2h, T-24h past)
  {
    const jobs = computeReminderJobs(bookingAt(ms(1)));
    assert(jobs.length === 0, "1h out -> 0 jobs");
  }

  // status != confirmed -> 0
  {
    const jobs = computeReminderJobs(bookingAt(ms(48), { status: "pending" }));
    assert(jobs.length === 0, "pending -> 0 jobs");
  }
  {
    const jobs = computeReminderJobs(bookingAt(ms(48), { status: "cancelled" }));
    assert(jobs.length === 0, "cancelled -> 0 jobs");
  }
  {
    const jobs = computeReminderJobs(bookingAt(ms(48), { status: "reschedule_pending" }));
    assert(jobs.length === 0, "reschedule_pending -> 0 jobs");
  }

  // No doctor -> no_doctor template, 3 vars
  {
    const jobs = computeReminderJobs(bookingAt(ms(48), { doctor_name: null }));
    assert(
      jobs.every((j) => j.template_name.endsWith("_no_doctor")),
      "no doctor -> no_doctor templates",
    );
    assert(
      jobs.every((j) => j.template_vars.doctor_name === undefined),
      "no_doctor template_vars omit doctor_name",
    );
  }

  // send_at math: T-24h within 1s of (apptAt - 24h)
  {
    const b = bookingAt(ms(48));
    const jobs = computeReminderJobs(b);
    const t24 = jobs.find((j) => j.kind === "appt_24h")!;
    const diff = Math.abs(t24.send_at.getTime() - (b.appointment_at.getTime() - ms(24)));
    assert(diff < 1000, "T-24h send_at = appointment_at - 24h");
  }

  if (failures > 0) { console.error(`\n${failures} failures`); process.exit(1); }
  console.log("\nAll tests passed");
}

main();
