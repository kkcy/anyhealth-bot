import "dotenv/config";
import { generateText } from "../src/lib/config";
import { buildSystemPrompt } from "../src/bot/prompt";
import { createTools } from "../src/bot/tools";
import type { ThreadState } from "../src/types";
import { stepCountIs } from "ai";
import { validateEnv } from "../src/lib/env";

type TurnContext = {
  state: ThreadState;
  allToolCalls: string[];
  turnResults: TurnResult[];
  history: Array<{ role: "user" | "assistant"; content: string }>;
};

type ToolArgRule = {
  tool: string;
  arg: string;
  expectedType?: "boolean" | "string" | "number";
  equals?: unknown;
};

type TurnSpec = {
  id: string;
  message: string | ((ctx: TurnContext) => string);
  shouldRun?: (ctx: TurnContext) => boolean;
  requireAllTools?: string[];
  requireAnyTools?: string[];
  requireToolArgs?: ToolArgRule[] | ((ctx: TurnContext) => ToolArgRule[]);
};

type SmokeCase = {
  id: string;
  turns: TurnSpec[];
};

type CliOptions = {
  phone: string;
  fullReply: boolean;
  caseIds: string[];
};

type TurnResult = {
  id: string;
  message: string;
  reply: string;
  tools: string[];
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>;
  failures: string[];
};

type CaseResult = {
  id: string;
  passed: boolean;
  failures: string[];
  allTools: string[];
  turns: TurnResult[];
};

const DEFAULT_PHONE = process.env.SMOKE_PHONE ?? "60123456789";

function requirePatientIdentity(ctx: TurnContext): { name: string; ic: string } {
  const p = ctx.state.patients?.[0];
  if (!p || !p.name || !p.ic) {
    throw new Error(
      "Cannot continue verification flow: no patient name/IC in state. Use a phone with at least one linked patient."
    );
  }
  return { name: p.name, ic: p.ic };
}

function chooseClinicIndexForBooking(state: ThreadState): number {
  const clinics = state.clinicOptions ?? [];
  if (clinics.length === 0) return 1;

  const withNewPatientLimit = clinics.findIndex((c) => c.newPatientLimit !== null);
  if (withNewPatientLimit >= 0) return withNewPatientLimit + 1;

  const noDoctorSelection = clinics.findIndex((c) => c.doctorSelection === false);
  if (noDoctorSelection >= 0) return noDoctorSelection + 1;

  return 1;
}

function getActiveClinic(state: ThreadState) {
  const activeClinicId = state.activeClinicId;
  if (!activeClinicId) return null;
  return (state.clinicOptions ?? []).find((c) => c.clinicId === activeClinicId) ?? null;
}

function clinicRequiresNewPatientFlag(state: ThreadState): boolean {
  const clinic = getActiveClinic(state);
  return !!clinic && clinic.newPatientLimit !== null;
}

function clinicRequiresDoctorSelection(state: ThreadState): boolean {
  const clinic = getActiveClinic(state);
  return !!clinic && clinic.doctorSelection === true;
}

function pickTimeFromText(text: string): string | null {
  const normalized = text.replace(/\u00a0/g, " ");

  const bulletTimes: string[] = [];
  const bulletRegex = /-\s*((?:1[0-2]|0?[1-9]):[0-5][0-9]\s?(?:AM|PM))/gi;
  let bulletMatch: RegExpExecArray | null;
  while ((bulletMatch = bulletRegex.exec(normalized)) !== null) {
    if (bulletMatch[1]) {
      bulletTimes.push(bulletMatch[1].replace(/\s+/g, " ").trim());
    }
  }
  if (bulletTimes.length > 0) {
    return bulletTimes[0];
  }

  const availableSectionIndex = normalized.toLowerCase().indexOf("available time");
  if (availableSectionIndex >= 0) {
    const section = normalized.slice(availableSectionIndex);
    const fromAvailable = section.match(/\b(1[0-2]|0?[1-9]):[0-5][0-9]\s?(AM|PM)\b/i);
    if (fromAvailable && fromAvailable[0]) {
      return fromAvailable[0].replace(/\s+/g, " ").trim();
    }
  }

  const twelveHour = normalized.match(/\b(1[0-2]|0?[1-9]):[0-5][0-9]\s?(AM|PM)\b/i);
  if (twelveHour && twelveHour[0]) {
    return twelveHour[0].replace(/\s+/g, " ").trim();
  }

  const twentyFour = normalized.match(/\b([01]?[0-9]|2[0-3]):[0-5][0-9]\b/);
  if (twentyFour && twentyFour[0]) {
    return twentyFour[0];
  }

  return null;
}

