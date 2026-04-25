/**
 * Interactive flow harness — tests sendListMessage / sendReplyButtons + onAction
 * routing without hitting WhatsApp. Stubs Meta API via BOT_TEST_MODE=1.
 */
process.env.BOT_TEST_MODE = "1";

import "dotenv/config";
import {
  createFakeThread,
  deliverUserText,
  deliverInteractiveReply,
  type FakeThread,
} from "../src/bot/index";
import {
  drainCapturedInteractive,
  clearCapturedInteractive,
  type CapturedInteractive,
} from "../src/lib/whatsapp";
import type { ThreadState } from "../src/types";

interface CaseResult {
  id: string;
  passed: boolean;
  failures: string[];
  steps: StepRecord[];
}

interface StepRecord {
  label: string;
  posted: string[];
  captured: CapturedInteractive[];
  state: Partial<ThreadState>;
}

function snapshotState(state: ThreadState | null): Partial<ThreadState> {
  if (!state) return {};
  return {
    userId: state.userId,
    activePatientId: state.activePatientId,
    activeClinicId: state.activeClinicId,
    activeServiceId: state.activeServiceId,
    activeMethodId: state.activeMethodId,
    activeDoctorId: state.activeDoctorId,
    clinicOptions: state.clinicOptions as any,
    serviceOptions: state.serviceOptions as any,
    doctorOptions: state.doctorOptions as any,
    patients: state.patients as any,
  };
}

async function runStep(
  thread: FakeThread,
  label: string,
  fn: () => Promise<void>
): Promise<StepRecord> {
  const beforePosted = thread.posted.length;
  clearCapturedInteractive();
  await fn();
  const posted = thread.posted.slice(beforePosted);
  const captured = drainCapturedInteractive();
  const state = snapshotState(thread._state);
  return { label, posted, captured, state };
}

interface CaseSpec {
  id: string;
  phone: string;
  run: (thread: FakeThread, ctx: CaseContext) => Promise<void>;
}

interface CaseContext {
  failures: string[];
  steps: StepRecord[];
  step: (label: string, fn: () => Promise<void>) => Promise<StepRecord>;
  expect: (cond: boolean, msg: string) => void;
}

function pickTimeFromAssistantText(text: string): string | null {
  const m = text.match(/\b(1[0-2]|0?[1-9]):[0-5][0-9]\s?(AM|PM)\b/i);
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
}

