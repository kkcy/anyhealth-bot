import "dotenv/config";
import { generateText } from "../src/lib/config";
import { buildSystemPrompt } from "../src/bot/prompt";
import { createTools } from "../src/bot/tools";
import type { PatientRef, ThreadState } from "../src/types";
import { stepCountIs } from "ai";
import { validateEnv } from "../src/lib/env";
import { getSupabase } from "../src/lib/supabase";
import {
  cleanupSmokeBookings,
  createSmokeRunId,
  type SmokeCleanupResult,
  wrapSmokeBookingTool,
} from "./smoke-cleanup";

type TurnContext = {
  state: ThreadState;
  options: CliOptions;
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
  forbidTools?: string[];
  requireReplyContains?: string[];
  forbidReplyContains?: string[];
  requireToolArgs?: ToolArgRule[] | ((ctx: TurnContext) => ToolArgRule[]);
};

type SmokeCase = {
  id: string;
  requireCreatedBooking?: boolean;
  turns: TurnSpec[];
};

type CliOptions = {
  phone: string;
  fullReply: boolean;
  caseIds: string[];
  keepBookings: boolean;
  expectNoPatient: boolean;
  profileName?: string;
  patientName?: string;
  patientIndex?: number;
  documentQuery?: string;
  documentDateFrom?: string;
  documentDateTo?: string;
};

type SmokeProfile = {
  phone: string;
  patientName?: string;
  patientIndex?: number;
  documentQuery?: string;
  documentDateFrom?: string;
  documentDateTo?: string;
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
  cleanup?: SmokeCleanupResult & { runId: string };
};

const DEFAULT_PHONE = process.env.SMOKE_PHONE ?? "60123456789";

const SMOKE_PROFILES: Record<string, SmokeProfile> = {
  "zhang-rong": {
    phone: "60124850128",
    patientName: "Zhang Rong",
    documentQuery: "flu",
    documentDateFrom: "2026-01-11",
    documentDateTo: "2026-01-16",
  },
};

