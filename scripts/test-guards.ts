import "dotenv/config";
import assert from "node:assert/strict";
import { createTools } from "../src/bot/tools";
import type { ThreadState } from "../src/types";

type JsonRecord = Record<string, unknown>;

function makeState(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    phone: "60123456789",
    verified: false,
    verifyAttempts: 0,
    ...overrides,
  };
}

function parseResult(raw: unknown): JsonRecord {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as JsonRecord;
    } catch {
      return { raw };
    }
  }
  if (raw && typeof raw === "object") return raw as JsonRecord;
  return { raw };
}

async function runGuardTests() {
  const tests: Array<{
    name: string;
    run: () => Promise<JsonRecord>;
    assert: (result: JsonRecord) => void;
  }> = [
    {
      name: "documents blocked before verification",
      run: async () => {
        const state = makeState();
        const tools: any = createTools(state, async (p) => Object.assign(state, p));
        return parseResult(await tools.search_documents.execute({ query: "heart" }));
      },
      assert: (r) => assert.match(String(r.error ?? ""), /Identity verification required/i),
    },
    {
      name: "insurance upload blocked before verification",
      run: async () => {
        const state = makeState();
        const tools: any = createTools(state, async (p) => Object.assign(state, p));
        return parseResult(await tools.upload_insurance.execute({ fileUrl: "https://example.com/policy.pdf" }));
      },
      assert: (r) => assert.match(String(r.error ?? ""), /Identity verification required/i),
    },
    {
      name: "insurance list blocked before verification",
      run: async () => {
        const state = makeState();
        const tools: any = createTools(state, async (p) => Object.assign(state, p));
        return parseResult(await tools.list_insurance.execute({}));
      },
      assert: (r) => assert.match(String(r.error ?? ""), /Identity verification required/i),
    },
    {
      name: "insurance ask blocked before verification",
      run: async () => {
        const state = makeState();
        const tools: any = createTools(state, async (p) => Object.assign(state, p));
        return parseResult(await tools.ask_insurance.execute({ question: "Am I covered?" }));
      },
      assert: (r) => assert.match(String(r.error ?? ""), /Identity verification required/i),
    },
    {
      name: "booking blocked before user lookup",
      run: async () => {
        const state = makeState();
        const tools: any = createTools(state, async (p) => Object.assign(state, p));
        return parseResult(await tools.create_booking.execute({ date: "2026-04-20", confirmed: true }));
      },
      assert: (r) => assert.match(String(r.error ?? ""), /Call user_lookup/i),
    },
    {
      name: "booking blocked before patient selected",
      run: async () => {
        const state = makeState({ userId: "u-1" });
        const tools: any = createTools(state, async (p) => Object.assign(state, p));
        return parseResult(await tools.create_booking.execute({ date: "2026-04-20", confirmed: true }));
      },
      assert: (r) => assert.match(String(r.error ?? ""), /No patient selected/i),
    },
    {
      name: "booking blocked without confirmation",
      run: async () => {
        const state = makeState({ userId: "u-1", activePatientId: "p-1" });
        const tools: any = createTools(state, async (p) => Object.assign(state, p));
        return parseResult(await tools.create_booking.execute({ date: "2026-04-20", confirmed: false }));
      },
      assert: (r) => assert.match(String(r.error ?? ""), /confirm all booking details/i),
    },
    {
      name: "availability blocked without clinic selection",
      run: async () => {
        const state = makeState();
        const tools: any = createTools(state, async (p) => Object.assign(state, p));
        return parseResult(await tools.get_clinic_availability.execute({ date: "2026-04-20" }));
      },
      assert: (r) => assert.match(String(r.error ?? ""), /No clinic selected/i),
    },
    {
      name: "view bookings blocked before user lookup",
      run: async () => {
        const state = makeState();
        const tools: any = createTools(state, async (p) => Object.assign(state, p));
        return parseResult(await tools.view_bookings.execute({}));
      },
      assert: (r) => assert.match(String(r.error ?? ""), /Call user_lookup/i),
    },
    {
      name: "reschedule blocked before user lookup",
      run: async () => {
        const state = makeState();
        const tools: any = createTools(state, async (p) => Object.assign(state, p));
        return parseResult(
          await tools.reschedule_booking.execute({
            bookingId: "00000000-0000-4000-8000-000000000000",
            newDate: "2026-04-25",
          })
        );
      },
      assert: (r) => assert.match(String(r.error ?? ""), /start a conversation first/i),
    },
    {
      name: "cancel blocked before user lookup",
      run: async () => {
        const state = makeState();
        const tools: any = createTools(state, async (p) => Object.assign(state, p));
        return parseResult(await tools.cancel_booking.execute({ bookingId: "00000000-0000-4000-8000-000000000000" }));
      },
      assert: (r) => assert.match(String(r.error ?? ""), /start a conversation first/i),
    },
  ];

  let passed = 0;
  const failures: string[] = [];

  for (const t of tests) {
    try {
      const result = await t.run();
      t.assert(result);
      console.log(`PASS: ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`FAIL: ${t.name}`);
      console.error(err);
      failures.push(t.name);
    }
  }

  console.log(`\nSummary: ${passed}/${tests.length} guard tests passed.`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

runGuardTests().catch((err) => {
  console.error("Guard test runner crashed:", err);
  process.exit(1);
});