const CASES: CaseSpec[] = [
  {
    id: "clinic-list-then-click",
    phone: process.env.SMOKE_PHONE ?? "60174421238",
    async run(thread, ctx) {
      const search = await ctx.step("user asks for checkup", async () => {
        await deliverUserText(thread, "I want a general checkup");
      });
      ctx.expect(
        search.captured.some((c) => c.kind === "list" && /clinic/i.test(c.body)),
        "expected list message asking to choose a clinic"
      );
      const clinicList = search.captured.find((c) => c.kind === "list");
      ctx.expect(
        !!clinicList && clinicList.options.length >= 1,
        "expected at least one clinic option in list"
      );

      const firstClinicId = clinicList?.options[0]?.id;
      ctx.expect(!!firstClinicId, "expected first clinic option id");

      const click = await ctx.step("click first clinic", async () => {
        if (firstClinicId) await deliverInteractiveReply(thread, firstClinicId);
      });
      ctx.expect(
        !!thread._state?.activeClinicId,
        "expected activeClinicId set after clinic click"
      );
      ctx.expect(
        click.captured.length > 0 || click.posted.length > 0,
        "expected response (list of services or text) after clinic click"
      );
    },
  },
  {
    id: "full-booking-flow",
    phone: process.env.SMOKE_PHONE ?? "60174421238",
    async run(thread, ctx) {
      const nextMonday = (() => {
        const d = new Date();
        const day = d.getDay();
        const diff = ((1 - day + 7) % 7) || 7;
        d.setDate(d.getDate() + diff);
        return d.toISOString().slice(0, 10);
      })();

      let last = await ctx.step("ask to book", async () => {
        await deliverUserText(
          thread,
          `I want to book a checkup at any clinic for ${nextMonday}.`
        );
      });

      let safety = 12;
      while (safety-- > 0) {
        const list = last.captured.find((c) => c.kind === "list");
        const buttons = last.captured.find((c) => c.kind === "buttons");

        if (buttons) {
          const yesId =
            buttons.options.find((o) => /yes|confirm/i.test(o.id) || /yes|confirm/i.test(o.title))?.id ??
            buttons.options[0]?.id;
          ctx.expect(!!yesId, "expected confirm button id");
          last = await ctx.step(`click confirm "${yesId}"`, async () => {
            if (yesId) await deliverInteractiveReply(thread, yesId);
          });
          continue;
        }

        if (list) {
          const pick =
            list.options.find((o) => /clinic_select_/i.test(o.id))?.id ??
            list.options.find((o) => /service_select_/i.test(o.id))?.id ??
            list.options.find((o) => /method_select_/i.test(o.id))?.id ??
            list.options.find((o) => /doctor_select_/i.test(o.id))?.id ??
            list.options[0]?.id;
          ctx.expect(!!pick, `expected option to click in list "${list.body}"`);
          last = await ctx.step(`click "${pick}" from "${list.body}"`, async () => {
            if (pick) await deliverInteractiveReply(thread, pick);
          });
          continue;
        }

        const lastText = last.posted.join("\n");
        if (/created|booking id|successfully/i.test(lastText)) {
          break;
        }

        const time = pickTimeFromAssistantText(lastText);
        if (time) {
          last = await ctx.step(`reply with time "${time}"`, async () => {
            await deliverUserText(thread, `Please book me at ${time}.`);
          });
          continue;
        }

        if (/which date|what date|date.*book|prefer.*date/i.test(lastText)) {
          last = await ctx.step("reply with date", async () => {
            await deliverUserText(thread, `Tomorrow ${nextMonday} please.`);
          });
          continue;
        }

        last = await ctx.step("nudge to confirm", async () => {
          await deliverUserText(thread, "Please proceed and confirm the booking.");
        });
      }

      ctx.expect(safety > 0, "exceeded turn budget without finishing booking");
      ctx.expect(
        thread.posted.some((p) => /created|booking id|successfully/i.test(p)),
        "expected final booking confirmation message"
      );
    },
  },
];

function expectFn(failures: string[]) {
  return (cond: boolean, msg: string) => {
    if (!cond) failures.push(msg);
  };
}

async function runCase(spec: CaseSpec): Promise<CaseResult> {
  const failures: string[] = [];
  const steps: StepRecord[] = [];
  const thread = createFakeThread(spec.phone);
  const expect = expectFn(failures);
  const step = async (label: string, fn: () => Promise<void>) => {
    const rec = await runStep(thread, label, fn);
    steps.push(rec);
    return rec;
  };
  try {
    await spec.run(thread, { failures, steps, step, expect });
  } catch (err) {
    failures.push(`thrown: ${(err as Error).message}`);
  }
  return { id: spec.id, passed: failures.length === 0, failures, steps };
}

function formatResult(r: CaseResult): string {
  const lines: string[] = [];
  lines.push(`\n${r.passed ? "PASS" : "FAIL"} ${r.id}`);
  for (const s of r.steps) {
    lines.push(`  • ${s.label}`);
    for (const c of s.captured) {
      const opts = c.options.map((o) => `${o.id}=${o.title}`).join(", ");
      lines.push(`      [${c.kind}] body="${c.body}" options=[${opts}]`);
    }
    for (const p of s.posted) {
      lines.push(`      [text] ${p.slice(0, 200)}${p.length > 200 ? "..." : ""}`);
    }
    const stateKeys = Object.entries(s.state)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.length}]` : v}`)
      .join(" ");
    if (stateKeys) lines.push(`      [state] ${stateKeys}`);
  }
  if (r.failures.length > 0) {
    lines.push(`  failures:`);
    for (const f of r.failures) lines.push(`    - ${f}`);
  }
  return lines.join("\n");
}

async function main() {
  const onlyId = process.argv[2];
  const cases = onlyId ? CASES.filter((c) => c.id === onlyId) : CASES;
  if (cases.length === 0) {
    console.error(`No cases match "${onlyId}". Available:`, CASES.map((c) => c.id).join(", "));
    process.exit(2);
  }
  const results: CaseResult[] = [];
  for (const spec of cases) {
    const r = await runCase(spec);
    results.push(r);
    console.log(formatResult(r));
  }
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(2);
});
