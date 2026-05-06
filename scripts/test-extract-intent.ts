import "dotenv/config";
import { createBookingTools } from "../src/bot/tools/booking";
import type { ThreadState } from "../src/types";

type TestCase = {
  name: string;
  state: Partial<ThreadState>;
  args: Record<string, unknown>;
  expect: (result: unknown, finalState: ThreadState) => string | null;
};

const baseState = (overrides: Partial<ThreadState> = {}): ThreadState => ({
  phone: "60123456789",
  verified: false,
  verifyAttempts: 0,
  ...overrides,
});

const cases: TestCase[] = [
  {
    name: "happy path — all slots",
    state: {},
    args: { serviceKeyword: "gp", date: "2099-05-07", time: "09:00", method: "in_clinic" },
    expect: (result, st) => {
      const r = result as any;
      if (r?.nextAction !== "search_services") return `expected nextAction=search_services, got ${r?.nextAction}`;
      if (r?.nextArgs?.query !== "gp") return `expected nextArgs.query=gp, got ${r?.nextArgs?.query}`;
      if (st.extractedIntent?.serviceKeyword !== "gp") return "serviceKeyword not stored";
      if (st.extractedIntent?.date !== "2099-05-07") return "date not stored";
      if (st.extractedIntent?.time !== "09:00") return "time not stored";
      if (st.extractedIntent?.method !== "in_clinic") return "method not stored";
      return null;
    },
  },
  {
    name: "past date returns date_in_past error and does not store date",
    state: {},
    args: { date: "2020-01-01", time: "09:00" },
    expect: (result, st) => {
      const r = result as any;
      if (r?.error !== "date_in_past") return `expected error=date_in_past, got ${JSON.stringify(r)}`;
      if (st.extractedIntent?.date) return `date should not be stored, got ${st.extractedIntent.date}`;
      if (st.extractedIntent?.time) return "no slots should be stored on validation error";
      return null;
    },
  },
  {
    name: "guard fires when activeServiceId is set",
    state: { activeServiceId: "svc-abc" },
    args: { serviceKeyword: "gp", date: "2099-05-07" },
    expect: (result, st) => {
      const r = result as any;
      if (r?.skipped !== true) return `expected skipped=true, got ${JSON.stringify(r)}`;
      if (r?.reason !== "activeServiceId") return `expected reason=activeServiceId, got ${r?.reason}`;
      if (st.extractedIntent) return `extractedIntent should not be set, got ${JSON.stringify(st.extractedIntent)}`;
      return null;
    },
  },
  {
    name: "guard fires when awaitingAddress is set",
    state: { awaitingAddress: true },
    args: { serviceKeyword: "gp" },
    expect: (result) => {
      const r = result as any;
      if (r?.skipped !== true) return "expected skipped=true";
      if (r?.reason !== "awaitingAddress") return `expected reason=awaitingAddress, got ${r?.reason}`;
      return null;
    },
  },
  {
    name: "confirm-card carve-out: pendingBooking set + new time differs → merge",
    state: {
      activeClinicId: "c1",
      activeServiceId: "s1",
      activeMethodId: "m1",
      pendingBookingDate: "2099-05-07",
      pendingBooking: { date: "2099-05-07", time: "09:00" },
    },
    args: { time: "10:00" },
    expect: (result, st) => {
      const r = result as any;
      if (r?.skipped) return `expected merge, got skipped=${r.skipped} reason=${r.reason}`;
      if (st.extractedIntent?.time !== "10:00") return `expected time=10:00 in extractedIntent, got ${st.extractedIntent?.time}`;
      return null;
    },
  },
  {
    name: "confirm-card carve-out: pendingBooking set + same time → blocked",
    state: {
      activeClinicId: "c1",
      activeServiceId: "s1",
      activeMethodId: "m1",
      pendingBookingDate: "2099-05-07",
      pendingBooking: { date: "2099-05-07", time: "09:00" },
    },
    args: { time: "09:00" },
    expect: (result) => {
      const r = result as any;
      if (r?.skipped !== true) return `expected skipped=true (no diff), got ${JSON.stringify(r)}`;
      return null;
    },
  },
  {
    name: "confirm-card carve-out: pendingBooking set + new date differs → merge",
    state: {
      activeClinicId: "c1",
      activeServiceId: "s1",
      activeMethodId: "m1",
      pendingBookingDate: "2099-05-07",
      pendingBooking: { date: "2099-05-07", time: "09:00" },
    },
    args: { date: "2099-05-08" },
    expect: (result, st) => {
      const r = result as any;
      if (r?.skipped) return "expected merge, got skipped";
      if (st.extractedIntent?.date !== "2099-05-08") return "expected date stored";
      return null;
    },
  },
  {
    name: "confirm-card carve-out: pendingBooking set + isNewPatient differs → merge",
    state: {
      activeClinicId: "c1",
      activeServiceId: "s1",
      activeMethodId: "m1",
      pendingBookingDate: "2099-05-07",
      pendingBooking: { date: "2099-05-07", time: "09:00" },
      pendingIsNewPatient: false,
    },
    args: { isNewPatient: true },
    expect: (result, st) => {
      const r = result as any;
      if (r?.skipped) return "expected merge, got skipped";
      if (st.extractedIntent?.isNewPatient !== true) return "expected isNewPatient=true stored";
      return null;
    },
  },
];

async function run() {
  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    const state = baseState(c.state);
    const updateState = async (partial: Partial<ThreadState>) => {
      Object.assign(state, partial);
    };
    const tools = createBookingTools(state, updateState);
    const tool = (tools as any).extract_booking_intent;
    if (!tool) {
      console.log(`FAIL: ${c.name} — extract_booking_intent tool not registered`);
      fail++;
      continue;
    }
    const raw = await tool.execute(c.args);
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const err = c.expect(parsed, state);
    if (err) {
      console.log(`FAIL: ${c.name} — ${err}`);
      fail++;
    } else {
      console.log(`PASS: ${c.name}`);
      pass++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