function shouldChooseAlternateTime(ctx: TurnContext): boolean {
  const lastAssistant = [...ctx.history].reverse().find((m) => m.role === "assistant")?.content ?? "";
  const normalized = lastAssistant.toLowerCase();
  return (
    normalized.includes("already booked") ||
    normalized.includes("available time") ||
    normalized.includes("choose another time") ||
    normalized.includes("which time") ||
    normalized.includes("choose a time")
  );
}

const DEFAULT_CASES: SmokeCase[] = [
  {
    id: "booking-flow",
    turns: [
      {
        id: "booking-intent",
        message: "Hi, I want to book a checkup tomorrow at 3pm.",
        requireAllTools: ["user_lookup", "search_services"],
      },
      {
        id: "choose-clinic",
        message: (ctx) => {
          const index = chooseClinicIndexForBooking(ctx.state);
          return `I choose clinic ${index}.`;
        },
        requireAllTools: ["select_clinic"],
      },
      {
        id: "choose-service",
        message: "I choose service 1 and method 1 if needed.",
        requireAllTools: ["select_service"],
      },
      {
        id: "doctor-options",
        shouldRun: (ctx) => clinicRequiresDoctorSelection(ctx.state) && !ctx.state.activeDoctorId,
        message: "Please show available doctors.",
        requireAllTools: ["get_clinic_doctors"],
      },
      {
        id: "choose-doctor",
        shouldRun: (ctx) =>
          clinicRequiresDoctorSelection(ctx.state) &&
          !ctx.state.activeDoctorId &&
          (ctx.state.doctorOptions?.length ?? 0) > 1,
        message: "I choose doctor 1.",
        requireAllTools: ["select_doctor"],
      },
      {
        id: "new-patient-flag",
        shouldRun: (ctx) => clinicRequiresNewPatientFlag(ctx.state),
        message: "This booking is for an existing patient.",
      },
      {
        id: "choose-time-slot",
        shouldRun: shouldChooseAlternateTime,
        message: (ctx) => {
          const lastAssistant = [...ctx.history].reverse().find((m) => m.role === "assistant")?.content ?? "";
          const selectedTime = pickTimeFromText(lastAssistant) ?? "10:00 AM";
          return `I choose ${selectedTime}.`;
        },
      },
      {
        id: "reminder-remark",
        message: "Reminder remark: please remind me one hour before. Yes, I confirm all details. Please create the booking now.",
        requireAllTools: ["create_booking"],
        requireToolArgs: (ctx) =>
          clinicRequiresNewPatientFlag(ctx.state)
            ? [
                {
                  tool: "create_booking",
                  arg: "isNewPatient",
                  expectedType: "boolean",
                },
              ]
            : [],
      },
    ],
  },
  {
    id: "view-bookings-flow",
    turns: [
      {
        id: "view-intent",
        message: "Can you show my upcoming bookings?",
        requireAllTools: ["user_lookup", "view_bookings"],
      },
      {
        id: "confirm-view",
        message: "Thanks, got it.",
      },
    ],
  },
  {
    id: "reschedule-flow",
    turns: [
      {
        id: "reschedule-intent",
        message: "I need to reschedule my appointment.",
        requireAllTools: ["user_lookup", "view_bookings"],
      },
      {
        id: "reschedule-followup",
        message: "Reschedule booking 1 to next Tuesday at 10:00.",
        requireAnyTools: ["view_bookings", "reschedule_booking"],
      },
    ],
  },
  {
    id: "documents-flow",
    turns: [
      {
        id: "documents-intent",
        message: "I need my consultation report from last week.",
        requireAllTools: ["user_lookup"],
      },
      {
        id: "documents-verify",
        message: (ctx) => {
          const { name, ic } = requirePatientIdentity(ctx);
          return `My full name is ${name} and my IC is ${ic}.`;
        },
        requireAllTools: ["verify_patient"],
      },
      {
        id: "documents-search",
        message: "Please search my consultation reports from last week.",
        requireAllTools: ["search_documents"],
      },
    ],
  },
  {
    id: "insurance-flow",
    turns: [
      {
        id: "insurance-intent",
        message: "What does my insurance cover for specialist consultation?",
        requireAllTools: ["user_lookup"],
      },
      {
        id: "insurance-verify",
        message: (ctx) => {
          const { name, ic } = requirePatientIdentity(ctx);
          return `My full name is ${name} and my IC is ${ic}.`;
        },
        requireAllTools: ["verify_patient"],
      },
      {
        id: "insurance-query",
        message: "Now tell me whether specialist consultation is covered.",
      },
    ],
  },
];

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  let phone = DEFAULT_PHONE;
  let fullReply = false;
  const caseIds: string[] = [];

  for (const arg of args) {
    if (arg === "--full-reply") {
      fullReply = true;
      continue;
    }
    if (arg.startsWith("--case=")) {
      const caseId = arg.slice("--case=".length).trim();
      if (caseId) caseIds.push(caseId);
      continue;
    }
    if (arg.startsWith("--cases=")) {
      const raw = arg.slice("--cases=".length);
      for (const part of raw.split(",")) {
        const caseId = part.trim();
        if (caseId) caseIds.push(caseId);
      }
      continue;
    }
    if (arg.startsWith("--phone=")) {
      phone = arg.slice("--phone=".length).trim() || phone;
      continue;
    }
    if (!arg.startsWith("--")) {
      phone = arg.trim() || phone;
    }
  }

  return { phone, fullReply, caseIds };
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function collectToolCalls(result: any): Array<{ toolName: string; args: Record<string, unknown> }> {
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  for (const step of result.steps ?? []) {
    for (const tc of step.toolCalls ?? []) {
      if (!tc?.toolName) continue;
      const args = parseToolArgs(tc.args ?? tc.input);
      calls.push({ toolName: tc.toolName, args });
    }
  }
  return calls;
}

