import "dotenv/config";
import { processJob } from "../src/lib/reminders/sender";
import type { ReminderJobRow } from "../src/lib/reminders/types";
import type { TemplateSendResult } from "../src/lib/whatsapp";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else { console.error(`FAIL: ${label}`); failures++; }
}

function fakeJob(overrides: Partial<ReminderJobRow> = {}): ReminderJobRow {
  return {
    id: "j_1",
    booking_id: "bk_1",
    user_id: "u_1",
    clinic_id: "cl_1",
    phone: "60111",
    kind: "appt_24h",
    template_name: "appt_24h_with_doctor",
    template_vars: {
      patient_name: "Ali",
      clinic_name: "One Care",
      time_string: "10:30 AM, Tue 5 May",
      doctor_name: "Tan",
    },
    send_at: new Date(Date.now() - 1000).toISOString(),
    sent_at: null,
    attempts: 0,
    last_error: null,
    failed_at: null,
    ...overrides,
  };
}

async function main() {
  const calls: any[] = [];
  const fakeDeps = {
    loadBooking: async () => ({
      id: "bk_1",
      user_id: "u_1",
      clinic_id: "cl_1",
      doctor_name: "Tan",
      patient_name: "Ali",
      clinic_name: "One Care",
      phone: "60111",
      status: "confirmed",
      appointment_at: new Date(Date.now() + 24 * 3600 * 1000),
    }),
    isMuted: async () => false,
    sendTemplate: async (_args: any): Promise<TemplateSendResult> => {
      calls.push({ kind: "send", args: _args });
      return { kind: "ok" };
    },
    markSent: async (id: string) => calls.push({ kind: "markSent", id }),
    markFailed: async (id: string, err: string) => calls.push({ kind: "markFailed", id, err }),
    markCancelled: async (id: string, reason: string) => calls.push({ kind: "markCancelled", id, reason }),
    bumpAttempts: async (id: string, err: string) => calls.push({ kind: "bumpAttempts", id, err }),
    muteGlobally: async (phone: string) => calls.push({ kind: "muteGlobally", phone }),
  };

  // Happy path
  await processJob(fakeJob(), fakeDeps);
  assert(calls.some((c) => c.kind === "send"), "happy path: sendTemplate called");
  assert(calls.some((c) => c.kind === "markSent" && c.id === "j_1"), "happy path: markSent called");

  // Booking no longer confirmed -> markCancelled, no send
  calls.length = 0;
  await processJob(fakeJob(), {
    ...fakeDeps,
    loadBooking: async () => ({ ...(await fakeDeps.loadBooking()), status: "cancelled" }),
  });
  assert(
    !calls.some((c) => c.kind === "send"),
    "cancelled booking: no send",
  );
  assert(
    calls.some((c) => c.kind === "markCancelled" && c.reason.includes("not_confirmed")),
    "cancelled booking: markCancelled",
  );

  // Muted between schedule and send -> markCancelled
  calls.length = 0;
  await processJob(fakeJob(), { ...fakeDeps, isMuted: async () => true });
  assert(
    !calls.some((c) => c.kind === "send"),
    "muted: no send",
  );
  assert(
    calls.some((c) => c.kind === "markCancelled" && c.reason.includes("muted")),
    "muted: markCancelled",
  );

  // Permanent block -> markFailed + muteGlobally
  calls.length = 0;
  await processJob(fakeJob(), {
    ...fakeDeps,
    sendTemplate: async () => ({ kind: "permanent_block", metaCode: 131049, detail: "blocked" }),
  });
  assert(
    calls.some((c) => c.kind === "markFailed"),
    "perm block: markFailed",
  );
  assert(
    calls.some((c) => c.kind === "muteGlobally" && c.phone === "60111"),
    "perm block: muteGlobally called",
  );

  // Permanent template -> markFailed, NO muteGlobally
  calls.length = 0;
  await processJob(fakeJob(), {
    ...fakeDeps,
    sendTemplate: async () => ({ kind: "permanent_template", metaCode: 132001, detail: "bad params" }),
  });
  assert(
    calls.some((c) => c.kind === "markFailed"),
    "perm template: markFailed",
  );
  assert(
    !calls.some((c) => c.kind === "muteGlobally"),
    "perm template: no muteGlobally",
  );

  // Transient -> bumpAttempts only
  calls.length = 0;
  await processJob(fakeJob(), {
    ...fakeDeps,
    sendTemplate: async () => ({ kind: "transient", detail: "5xx" }),
  });
  assert(
    calls.some((c) => c.kind === "bumpAttempts"),
    "transient: bumpAttempts",
  );
  assert(
    !calls.some((c) => c.kind === "markFailed" || c.kind === "markSent"),
    "transient: no markSent / markFailed",
  );

  if (failures > 0) { console.error(`\n${failures} failures`); process.exit(1); }
  console.log("\nAll tests passed");
}

main();
