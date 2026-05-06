import "dotenv/config";
import { createFakeThread, deliverInteractiveReply, deliverUserText } from "../src/bot/index";
import type { ThreadState } from "../src/types";

type BotCase = {
  id: string;
  run: () => Promise<string[]>;
};

function includesAll(text: string, needles: string[]): boolean {
  const lower = text.toLowerCase();
  return needles.every((n) => lower.includes(n.toLowerCase()));
}

const cases: BotCase[] = [
  {
    id: "intent-edit-time-interactive",
    run: async () => {
      const failures: string[] = [];
      const thread = createFakeThread(process.env.SMOKE_PHONE ?? "60123456789");

      await deliverUserText(thread, "book gp tomorrow 9am");
      const stateAfterFirst = (thread._state ?? {}) as ThreadState;
      if (!stateAfterFirst.activeClinicId) failures.push("expected activeClinicId after booking intent");

      await deliverInteractiveReply(thread, "booking_confirm_no");
      const stateAfterNo = (thread._state ?? {}) as ThreadState;
      if (!stateAfterNo.activeClinicId) failures.push("booking_confirm_no should not wipe active clinic selection");

      await deliverInteractiveReply(thread, "edit_time");
      const thirdReply = thread.posted[thread.posted.length - 1] ?? "";
      if (!includesAll(thirdReply, ["pick a date first"])) {
        failures.push(`edit_time did not render time edit prompt; got: ${thirdReply}`);
      }

      return failures;
    },
  },
  {
    id: "intent-guard-reentry-state",
    run: async () => {
      const failures: string[] = [];
      const thread = createFakeThread(process.env.SMOKE_PHONE ?? "60123456789");

      await deliverUserText(thread, "book gp tomorrow 9am");
      const st1 = (thread._state ?? {}) as ThreadState;
      const beforeService = st1.extractedIntent?.serviceKeyword;
      if (!beforeService) failures.push("expected extractedIntent.serviceKeyword after first booking intent");

      await deliverUserText(thread, "book dentist next week 11am");
      const st2 = (thread._state ?? {}) as ThreadState;
      const afterService = st2.extractedIntent?.serviceKeyword;

      if (beforeService && afterService && beforeService !== afterService) {
        failures.push(`re-entry guard failed: service changed from ${beforeService} to ${afterService}`);
      }

      return failures;
    },
  },
  {
    id: "intent-no-booking-intent-state",
    run: async () => {
      const failures: string[] = [];
      const thread = createFakeThread(process.env.SMOKE_PHONE ?? "60123456789");

      await deliverUserText(thread, "What are your clinic hours?");
      const st = (thread._state ?? {}) as ThreadState;
      if (st.extractedIntent && Object.keys(st.extractedIntent).length > 0) {
        failures.push(`expected no extractedIntent for non-booking query, got ${JSON.stringify(st.extractedIntent)}`);
      }
      return failures;
    },
  },
];

async function main() {
  let pass = 0;
  let fail = 0;

  for (const c of cases) {
    const failures = await c.run();
    if (failures.length === 0) {
      pass += 1;
      console.log(`[PASS] ${c.id}`);
      continue;
    }
    fail += 1;
    console.log(`[FAIL] ${c.id}`);
    for (const f of failures) console.log(`  - ${f}`);
  }

  console.log(`\nSummary: ${pass}/${cases.length} passed, ${fail} failed.`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