function evaluateTurnRequirements(
  turn: TurnSpec,
  calledTools: string[],
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>,
  requiredToolArgs: ToolArgRule[]
): string[] {
  const failures: string[] = [];
  const requiredAll = turn.requireAllTools ?? [];
  const requiredAny = turn.requireAnyTools ?? [];

  const missing = requiredAll.filter((tool) => !calledTools.includes(tool));
  if (missing.length > 0) {
    failures.push(`Missing required tools: ${missing.join(", ")}`);
  }

  if (requiredAny.length > 0 && !requiredAny.some((tool) => calledTools.includes(tool))) {
    failures.push(`Expected one of tools: ${requiredAny.join(", ")}`);
  }

  for (const rule of requiredToolArgs) {
    const matchingCalls = toolCalls.filter((c) => c.toolName === rule.tool);
    if (matchingCalls.length === 0) {
      failures.push(`Expected tool for arg assertion not called: ${rule.tool}`);
      continue;
    }

    const callWithArg = matchingCalls.find((c) => Object.prototype.hasOwnProperty.call(c.args, rule.arg));
    if (!callWithArg) {
      failures.push(`Tool ${rule.tool} missing arg "${rule.arg}"`);
      continue;
    }

    const value = callWithArg.args[rule.arg];
    if (rule.expectedType && typeof value !== rule.expectedType) {
      failures.push(
        `Tool ${rule.tool} arg "${rule.arg}" expected type ${rule.expectedType}, got ${typeof value}`
      );
    }
    if (Object.prototype.hasOwnProperty.call(rule, "equals") && value !== rule.equals) {
      failures.push(`Tool ${rule.tool} arg "${rule.arg}" expected value ${String(rule.equals)}, got ${String(value)}`);
    }
  }

  return failures;
}