function normalizeName(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function shouldSelectPatient(ctx: TurnContext): boolean {
  const patientCount = ctx.state.patients?.length ?? 0;
  return patientCount > 1 && !ctx.state.activePatientId;
}

function resolvePreferredPatient(ctx: TurnContext): { index: number; patient: PatientRef } {
  const patients = ctx.state.patients ?? [];
  if (patients.length === 0) {
    throw new Error("Cannot continue flow: no linked patients found in state.");
  }

  const configuredIndex = ctx.options.patientIndex;
  if (configuredIndex !== undefined) {
    if (configuredIndex < 1 || configuredIndex > patients.length) {
      throw new Error(
        `Configured --patient-index=${configuredIndex} is out of range (1-${patients.length}).`
      );
    }
    return { index: configuredIndex, patient: patients[configuredIndex - 1] };
  }

  const configuredName = ctx.options.patientName?.trim();
  if (configuredName) {
    const target = normalizeName(configuredName);
    const matchedIndex = patients.findIndex((p) => normalizeName(p.name) === target);
    if (matchedIndex >= 0) {
      return { index: matchedIndex + 1, patient: patients[matchedIndex] };
    }
    throw new Error(
      `Configured --patient-name="${configuredName}" not found. Available: ${patients
        .map((p) => p.name)
        .join(", ")}`
    );
  }

  if (ctx.state.activePatientId) {
    const activeIndex = patients.findIndex((p) => p.id === ctx.state.activePatientId);
    if (activeIndex >= 0) {
      return { index: activeIndex + 1, patient: patients[activeIndex] };
    }
  }

  return { index: 1, patient: patients[0] };
}

function requirePatientIdentity(ctx: TurnContext): { name: string; ic: string } {
  const { patient: p } = resolvePreferredPatient(ctx);
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
  const timeRegex = /\b(1[0-2]|0?[1-9]):[0-5][0-9]\s?(AM|PM)\b/gi;

  const bookedTimes = new Set<string>();
  const bookedAfterTimeRegex = /((?:1[0-2]|0?[1-9]):[0-5][0-9]\s?(?:AM|PM))[^.!?\n]{0,40}already booked/gi;
  const bookedBeforeTimeRegex = /already booked[^.!?\n]{0,40}((?:1[0-2]|0?[1-9]):[0-5][0-9]\s?(?:AM|PM))/gi;
  let bookedMatch: RegExpExecArray | null;
  while ((bookedMatch = bookedAfterTimeRegex.exec(normalized)) !== null) {
    if (bookedMatch[1]) bookedTimes.add(bookedMatch[1].replace(/\s+/g, " ").trim().toUpperCase());
  }
  while ((bookedMatch = bookedBeforeTimeRegex.exec(normalized)) !== null) {
    if (bookedMatch[1]) bookedTimes.add(bookedMatch[1].replace(/\s+/g, " ").trim().toUpperCase());
  }

  const bulletTimes: string[] = [];
  const bulletRegex = /-\s*((?:1[0-2]|0?[1-9]):[0-5][0-9]\s?(?:AM|PM))/gi;
  let bulletMatch: RegExpExecArray | null;
  while ((bulletMatch = bulletRegex.exec(normalized)) !== null) {
    if (bulletMatch[1]) {
      bulletTimes.push(bulletMatch[1].replace(/\s+/g, " ").trim());
    }
  }
  if (bulletTimes.length > 0) {
    const firstUnbooked = bulletTimes.find((t) => !bookedTimes.has(t.toUpperCase()));
    return firstUnbooked ?? bulletTimes[0];
  }

  const availableSectionIndex = normalized.toLowerCase().search(/available\s+(?:time|times|slots?)/i);
  if (availableSectionIndex >= 0) {
    const section = normalized.slice(availableSectionIndex);
    const sectionTimes: string[] = [];
    let sectionMatch: RegExpExecArray | null;
    while ((sectionMatch = timeRegex.exec(section)) !== null) {
      sectionTimes.push(sectionMatch[0].replace(/\s+/g, " ").trim());
    }
    if (sectionTimes.length > 0) {
      const firstUnbooked = sectionTimes.find((t) => !bookedTimes.has(t.toUpperCase()));
      return firstUnbooked ?? sectionTimes[0];
    }
  }

  const twelveHourTimes: string[] = [];
  let twelveHourMatch: RegExpExecArray | null;
  while ((twelveHourMatch = timeRegex.exec(normalized)) !== null) {
    twelveHourTimes.push(twelveHourMatch[0].replace(/\s+/g, " ").trim());
  }
  if (twelveHourTimes.length > 0) {
    const firstUnbooked = twelveHourTimes.find((t) => !bookedTimes.has(t.toUpperCase()));
    return firstUnbooked ?? twelveHourTimes[0];
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

function buildDocumentIntentMessage(options: CliOptions): string {
  if (options.documentDateFrom && options.documentDateTo) {
    return `I need my consultation documents from ${options.documentDateFrom} to ${options.documentDateTo}.`;
  }
  return "I need my consultation report from last week.";
}

function buildDocumentSearchMessage(options: CliOptions): string {
  const parts: string[] = [];
  if (options.documentQuery) {
    parts.push(`diagnosis "${options.documentQuery}"`);
  }
  if (options.documentDateFrom && options.documentDateTo) {
    parts.push(`date range ${options.documentDateFrom} to ${options.documentDateTo}`);
  }
  if (parts.length > 0) {
    return `Please search my consultation reports with ${parts.join(" and ")}.`;
  }
  return "Please search my consultation reports from last week.";
}

function buildCases(options: CliOptions): SmokeCase[] {
  const cases: SmokeCase[] = [
    {
      id: "booking-flow",
      requireCreatedBooking: true,
      turns: [
        {
          id: "booking-intent",
          message: "Hi, I want to book a consultation tomorrow at 3pm. I have a fever.",
          requireAllTools: ["user_lookup"],
          forbidTools: ["create_booking"],
        },
        {
          id: "booking-select-patient",
          shouldRun: shouldSelectPatient,
          message: (ctx) => {
            const { index, patient } = resolvePreferredPatient(ctx);
            return `I choose patient ${index}, ${patient.name}.`;
          },
          forbidTools: ["create_booking"],
        },
        {
          id: "booking-search-services",
          shouldRun: (ctx) => !ctx.allToolCalls.includes("search_services"),
          message: "Please help me book a consultation tomorrow at 3pm for fever.",
          requireAllTools: ["search_services"],
          forbidTools: ["create_booking"],
        },
        {
          id: "choose-clinic",
          message: (ctx) => {
            const index = chooseClinicIndexForBooking(ctx.state);
            return `I choose clinic ${index}. Please call select_clinic with index ${index}. Do not select a service yet.`;
          },
          requireAllTools: ["select_clinic"],
          forbidTools: ["create_booking", "select_service"],
        },
        {
          id: "choose-service",
          message: "I choose service 1 and method 1. Please select that service and method, but do not create the booking yet.",
          requireAnyTools: ["select_service", "get_clinic_availability"],
          forbidTools: ["create_booking"],
        },
        {
          id: "doctor-options",
          shouldRun: (ctx) => clinicRequiresDoctorSelection(ctx.state) && !ctx.state.activeDoctorId,
          message: "Please show available doctors.",
          requireAllTools: ["get_clinic_doctors"],
          forbidTools: ["create_booking"],
        },
        {
          id: "choose-doctor",
          shouldRun: (ctx) =>
            clinicRequiresDoctorSelection(ctx.state) &&
            !ctx.state.activeDoctorId &&
            (ctx.state.doctorOptions?.length ?? 0) > 1,
          message: "I choose doctor 1. Please select that doctor, but do not create the booking yet.",
          forbidTools: ["create_booking"],
        },
        {
          id: "ensure-doctor-selected",
          shouldRun: (ctx) =>
            clinicRequiresDoctorSelection(ctx.state) &&
            !ctx.state.activeDoctorId &&
            (ctx.state.doctorOptions?.length ?? 0) > 1,
          message: "Please call only select_doctor with index 1 now. Do not create the booking yet.",
          requireAllTools: ["select_doctor"],
          forbidTools: ["create_booking"],
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
          requireAllTools: ["user_lookup"],
        },
        {
          id: "view-select-patient",
          shouldRun: shouldSelectPatient,
          message: (ctx) => {
            const { index, patient } = resolvePreferredPatient(ctx);
            return `I choose patient ${index}, ${patient.name}. Show my bookings.`;
          },
        },
        {
          id: "view-bookings",
          shouldRun: (ctx) => !ctx.allToolCalls.includes("view_bookings"),
          message: "Please show my upcoming bookings now.",
          requireAllTools: ["view_bookings"],
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
          requireAllTools: ["user_lookup"],
        },
        {
          id: "reschedule-select-patient",
          shouldRun: shouldSelectPatient,
          message: (ctx) => {
            const { index, patient } = resolvePreferredPatient(ctx);
            return `I choose patient ${index}, ${patient.name}.`;
          },
        },
        {
          id: "reschedule-view",
          shouldRun: (ctx) => !ctx.allToolCalls.includes("view_bookings"),
          message: "Please show my upcoming bookings first.",
          requireAllTools: ["view_bookings"],
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
          message: buildDocumentIntentMessage(options),
          requireAllTools: ["user_lookup"],
        },
        {
          id: "documents-select-patient",
          shouldRun: shouldSelectPatient,
          message: (ctx) => {
            const { index, patient } = resolvePreferredPatient(ctx);
            return `I choose patient ${index}, ${patient.name}.`;
          },
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
          shouldRun: (ctx) => !ctx.allToolCalls.includes("search_documents"),
          message: buildDocumentSearchMessage(options),
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
          id: "insurance-select-patient",
          shouldRun: shouldSelectPatient,
          message: (ctx) => {
            const { index, patient } = resolvePreferredPatient(ctx);
            return `I choose patient ${index}, ${patient.name}.`;
          },
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

  if (options.expectNoPatient) {
    cases.push({
      id: "booking-no-patient-flow",
      turns: [
        {
          id: "no-patient-intent",
          message: "Hi, I want to make an appointment tomorrow at 3pm.",
          requireAllTools: ["user_lookup"],
          forbidTools: ["create_booking"],
          requireReplyContains: ["patient"],
          forbidReplyContains: ["no account found"],
        },
        {
          id: "no-patient-followup",
          message: "Please help me proceed with booking.",
          requireAllTools: ["user_lookup"],
          forbidTools: ["create_booking"],
          requireReplyContains: ["patient"],
          forbidReplyContains: ["no account found"],
        },
      ],
    });
  }

  return cases;
}

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  let phone = DEFAULT_PHONE;
  let fullReply = false;
  let keepBookings = process.env.SMOKE_KEEP_BOOKINGS === "1";
  let expectNoPatient = process.env.SMOKE_EXPECT_NO_PATIENT === "1";
  let profileName = process.env.SMOKE_PROFILE?.trim() || undefined;
  let patientName = process.env.SMOKE_PATIENT_NAME?.trim() || undefined;
  let patientIndex = process.env.SMOKE_PATIENT_INDEX ? Number(process.env.SMOKE_PATIENT_INDEX) : undefined;
  let documentQuery = process.env.SMOKE_DOC_QUERY?.trim() || undefined;
  let documentDateFrom = process.env.SMOKE_DOC_DATE_FROM?.trim() || undefined;
  let documentDateTo = process.env.SMOKE_DOC_DATE_TO?.trim() || undefined;
  let phoneExplicitlySet = false;
  let patientNameExplicitlySet = false;
  let patientIndexExplicitlySet = false;
  let documentQueryExplicitlySet = false;
  let documentDateFromExplicitlySet = false;
  let documentDateToExplicitlySet = false;
  const caseIds: string[] = [];

  for (const arg of args) {
    if (arg === "--full-reply") {
      fullReply = true;
      continue;
    }
    if (arg === "--keep-smoke-bookings") {
      keepBookings = true;
      continue;
    }
    if (arg === "--expect-no-patient") {
      expectNoPatient = true;
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
      phoneExplicitlySet = true;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length).trim();
      profileName = value || undefined;
      continue;
    }
    if (arg.startsWith("--patient-name=")) {
      const value = arg.slice("--patient-name=".length).trim();
      patientName = value || undefined;
      patientNameExplicitlySet = true;
      continue;
    }
    if (arg.startsWith("--patient-index=")) {
      const raw = arg.slice("--patient-index=".length).trim();
      if (!raw) {
        patientIndex = undefined;
      } else {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error(`Invalid --patient-index value "${raw}". Must be a positive integer.`);
        }
        patientIndex = parsed;
      }
      patientIndexExplicitlySet = true;
      continue;
    }
    if (arg.startsWith("--doc-query=")) {
      const value = arg.slice("--doc-query=".length).trim();
      documentQuery = value || undefined;
      documentQueryExplicitlySet = true;
      continue;
    }
    if (arg.startsWith("--doc-date-from=")) {
      const value = arg.slice("--doc-date-from=".length).trim();
      documentDateFrom = value || undefined;
      documentDateFromExplicitlySet = true;
      continue;
    }
    if (arg.startsWith("--doc-date-to=")) {
      const value = arg.slice("--doc-date-to=".length).trim();
      documentDateTo = value || undefined;
      documentDateToExplicitlySet = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      phone = arg.trim() || phone;
      phoneExplicitlySet = true;
    }
  }

  const profile = profileName ? SMOKE_PROFILES[profileName] : undefined;
  if (profileName && !profile) {
    throw new Error(
      `Unknown profile "${profileName}". Available profiles: ${Object.keys(SMOKE_PROFILES).join(", ")}`
    );
  }

  if (profile) {
    if (!phoneExplicitlySet) phone = profile.phone;
    if (!patientNameExplicitlySet && profile.patientName) patientName = profile.patientName;
    if (!patientIndexExplicitlySet && profile.patientIndex !== undefined) patientIndex = profile.patientIndex;
    if (!documentQueryExplicitlySet && profile.documentQuery) documentQuery = profile.documentQuery;
    if (!documentDateFromExplicitlySet && profile.documentDateFrom) documentDateFrom = profile.documentDateFrom;
    if (!documentDateToExplicitlySet && profile.documentDateTo) documentDateTo = profile.documentDateTo;
  }

  if (patientName && patientIndex !== undefined) {
    throw new Error("Use either --patient-name or --patient-index, not both.");
  }

  return {
    phone,
    fullReply,
    caseIds,
    keepBookings,
    expectNoPatient,
    profileName,
    patientName,
    patientIndex,
    documentQuery,
    documentDateFrom,
    documentDateTo,
  };
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
  reply: string,
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>,
  requiredToolArgs: ToolArgRule[]
): string[] {
  const failures: string[] = [];
  const requiredAll = turn.requireAllTools ?? [];
  const requiredAny = turn.requireAnyTools ?? [];
  const forbidden = turn.forbidTools ?? [];
  const requireReplyContains = turn.requireReplyContains ?? [];
  const forbidReplyContains = turn.forbidReplyContains ?? [];
  const normalizedReply = reply.toLowerCase();

  const missing = requiredAll.filter((tool) => !calledTools.includes(tool));
  if (missing.length > 0) {
    failures.push(`Missing required tools: ${missing.join(", ")}`);
  }

  if (requiredAny.length > 0 && !requiredAny.some((tool) => calledTools.includes(tool))) {
    failures.push(`Expected one of tools: ${requiredAny.join(", ")}`);
  }

  const forbiddenCalled = forbidden.filter((tool) => calledTools.includes(tool));
  if (forbiddenCalled.length > 0) {
    failures.push(`Forbidden tools called: ${forbiddenCalled.join(", ")}`);
  }

  for (const phrase of requireReplyContains) {
    if (!normalizedReply.includes(phrase.toLowerCase())) {
      failures.push(`Reply missing required phrase: ${phrase}`);
    }
  }

  for (const phrase of forbidReplyContains) {
    if (normalizedReply.includes(phrase.toLowerCase())) {
      failures.push(`Reply contains forbidden phrase: ${phrase}`);
    }
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
  const smokeRunId = createSmokeRunId(testCase.id);
  const createdBookingIds: string[] = [];
  let cleanup: (SmokeCleanupResult & { runId: string }) | undefined;

  const updateState = async (partial: Partial<ThreadState>) => {
    Object.assign(state, partial);
  };

  const tools = options.keepBookings
    ? createTools(state, updateState)
    : wrapSmokeBookingTool(createTools(state, updateState), smokeRunId, createdBookingIds);
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  const allToolCalls: string[] = [];
  const turns: TurnResult[] = [];
  const caseFailures: string[] = [];

  try {
    for (const turn of testCase.turns) {
      const ctx: TurnContext = {
        state,
        options,
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
        system: buildSystemPrompt(state),
        tools,
        stopWhen: stepCountIs(12),
        messages: [...history, { role: "user", content: message }],
      });

      const toolCalls = collectToolCalls(result);
      const calledTools = Array.from(new Set(toolCalls.map((c) => c.toolName)));
      const reply = (result.text ?? "").trim();
      const failures = evaluateTurnRequirements(turn, calledTools, reply, toolCalls, requiredToolArgs);
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
  } finally {
    if (!options.keepBookings) {
      cleanup = {
        runId: smokeRunId,
        ...(await cleanupSmokeBookings(getSupabase(), smokeRunId, createdBookingIds)),
      };
      for (const error of cleanup.errors) {
        caseFailures.push(`[cleanup] ${error}`);
      }
    }
  }

  if (testCase.requireCreatedBooking && createdBookingIds.length === 0) {
    caseFailures.push("[case] Expected smoke flow to create a booking, but no booking id was returned.");
  }

  return {
    id: testCase.id,
    passed: caseFailures.length === 0,
    failures: caseFailures,
    allTools: Array.from(new Set(allToolCalls)),
    turns,
    cleanup,
  };
}

async function main() {
  validateEnv();
  const options = parseCliArgs();
  const allCases = buildCases(options);
  const selectedCases =
    options.caseIds.length > 0
      ? allCases.filter((c) => options.caseIds.includes(c.id))
      : allCases;

  if (options.caseIds.length > 0 && selectedCases.length === 0) {
    console.error(`No matching case found for: ${options.caseIds.join(", ")}`);
    console.error(`Available cases: ${allCases.map((c) => c.id).join(", ")}`);
    process.exit(1);
  }

  const unknownCaseIds = options.caseIds.filter((id) => !allCases.some((c) => c.id === id));
  if (unknownCaseIds.length > 0) {
    console.error(`Unknown case id(s): ${unknownCaseIds.join(", ")}`);
    console.error(`Available cases: ${allCases.map((c) => c.id).join(", ")}`);
    process.exit(1);
  }

  console.log(`Running multi-turn smoke suite with phone: ${options.phone}`);
  if (options.profileName) {
    console.log(`Profile: ${options.profileName}`);
  }
  if (options.patientName) {
    console.log(`Preferred patient: ${options.patientName}`);
  } else if (options.patientIndex !== undefined) {
    console.log(`Preferred patient index: ${options.patientIndex}`);
  }
  if (options.documentQuery || (options.documentDateFrom && options.documentDateTo)) {
    const filters = [
      options.documentQuery ? `query=${options.documentQuery}` : null,
      options.documentDateFrom && options.documentDateTo
        ? `date=${options.documentDateFrom}..${options.documentDateTo}`
        : null,
    ]
      .filter(Boolean)
      .join(", ");
    console.log(`Document filters: ${filters}`);
  }
  console.log(`Full replies: ${options.fullReply ? "ON" : "OFF"}`);
  console.log(`Smoke booking cleanup: ${options.keepBookings ? "OFF" : "ON"}`);
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
    if (r.cleanup) {
      console.log(
        `  Cleanup: run=${r.cleanup.runId}, ids=${r.cleanup.deletedById}, marker=${
          r.cleanup.deletedByMarker ? "ok" : "failed"
        }`
      );
    }

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