async function runCase(testCase: SmokeCase, options: CliOptions): Promise<CaseResult> {
  const state: ThreadState = {
    phone: options.phone,
    verified: false,
    verifyAttempts: 0,
  };

  const updateState = async (partial: Partial<ThreadState>) => {
    Object.assign(state, partial);
  };

  const tools = createTools(state, updateState);
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  const allToolCalls: string[] = [];
  const turns: TurnResult[] = [];
  const caseFailures: string[] = [];

  for (const turn of testCase.turns) {
    const ctx: TurnContext = {
      state,
      allToolCalls: [...allToolCalls],
      turnResults: [...turns],
      history: [...history],
    };

    let shouldRun = true;
    if (turn.shouldRun) {
      try {
        shouldRun = turn.shouldRun(ctx);
      } catch (err) {
        const failure = err instanceof Error ? err.message : String(err);
        turns.push({
          id: turn.id,
          message: "(failed to evaluate shouldRun)",
          reply: "",
          tools: [],
          toolCalls: [],
          failures: [failure],
        });
        caseFailures.push(`[${turn.id}] ${failure}`);
        break;
      }
    }
    if (!shouldRun) {
      continue;
    }

    let message: string;
    let requiredToolArgs: ToolArgRule[] = [];
    try {
      message = typeof turn.message === "function" ? turn.message(ctx) : turn.message;
      requiredToolArgs =
        typeof turn.requireToolArgs === "function"
          ? turn.requireToolArgs(ctx)
          : (turn.requireToolArgs ?? []);
    } catch (err) {
      const failure = err instanceof Error ? err.message : String(err);
      turns.push({
        id: turn.id,
        message: "(failed to generate message)",
        reply: "",
        tools: [],
        toolCalls: [],
        failures: [failure],
      });
      caseFailures.push(`[${turn.id}] ${failure}`);
      break;
    }

    const result = await generateText({
      system: buildSystemPrompt(),
      tools,
      stopWhen: stepCountIs(12),
      messages: [...history, { role: "user", content: message }],
    });

    const toolCalls = collectToolCalls(result);
    const calledTools = Array.from(new Set(toolCalls.map((c) => c.toolName)));
    const reply = (result.text ?? "").trim();
    const failures = evaluateTurnRequirements(turn, calledTools, toolCalls, requiredToolArgs);
    if (!reply) failures.push("No assistant text response");

    turns.push({
      id: turn.id,
      message,
      reply,
      tools: calledTools,
      toolCalls,
      failures,
    });

    allToolCalls.push(...calledTools);
    history.push({ role: "user", content: message });
    if (reply) history.push({ role: "assistant", content: reply });

    if (failures.length > 0) {
      for (const failure of failures) {
        caseFailures.push(`[${turn.id}] ${failure}`);
      }
      break;
    }
  }

  return {
    id: testCase.id,
    passed: caseFailures.length === 0,
    failures: caseFailures,
    allTools: Array.from(new Set(allToolCalls)),
    turns,
  };
}

async function main() {
  validateEnv();
  const options = parseCliArgs();
  const selectedCases =
    options.caseIds.length > 0
      ? DEFAULT_CASES.filter((c) => options.caseIds.includes(c.id))
      : DEFAULT_CASES;

  if (options.caseIds.length > 0 && selectedCases.length === 0) {
    console.error(`No matching case found for: ${options.caseIds.join(", ")}`);
    console.error(`Available cases: ${DEFAULT_CASES.map((c) => c.id).join(", ")}`);
    process.exit(1);
  }

  const unknownCaseIds = options.caseIds.filter((id) => !DEFAULT_CASES.some((c) => c.id === id));
  if (unknownCaseIds.length > 0) {
    console.error(`Unknown case id(s): ${unknownCaseIds.join(", ")}`);
    console.error(`Available cases: ${DEFAULT_CASES.map((c) => c.id).join(", ")}`);
    process.exit(1);
  }

  console.log(`Running multi-turn smoke suite with phone: ${options.phone}`);
  console.log(`Full replies: ${options.fullReply ? "ON" : "OFF"}`);
  console.log(`Cases: ${selectedCases.map((c) => c.id).join(", ")}`);
  console.log("");

  const results: CaseResult[] = [];
  for (const testCase of selectedCases) {
    try {
      results.push(await runCase(testCase, options));
    } catch (err) {
      results.push({
        id: testCase.id,
        passed: false,
        failures: [err instanceof Error ? err.message : String(err)],
        allTools: [],
        turns: [],
      });
    }
  }

  let passed = 0;
  let failed = 0;

  for (const r of results) {
    if (r.passed) passed += 1;
    else failed += 1;

    const status = r.passed ? "PASS" : "FAIL";
    console.log(`[${status}] ${r.id}`);
    console.log(`  Tools used: ${r.allTools.length > 0 ? r.allTools.join(", ") : "(none)"}`);

    for (const t of r.turns) {
      console.log(`  Turn ${t.id}`);
      console.log(`    User: ${t.message}`);
      console.log(`    Tools: ${t.tools.length > 0 ? t.tools.join(", ") : "(none)"}`);
      if (t.toolCalls.length > 0) {
        const formattedCalls = t.toolCalls.map((c) => `${c.toolName}(${JSON.stringify(c.args)})`);
        console.log(`    Tool calls: ${formattedCalls.join(" | ")}`);
      }

      if (options.fullReply && t.reply) {
        console.log("    Reply (full):");
        for (const line of t.reply.split("\n")) {
          console.log(`      ${line}`);
        }
      } else if (t.reply) {
        const preview = t.reply.slice(0, 180);
        console.log(`    Reply: ${preview}${preview.length >= 180 ? "..." : ""}`);
      }

      for (const f of t.failures) {
        console.log(`    Failure: ${f}`);
      }
    }

    for (const f of r.failures) {
      console.log(`  Case Failure: ${f}`);
    }
    console.log("");
  }

  console.log(`Summary: ${passed}/${results.length} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Smoke test runner crashed:", err);
  process.exit(1);
});
