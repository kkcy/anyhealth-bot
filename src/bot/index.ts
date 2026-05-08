import { Chat, toAiMessages } from "chat";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { createPostgresState } from "@chat-adapter/state-pg";
import { generateText } from "@/lib/config";
import { createTools } from "./tools";
import { buildSystemPrompt } from "./prompt";
import { validateEnv } from "@/lib/env";
import { sendListMessage, sendReplyButtons, sendLocationRequest } from "@/lib/whatsapp";
import { downloadWhatsAppMedia } from "@/lib/whatsapp";
import type { ThreadState } from "@/types";
import { stepCountIs } from "ai";
import { parseDeepLinkToken, parseFriendlyPrefill, applyDeepLink } from "./deep-link";
import { resolveClinicBySlug, resolveClinicByName } from "./clinic-resolver";
import { sendWelcome } from "./messages/welcome";
import { parseButtonPayload, handleButtonAction } from "./messages/button-router";
import { uploadMealPhoto } from "@/lib/nutrition/photo-storage";

let _bot: ReturnType<typeof createBot> | null = null;

// In-memory deduplication cache to prevent processing the same WhatsApp message twice
// (e.g., on Meta webhook retries). Entries expire after 5 minutes.
const DEDUP_TTL_MS = 5 * 60 * 1000;
const processedMessages = new Map<string, number>();

function isDuplicate(messageId: string | undefined): boolean {
  if (!messageId) return false;
  const now = Date.now();
  // Clean up expired entries periodically
  if (processedMessages.size > 1000) {
    for (const [id, ts] of processedMessages) {
      if (now - ts > DEDUP_TTL_MS) processedMessages.delete(id);
    }
  }
  if (processedMessages.has(messageId)) return true;
  processedMessages.set(messageId, now);
  return false;
}

function createBot() {
  validateEnv();
  const adapters = {
    whatsapp: createWhatsAppAdapter(),
  };

  const bot = new Chat<typeof adapters, ThreadState>({
    userName: "anyhealth-bot",
    adapters,
    state: createPostgresState(),
    concurrency: "queue",
  });

  bot.onNewMention(async (thread, message) => {
    if (isDuplicate(message?.id)) {
      console.log(`[BOT] Skipping duplicate message ${message.id}`);
      return;
    }
    await thread.subscribe();

    const phone = extractPhone(thread);
    const existing = (await thread.state) as ThreadState | null;
    if (!existing) {
      await thread.setState({
        phone,
        verified: false,
        verifyAttempts: 0,
      });
      console.log("[STATE] Initialized new thread state in onNewMention");
    } else if (!existing.phone) {
      existing.phone = phone;
      await thread.setState(existing);
      console.log("[STATE] Backfilled missing phone in existing state");
    }

    await handleMessage(thread, message);
  });

  bot.onSubscribedMessage(async (thread, message) => {
    if (isDuplicate(message?.id)) {
      console.log(`[BOT] Skipping duplicate message ${message.id}`);
      return;
    }
    await handleMessage(thread, message);
  });

  bot.onAction(async (event) => {
    if (!event.thread) return;
    if (isDuplicate(event.messageId)) {
      console.log(`[BOT] Skipping duplicate action ${event.messageId}`);
      return;
    }
    const synthetic = {
      id: event.messageId,
      interactive: {
        list_reply: { id: event.actionId, title: event.value ?? event.actionId },
      },
    };
    await handleMessage(event.thread, synthetic);
  });

  return bot;
}

export function getBot() {
  if (!_bot) {
    _bot = createBot();
  }
  return _bot;
}

function extractPhone(thread: { id: string }): string {
  const parts = thread.id.split(":");
  return parts[2] ?? "";
}

function shouldSendBookingConfirmButtons(text: string, state: ThreadState): boolean {
  if (!text) return false;
  if (!state.pendingBooking) return false;
  const alreadyFinalized = /\b(created successfully|booking created|booking id)\b/i.test(text);
  return !alreadyFinalized;
}

interface InteractiveOption {
  id: string;
  title: string;
  description?: string;
}

interface InteractivePlan {
  body: string;
  options: InteractiveOption[];
}

// Friendly prompts shown above each interactive list. These strings are also
// used as identity keys downstream (`selectionPlan.body === PLAN_BODY.clinic`)
// — keep the literal in sync with the matchers if you change them.
const PLAN_BODY = {
  patient: "Who's this appointment for?",
  serviceClarify: "What kind of service are you looking for?",
  clinic: "Which clinic would you like?",
  service: "Which service would you like?",
  method: "How would you like the visit?",
  doctor: "Which doctor would you prefer?",
} as const;

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function parseJsonSafe(value: unknown): any {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractInteractiveReplyId(message: any): string | undefined {
  return (
    message?.buttonReply?.id ??
    message?.interactive?.button_reply?.id ??
    message?.interactive?.list_reply?.id ??
    message?.payload?.interactive?.button_reply?.id ??
    message?.payload?.interactive?.list_reply?.id ??
    message?.context?.list_reply?.id ??
    message?.context?.button_reply?.id
  );
}

function extractInteractiveReplyTitle(message: any): string | undefined {
  return (
    message?.buttonReply?.title ??
    message?.interactive?.button_reply?.title ??
    message?.interactive?.list_reply?.title ??
    message?.payload?.interactive?.button_reply?.title ??
    message?.payload?.interactive?.list_reply?.title ??
    message?.context?.list_reply?.title ??
    message?.context?.button_reply?.title
  );
}

function extractLocation(message: any): { lat: number; lng: number } | undefined {
  const loc =
    message?.location ??
    message?.payload?.location ??
    (message?.type === "location" ? message : undefined);
  if (!loc) return undefined;
  const lat = Number(loc.latitude ?? loc.lat);
  const lng = Number(loc.longitude ?? loc.lng ?? loc.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return { lat, lng };
}

function extractImageMediaId(message: any): string | undefined {
  // chat SDK normalizes Meta payload into a Message class with `.raw` =
  // WhatsAppRawMessage = { message: WhatsAppInboundMessage, ... }. The image
  // media id lives at message.raw.message.image.id. Older code paths and tests
  // may still pass the raw inbound shape directly.
  const id =
    message?.raw?.message?.image?.id ??
    message?.image?.id ??
    message?.payload?.image?.id ??
    message?.payload?.messages?.[0]?.image?.id;

  if (!id) {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const attachmentSummary = attachments.map((a: any) => ({
      type: a?.type,
      mimeType: a?.mimeType,
      hasUrl: Boolean(a?.url),
      hasData: Boolean(a?.data),
      hasFetchData: typeof a?.fetchData === "function",
    }));
    console.log("[MEAL] extractImageMediaId miss", {
      messageId: message?.id,
      messageType: message?.raw?.message?.type ?? message?.type,
      hasRaw: Boolean(message?.raw),
      hasRawMessage: Boolean(message?.raw?.message),
      rawImage: message?.raw?.message?.image ? { id: message.raw.message.image.id, mime: message.raw.message.image.mime_type } : undefined,
      topLevelImage: message?.image,
      attachments: attachmentSummary,
    });
  }
  return id;
}

type MealAction =
  | { kind: "meal_confirm" }
  | { kind: "meal_edit" }
  | { kind: "meal_cancel" }
  | { kind: "meal_pick"; patientId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseMealActionFromText(text: string): MealAction | null {
  if (text === "meal_confirm") return { kind: "meal_confirm" };
  if (text === "meal_edit") return { kind: "meal_edit" };
  if (text === "meal_cancel") return { kind: "meal_cancel" };
  if (text.startsWith("meal_pick:")) {
    const patientId = text.slice("meal_pick:".length).trim();
    if (UUID_RE.test(patientId)) return { kind: "meal_pick", patientId };
  }
  return null;
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function mapInteractiveReplyToText(
  replyId: string | undefined
): string | undefined {
  if (!replyId) return undefined;
  // Only the non-deterministic ids reach the LLM. Everything else is handled
  // by deterministic prefixes earlier in handleMessage().
  if (replyId.startsWith("get_doc:")) {
    const id = replyId.split(":")[1];
    return `I'd like to get the documents for booking ${id}.`;
  }
  if (replyId.startsWith("mute_clinic:")) {
    const id = replyId.split(":")[1];
    return `I want to mute reminders for clinic ${id}.`;
  }
  return undefined;
}

function parseIndexedReply(replyId: string, prefix: string): number | null {
  if (!replyId.startsWith(prefix)) return null;
  const index = Number(replyId.replace(prefix, ""));
  if (!Number.isInteger(index) || index <= 0) return null;
  return index;
}

function ymdLocal(daysFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function humanDay(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function parseUserDate(text: string): string | null {
  const t = text.trim();
  // Strict YYYY-MM-DD / YYYY/MM/DD with possibly single-digit M or D.
  const m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(t);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  // Permissive fallback: let JS parse natural language ("May 7 2026").
  const ts = Date.parse(t);
  if (Number.isFinite(ts)) {
    const dt = new Date(ts);
    if (!Number.isNaN(dt.getTime())) {
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    }
  }
  return null;
}

function buildDatePickerPlan(): InteractivePlan {
  const today = ymdLocal(0);
  const tomorrow = ymdLocal(1);
  const dayAfter = ymdLocal(2);
  return {
    body: "Which day works for you?",
    options: [
      { id: `date_select_${today}`, title: "Today", description: humanDay(today) },
      { id: `date_select_${tomorrow}`, title: "Tomorrow", description: humanDay(tomorrow) },
      { id: `date_select_${dayAfter}`, title: humanDay(dayAfter).split(",")[0], description: humanDay(dayAfter) },
      { id: "date_select_other", title: "Other date", description: "Type a date like 2026-05-15" },
    ],
  };
}

type Period = "morning" | "afternoon" | "evening";
const PERIOD_LABELS: Record<Period, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
};

function timeStrToMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function bucketSlotsByPeriod(slots: string[]): Record<Period, string[]> {
  const out: Record<Period, string[]> = { morning: [], afternoon: [], evening: [] };
  for (const t of slots) {
    const m = timeStrToMin(t);
    if (m < 12 * 60) out.morning.push(t);
    else if (m < 17 * 60) out.afternoon.push(t);
    else out.evening.push(t);
  }
  return out;
}

const TIME_SELECT_OTHER: InteractiveOption = {
  id: "time_select_other",
  title: "Other time",
  description: "Type your preferred HH:mm",
};

function buildPeriodPickerPlan(date: string, slots: string[]): InteractivePlan {
  const buckets = bucketSlotsByPeriod(slots);
  const options: InteractiveOption[] = [];
  for (const p of ["morning", "afternoon", "evening"] as const) {
    if (buckets[p].length > 0) {
      const range = `${buckets[p][0]}–${buckets[p][buckets[p].length - 1]}`;
      options.push({
        id: `period_select_${p}`,
        title: PERIOD_LABELS[p],
        description: `${buckets[p].length} slot${buckets[p].length === 1 ? "" : "s"} · ${range}`,
      });
    }
  }
  options.push(TIME_SELECT_OTHER);
  return { body: `When would you like to come on ${humanDay(date)}?`, options };
}

function buildTimeListPlan(
  date: string,
  slots: string[],
  periodLabel?: string
): InteractivePlan {
  // WhatsApp lists cap at 10 rows. Reserve the last for "Other time".
  const visible = slots.slice(0, 9);
  const options: InteractiveOption[] = visible.map((t) => ({
    id: `time_select_${t.replace(":", "")}`,
    title: t,
  }));
  options.push(TIME_SELECT_OTHER);
  return {
    body: periodLabel
      ? `${periodLabel} times on ${humanDay(date)}:`
      : `Here's what's open on ${humanDay(date)}:`,
    options,
  };
}

function buildInteractivePlanFromToolResults(
  toolResults: any[] | undefined,
  state: ThreadState
): InteractivePlan | undefined {
  if (!toolResults?.length) return undefined;

  for (let i = toolResults.length - 1; i >= 0; i--) {
    const raw = toolResults[i] ?? {};
    const toolName = String(raw.toolName ?? raw.tool ?? raw.name ?? "");
    const data = parseJsonSafe(raw.result ?? raw.output ?? raw.toolResult ?? raw.value);
    if (!data || typeof data !== "object") continue;

    if (
      toolName === "start_document_access" &&
      data.needsPatientPick === true &&
      Array.isArray(data.patients)
    ) {
      const options = data.patients
        .slice(0, 10)
        .map((p: any) => ({
          id: `patient_select_${Number(p.index)}`,
          title: clip(String(p.name ?? `Patient ${p.index}`), 24),
          description: p.ic ? `IC ending ${String(p.ic)}` : undefined,
        }));
      if (options.length > 0) {
        return { body: PLAN_BODY.patient, options };
      }
    }

    if (
      toolName === "search_services" &&
      data.clarificationNeeded === true &&
      Array.isArray(data.topServiceCandidates) &&
      data.topServiceCandidates.length > 0
    ) {
      const options = data.topServiceCandidates
        .slice(0, 3)
        .map((s: any, i: number) => ({
          id: `clarify_service_${encodeURIComponent(String(s.name ?? `Service ${i + 1}`))}`,
          title: clip(String(s.name ?? `Service ${i + 1}`), 24),
        }));
      if (options.length > 0) {
        return { body: PLAN_BODY.serviceClarify, options };
      }
    }

    if (
      (toolName === "search_services" || toolName === "search_services_near_me") &&
      data.found === true &&
      Array.isArray(data.clinics) &&
      !state.activeClinicId
    ) {
      // WhatsApp list rows max out at 10 entries (across all sections),
      // so when nearMeOption is true we cap data clinics to 9 to leave room
      // for the synthetic "Near me" row.
      const cap = data.nearMeOption === true ? 9 : 10;
      const options = data.clinics
        .slice(0, cap)
        .map((c: any) => ({
          id: `clinic_select_${Number(c.index)}`,
          title: clip(String(c.name ?? `Clinic ${c.index}`), 24),
          description:
            typeof c.distanceKm === "number"
              ? clip(`${c.distanceKm.toFixed(1)} km · ${String(c.address ?? "")}`, 72)
              : c.address
                ? clip(String(c.address), 72)
                : undefined,
        }));
      if (data.nearMeOption === true) {
        options.push({
          id: "NEAR_ME",
          title: "📍 Near me",
          description: "Sort clinics by distance from you",
        });
      }
      if (options.length > 0) {
        return { body: PLAN_BODY.clinic, options };
      }
    }

    if (Array.isArray((data as any).services) && !state.activeServiceId) {
      const options = data.services
        .slice(0, 10)
        .map((s: any) => ({
          id: `service_select_${Number(s.index)}`,
          title: clip(String(s.name ?? `Service ${s.index}`), 24),
          description: s.duration ? clip(String(s.duration), 72) : undefined,
        }));
      if (options.length > 0) {
        return { body: PLAN_BODY.service, options };
      }
    }

    if (
      toolName === "select_service" &&
      data.needsMethodSelection === true &&
      Array.isArray(data.methods) &&
      !state.activeMethodId
    ) {
      const options = data.methods
        .slice(0, 10)
        .map((m: any) => ({
          id: `method_select_${Number(m.index)}`,
          title: clip(String(m.name ?? `Method ${m.index}`), 24),
          description: m.requiresAddress ? "Address required" : m.requiresTime ? "Time required" : undefined,
        }));
      if (options.length > 0) {
        return { body: PLAN_BODY.method, options };
      }
    }

    if (
      toolName === "get_clinic_doctors" &&
      data.found === true &&
      !data.autoSelected &&
      Array.isArray(data.doctors) &&
      !state.activeDoctorId
    ) {
      const options = data.doctors
        .slice(0, 10)
        .map((d: any) => ({
          id: `doctor_select_${Number(d.index)}`,
          title: clip(String(d.name ?? `Doctor ${d.index}`), 24),
        }));
      if (options.length > 0) {
        return { body: PLAN_BODY.doctor, options };
      }
    }
  }

  return undefined;
}

function buildInteractivePlanFromState(state: ThreadState): InteractivePlan | undefined {
  // Patient picker intentionally omitted — only document retrieval asks for it,
  // and that flow is driven by the LLM (select_patient tool), not state-based fallback.

  if (!state.activeClinicId && (state.clinicOptions?.length ?? 0) > 1) {
    return {
      body: PLAN_BODY.clinic,
      options: (state.clinicOptions ?? []).slice(0, 10).map((c, i) => ({
        id: `clinic_select_${i + 1}`,
        title: clip(String(c.clinicName ?? `Clinic ${i + 1}`), 24),
        description: c.clinicAddress ? clip(String(c.clinicAddress), 72) : undefined,
      })),
    };
  }

  if (!state.activeServiceId && (state.serviceOptions?.length ?? 0) >= 1) {
    return {
      body: PLAN_BODY.service,
      options: (state.serviceOptions ?? []).slice(0, 10).map((s, i) => ({
        id: `service_select_${i + 1}`,
        title: clip(String(s.serviceName ?? `Service ${i + 1}`), 24),
      })),
    };
  }

  if (state.activeServiceId && !state.activeMethodId) {
    const svc = (state.serviceOptions ?? []).find((s) => s.serviceId === state.activeServiceId);
    if (svc && svc.methods.length > 1) {
      return {
        body: PLAN_BODY.method,
        options: svc.methods.slice(0, 10).map((m, i) => ({
          id: `method_select_${i + 1}`,
          title: clip(String(m.methodName ?? `Method ${i + 1}`), 24),
          description: m.requiresAddress ? "Address required" : m.requiresTime ? "Time required" : undefined,
        })),
      };
    }
  }

  if (!state.activeDoctorId && (state.doctorOptions?.length ?? 0) >= 1) {
    return {
      body: PLAN_BODY.doctor,
      options: (state.doctorOptions ?? []).slice(0, 10).map((d, i) => ({
        id: `doctor_select_${i + 1}`,
        title: clip(String(d.name ?? `Doctor ${i + 1}`), 24),
      })),
    };
  }

  return undefined;
}

function stripNumberedList(text: string): string {
  // Drop lines that look like the LLM enumerated the same options the
  // interactive list will already display ("1. Foo", "2) Bar", "- Baz"),
  // and drop the "reply with the number" instruction since the list
  // already provides tappable buttons.
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      kept.push(line);
      continue;
    }
    if (/^(\d+[.)]\s|[-•*]\s)/.test(trimmed)) continue;

    // Strip sentences asking the user to reply with a number / index /
    // option. Match "reply with N", "please pick a number", "tap option",
    // "select 1 or 2", "respond with the number", "type the number", etc.
    const cleaned = trimmed.replace(
      /\(?\s*(please\s+)?(reply|respond|type|enter|send|tap|pick|choose|select|provide|share|tell|let me know)[^.?!]*\b(number|index|option|digit|1\s*or\s*2|1\/2|the (clinic|service|method|doctor|patient))[^.?!]*[.?!]?\s*\)?/gi,
      ""
    ).trim();

    if (cleaned) kept.push(cleaned);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function sendInteractivePlan(
  phone: string,
  plan: InteractivePlan,
  bodyOverride?: string
): Promise<boolean> {
  const rawBody = bodyOverride?.trim() ? stripNumberedList(bodyOverride) : plan.body;
  const body = clip(rawBody || plan.body, 900);
  return sendListMessage(phone, body, "Pick one", [
    {
      title: "Options",
      rows: plan.options.slice(0, 10).map((o) => ({
        id: o.id,
        title: clip(o.title, 24),
        description: o.description ? clip(o.description, 72) : undefined,
      })),
    },
  ]);
}

async function postBookingConfirmCard(thread: any, state: ThreadState): Promise<void> {
  const staged = state.pendingBooking;
  if (!staged?.date) return;
  const svc = (state.serviceOptions ?? []).find((s) => s.serviceId === state.activeServiceId);
  const meth = svc?.methods.find((mm) => mm.methodId === state.activeMethodId);
  const clinicOpt = (state.clinicOptions ?? []).find((c) => c.clinicId === state.activeClinicId);
  const doctor = (state.doctorOptions ?? []).find((d) => d.doctorId === state.activeDoctorId);
  const summary = [
    "Here are your booking details — does this look right?",
    clinicOpt ? `Clinic: ${clinicOpt.clinicName}` : null,
    svc ? `Service: ${svc.serviceName}${meth?.methodName ? ` (${meth.methodName})` : ""}` : null,
    doctor ? `Doctor: ${doctor.name}` : null,
    `Date: ${humanDay(staged.date)}`,
    staged.time ? `Time: ${staged.time}` : null,
    staged.address ? `Address: ${staged.address}` : null,
    staged.reminderRemark ? `Note: ${staged.reminderRemark}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const sent = await sendReplyButtons(extractPhone(thread), summary, [
    { id: "booking_confirm_yes", title: "Yes, confirm" },
    { id: "booking_confirm_no", title: "Change details" },
  ]);
  if (!sent) await thread.post(summary);
}

export interface FakeThreadMessage {
  id: string;
  metadata: { dateSent: Date };
  text: string;
  author: { isMe: boolean; userName: string };
  attachments: any[];
  links: any[];
  raw?: any;
}

export interface FakeThread {
  id: string;
  state: Promise<ThreadState | null>;
  setState: (s: ThreadState) => Promise<void>;
  post: (text: string) => Promise<void>;
  startTyping?: () => Promise<void>;
  subscribe: () => Promise<void>;
  allMessages: AsyncIterable<FakeThreadMessage>;
  posted: string[];
  history: FakeThreadMessage[];
  _state: ThreadState | null;
}

export function createFakeThread(phone: string): FakeThread {
  const id = `whatsapp:test-phone-id:${phone}`;
  const history: FakeThreadMessage[] = [];
  const posted: string[] = [];
  const thread: FakeThread = {
    id,
    posted,
    history,
    _state: null,
    get state() {
      return Promise.resolve(this._state);
    },
    setState(s) {
      this._state = s;
      return Promise.resolve();
    },
    async post(text) {
      posted.push(text);
      history.push({
        id: `assistant-${history.length + 1}`,
        metadata: { dateSent: new Date() },
        text,
        author: { isMe: true, userName: "anyhealth-bot" },
        attachments: [],
        links: [],
      });
    },
    async startTyping() { },
    async subscribe() { },
    get allMessages() {
      const snapshot = [...history];
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of snapshot) yield m;
        },
      };
    },
  };
  return thread;
}

export async function deliverUserText(thread: FakeThread, text: string): Promise<void> {
  thread.history.push({
    id: `user-${thread.history.length + 1}`,
    metadata: { dateSent: new Date() },
    text,
    author: { isMe: false, userName: "test-user" },
    attachments: [],
    links: [],
  });
  if (!thread._state) {
    await thread.setState({
      phone: extractPhone(thread),
      verified: false,
      verifyAttempts: 0,
    });
  }
  await handleMessage(thread, {
    id: `msg-${thread.history.length}`,
    type: "text",
    text: { body: text },
  });
}

export async function deliverInteractiveReply(
  thread: FakeThread,
  replyId: string,
  title?: string
): Promise<void> {
  await handleMessage(thread, {
    id: `action-${thread.history.length + 1}`,
    interactive: { list_reply: { id: replyId, title: title ?? replyId } },
  });
}

export async function handleMessage(thread: any, message: any) {
  const _msgKind = message?.interactive
    ? `interactive:${message.interactive?.list_reply?.id ?? message.interactive?.button_reply?.id ?? "?"}`
    : message?.location
    ? "location"
    : message?.text?.body
    ? `text:"${clip(String(message.text.body), 80)}"`
    : "other";
  console.log(`[BOT] handleMessage thread=${thread.id} kind=${_msgKind}`);

  await thread.startTyping?.();

  const state: ThreadState = (await thread.state) ?? {
    phone: extractPhone(thread),
    verified: false,
    verifyAttempts: 0,
  };

  if (!state.phone) {
    state.phone = extractPhone(thread);
  }

  console.log(
    `[BOT] state user=${state.userId ? "y" : "n"} pat=${state.activePatientId ? "y" : "n"} ` +
    `cli=${state.activeClinicId ? "y" : "n"} svc=${state.activeServiceId ? "y" : "n"} ` +
    `mtd=${state.activeMethodId ? "y" : "n"} doc=${state.activeDoctorId ? "y" : "n"} ` +
    `pendingType=${state.pendingSelectionType ?? "-"} pendingQuery="${state.pendingSelectionQuery ?? "-"}"`
  );

  async function updateState(partial: Partial<ThreadState>) {
    Object.assign(state, partial);
    await thread.setState(state);
  }

  const tools = createTools(state, updateState);
  const sessionGapMs =
    Number(process.env.SESSION_GAP_HOURS || "2") * 60 * 60 * 1000;

  // Collect all messages, then find the session boundary (last gap > threshold)
  const allMessages = [];
  for await (const msg of thread.allMessages) {
    allMessages.push(msg);
  }

  let sessionStart = 0;
  for (let i = allMessages.length - 1; i > 0; i--) {
    const currMs = new Date(allMessages[i].metadata?.dateSent ?? 0).getTime();
    const prevMs = new Date(allMessages[i - 1].metadata?.dateSent ?? 0).getTime();
    if (currMs - prevMs >= sessionGapMs) {
      sessionStart = i;
      break;
    }
  }

  let activeMessage = message;
  let deepLinkApplied = false;

  const incomingMediaId = extractImageMediaId(activeMessage);
  console.log("[MEAL] image fast-path check", {
    messageId: activeMessage?.id,
    incomingMediaId: incomingMediaId ?? null,
  });
  if (incomingMediaId) {
    try {
      const phone = state.phone || extractPhone(thread);
      console.log("[MEAL] downloading media", { mediaId: incomingMediaId, phone });
      const media = await downloadWhatsAppMedia(incomingMediaId);
      console.log("[MEAL] media downloaded", {
        mediaId: incomingMediaId,
        contentType: media.contentType,
        bytes: media.buffer.length,
      });
      const uploaded = await uploadMealPhoto({
        phone,
        bytes: bufferToArrayBuffer(media.buffer),
        mimeType: media.contentType,
      });
      console.log("[MEAL] photo uploaded", {
        storagePath: uploaded.storagePath,
        signedUrlPresent: Boolean(uploaded.signedUrl),
      });

      const raw = await (tools as any).analyze_food_photo.execute({
        imageUrl: uploaded.signedUrl,
        storagePath: uploaded.storagePath,
        localeHint: "MY",
      });
      const data = parseJsonSafe(raw);
      console.log("[MEAL] vision result", {
        is_food: data?.is_food,
        itemCount: Array.isArray(data?.items) ? data.items.length : 0,
        visionModel: data?.visionModel,
        message: data?.message,
      });
      if (!data?.is_food) {
        await thread.post(
          typeof data?.message === "string"
            ? data.message
            : "That image does not look like food. Please send a clear meal photo."
        );
        return;
      }

      const totals = data?.totals ?? {};
      const summary = [
        "I identified these items from your photo:",
        ...(Array.isArray(data?.items)
          ? data.items.slice(0, 8).map((i: any) => `- ${i.name} (${i.portion})`)
          : []),
        "",
        `Estimated total: ${Number(totals.kcal ?? 0).toFixed(0)} kcal | P ${Number(totals.protein_g ?? 0).toFixed(1)}g | C ${Number(totals.carb_g ?? 0).toFixed(1)}g | F ${Number(totals.fat_g ?? 0).toFixed(1)}g`,
        "Confirm to log this meal?",
      ].join("\n");

      const sent = await sendReplyButtons(phone, summary, [
        { id: "meal_confirm", title: "Confirm" },
        { id: "meal_edit", title: "Edit" },
        { id: "meal_cancel", title: "Cancel" },
      ]);
      if (!sent) await thread.post(summary);
      return;
    } catch (err) {
      console.error("[MEAL] image intake failed:", err);
      await thread.post("I couldn't process that photo right now. Please try again.");
      return;
    }
  }

  // --- Deep-link routing ---
  {
    const tokenText: string = String(activeMessage?.text?.body ?? activeMessage?.text ?? "");
    const deepLink = parseDeepLinkToken(tokenText);
    if (deepLink.kind === "match") {
      const clinic = await resolveClinicBySlug(deepLink.slug);
      if (clinic) {
        const switchedFrom = state.activeClinicId;
        applyDeepLink(state, clinic);
        deepLinkApplied = true;
        await thread.setState(state);
        console.log(
          `[DEEP-LINK] event=deep_link slug=${deepLink.slug} resolved=true clinicId=${clinic.id} switchedFrom=${switchedFrom ?? "none"}`,
        );
        await sendWelcome(thread, clinic, state.language);
        if (!deepLink.residual) {
          return; // turn ends; LLM not invoked
        }
        // Forward residual into the LLM agent loop.
        activeMessage = { ...activeMessage, text: deepLink.residual };
      } else {
        state.unknownSlugThisTurn = true;
        await thread.setState(state);
        console.log(`[DEEP-LINK] event=deep_link slug=${deepLink.slug} resolved=false`);
        if (deepLink.residual) {
          activeMessage = { ...activeMessage, text: deepLink.residual };
        }
        // Fall through to LLM with one-shot prompt flag set.
      }
    } else {
      // Legacy token didn't match — try the friendly prefill, but only when
      // no booking is in progress. Mid-conversation, an organic message that
      // happens to start with "Hi! I'd like to book at …" should NOT reset state.
      const isFreshBooking =
        !state.activeClinicId &&
        !state.activeServiceId &&
        !state.activeMethodId &&
        !state.activeDoctorId &&
        !state.lastSearchQuery;
      if (isFreshBooking) {
        const friendly = parseFriendlyPrefill(tokenText);
        if (friendly.kind === "match") {
          const clinic = await resolveClinicByName(friendly.clinicName);
          if (clinic) {
            applyDeepLink(state, clinic);
            deepLinkApplied = true;
            await thread.setState(state);
            console.log(
              `[DEEP-LINK] event=friendly_prefill name="${friendly.clinicName}" resolved=true clinicId=${clinic.id}`,
            );
            await sendWelcome(thread, clinic, state.language);
            return; // turn ends; LLM not invoked
          }
          // Unresolved friendly prefill: do NOT set unknownSlugThisTurn —
          // the user's intent is plain English, just let the LLM handle it.
          console.log(
            `[DEEP-LINK] event=friendly_prefill name="${friendly.clinicName}" resolved=false`,
          );
        }
      }
    }
  }
  // --- end deep-link routing ---

  const incomingText: string = String(activeMessage?.text?.body ?? activeMessage?.text ?? "");
  const phone = state.phone || extractPhone(thread);
  const interactiveReplyId = extractInteractiveReplyId(activeMessage);
  const interactiveReplyTitle = extractInteractiveReplyTitle(activeMessage);
  const extraSystemNotes: string[] = [];

  async function handleMealAction(action: MealAction): Promise<void> {
    if (action.kind === "meal_confirm") {
      if ((state.patients?.length ?? 0) > 1 && !state.activePatientId) {
        const options = (state.patients ?? []).slice(0, 10).map((p) => ({
          id: `meal_pick:${p.id}`,
          title: clip(p.name, 24),
          description: p.ic ? `IC ending ${p.ic.slice(-4)}` : undefined,
        }));
        const sent = await sendListMessage(phone, "Who is this meal for?", "Pick patient", [
          { title: "Patients", rows: options },
        ]);
        await updateState({ awaitingMealPatientPick: true });
        if (!sent) await thread.post("Who is this meal for? Please tap a patient.");
        return;
      }
      const raw = await (tools as any).log_meal.execute({});
      const data = parseJsonSafe(raw);
      await thread.post(
        data?.success
          ? "Meal logged successfully."
          : String(data?.error ?? "I couldn't log this meal. Please try again.")
      );
      return;
    }

    if (action.kind === "meal_pick") {
      await updateState({ activePatientId: action.patientId, awaitingMealPatientPick: false });
      const raw = await (tools as any).log_meal.execute({});
      const data = parseJsonSafe(raw);
      await thread.post(
        data?.success
          ? "Meal logged successfully."
          : String(data?.error ?? "I couldn't log this meal. Please try again.")
      );
      return;
    }

    if (action.kind === "meal_edit") {
      const nextCount = (state.mealEditRoundCount ?? 0) + 1;
      if (nextCount > 3) {
        await updateState({ awaitingMealEditText: false, mealEditRoundCount: 0 });
        await thread.post("You've reached the edit limit (3). Please send a new meal photo.");
        return;
      }
      await updateState({ awaitingMealEditText: true, mealEditRoundCount: nextCount });
      await thread.post("Please tell me what to correct in the meal items or portions.");
      return;
    }

    await updateState({
      pendingMealAnalysis: undefined,
      awaitingMealEditText: false,
      mealEditRoundCount: 0,
      awaitingMealPatientPick: false,
    });
    await thread.post("Meal logging cancelled.");
    return;
  }

  const mealAction =
    parseMealActionFromText(incomingText.trim()) ??
    parseMealActionFromText(interactiveReplyId ?? "");
  if (mealAction) {
    await handleMealAction(mealAction);
    return;
  }

  // --- Button Routing ---
  const buttonAction = parseButtonPayload(incomingText);
  if (buttonAction) {
    const result = await handleButtonAction(buttonAction, {
      phone,
      thread: state,
      updateThread: updateState,
      replyText: async (t) => {
        await thread.post(t);
      },
    });
    if (result.handled) {
      return; // Turn ends
    }
    if (result.hint) {
      extraSystemNotes.push(result.hint);
    }
  }

  const isInteractiveClick = !!extractInteractiveReplyId(activeMessage);

  // Date-await: previous turn was "Other date" — parse this text as YYYY-MM-DD
  // (or a natural-language date) and route through the time picker.
  if (state.awaitingDate && !isInteractiveClick && incomingText.trim().length > 0) {
    const parsed = parseUserDate(incomingText);
    if (!parsed) {
      console.log(`[DET] awaitingDate parse_fail text="${clip(incomingText, 60)}"`);
      await thread.post("That doesn't look like a date. Please type YYYY-MM-DD, e.g. 2026-05-15.");
      return;
    }
    // Reject past dates.
    const todayYmd = ymdLocal(0);
    if (parsed < todayYmd) {
      console.log(`[DET] awaitingDate past date=${parsed}`);
      await thread.post(`That date (${parsed}) is in the past. Please pick a future date.`);
      await updateState({ awaitingDate: undefined });
      await sendDatePicker();
      return;
    }
    console.log(`[DET] awaitingDate parsed date=${parsed}`);
    await updateState({ pendingBookingDate: parsed, awaitingDate: undefined, awaitingTime: undefined });
    await presentTimesForDate(parsed);
    return;
  }

  // Time-await: previous turn was "Other time" — parse this text as HH:mm
  // and run the same processSelectedTime path. Defined inline because the
  // helpers below close over `state`/`tools`. Skip on interactive clicks.
  if (state.awaitingTime && !isInteractiveClick && incomingText.trim().length > 0) {
    const m = /(\d{1,2}):(\d{2})/.exec(incomingText);
    if (!m) {
      console.log(`[DET] awaitingTime parse_fail text="${clip(incomingText, 60)}"`);
      await thread.post("That doesn't look like a time. Please type HH:mm, e.g. 14:30.");
      return;
    }
    const h = Math.max(0, Math.min(23, Number(m[1])));
    const mn = Math.max(0, Math.min(59, Number(m[2])));
    const time = `${String(h).padStart(2, "0")}:${String(mn).padStart(2, "0")}`;
    console.log(`[DET] awaitingTime parsed time=${time}`);
    // processSelectedTime is defined later in the function but hoisted.
    await processSelectedTime(time);
    return;
  }

  // Address-await: previous turn picked a time on a method that requires an
  // address. Treat this incoming text as the address, restage, and prompt
  // for confirmation. Skip on interactive clicks (those have their own flow).
  if (
    state.awaitingAddress &&
    !isInteractiveClick &&
    state.pendingBooking?.date &&
    state.pendingBooking?.time &&
    incomingText.trim().length > 0
  ) {
    const addr = incomingText.trim();
    console.log(`[DET] address_capture len=${addr.length}`);
    const staged = state.pendingBooking;
    const raw = await (tools as any).create_booking.execute({
      date: staged.date,
      time: staged.time,
      address: addr,
      isNewPatient: staged.isNewPatient,
      bookingType: staged.bookingType ?? "consultation",
      confirmed: false,
    });
    const data = parseJsonSafe(raw);
    if (data?.error) {
      await thread.post(typeof data.error === "string" ? data.error : "Couldn't stage that address. Please try again.");
      return;
    }
    await updateState({ awaitingAddress: undefined });
    await postBookingConfirmCard(thread, state);
    return;
  }

  if (state.awaitingRemark && !isInteractiveClick) {
    const note = String(activeMessage?.text?.body ?? activeMessage?.text ?? "").trim();
    if (!note) {
      await thread.post("Please type the note text.");
      return;
    }
    const updatedPending = state.pendingBooking
      ? { ...state.pendingBooking, reminderRemark: note }
      : undefined;
    await updateState({
      awaitingRemark: undefined,
      pendingBooking: updatedPending,
    });
    if (updatedPending?.date && updatedPending?.time) {
      await postBookingConfirmCard(thread, { ...state, awaitingRemark: undefined, pendingBooking: updatedPending });
    } else {
      await thread.post("Note saved.");
    }
    return;
  }

  if (
    state.awaitingMealEditText &&
    !isInteractiveClick &&
    incomingText.trim().length > 0 &&
    state.pendingMealAnalysis?.imageUrl
  ) {
    const raw = await (tools as any).analyze_food_photo.execute({
      imageUrl: state.pendingMealAnalysis.imageUrl,
      storagePath: state.pendingMealAnalysis.storagePath,
      localeHint: "MY",
      editHint: incomingText.trim(),
    });
    const data = parseJsonSafe(raw);
    if (!data?.is_food) {
      await updateState({ awaitingMealEditText: false });
      await thread.post("I couldn't re-analyze that as a meal. Please send a new food photo.");
      return;
    }
    await updateState({ awaitingMealEditText: false });
    const totals = data?.totals ?? {};
    const summary = [
      "Updated meal estimate:",
      ...(Array.isArray(data?.items)
        ? data.items.slice(0, 8).map((i: any) => `- ${i.name} (${i.portion})`)
        : []),
      "",
      `Estimated total: ${Number(totals.kcal ?? 0).toFixed(0)} kcal | P ${Number(totals.protein_g ?? 0).toFixed(1)}g | C ${Number(totals.carb_g ?? 0).toFixed(1)}g | F ${Number(totals.fat_g ?? 0).toFixed(1)}g`,
      "Confirm to log this meal?",
    ].join("\n");
    const sent = await sendReplyButtons(extractPhone(thread), summary, [
      { id: "meal_confirm", title: "Confirm" },
      { id: "meal_edit", title: "Edit" },
      { id: "meal_cancel", title: "Cancel" },
    ]);
    if (!sent) await thread.post(summary);
    return;
  }

  const incomingLocation = extractLocation(activeMessage);
  if (incomingLocation) {
    await updateState({
      lastLocation: {
        lat: incomingLocation.lat,
        lng: incomingLocation.lng,
        capturedAt: Date.now(),
      },
    });
    console.log(
      `[BOT] Captured location ${incomingLocation.lat},${incomingLocation.lng}`
    );
  }
  if (interactiveReplyId) {
    console.log(`[DET] interactive id=${interactiveReplyId} title="${clip(String(interactiveReplyTitle ?? ""), 40)}"`);
    if (interactiveReplyId === "booking_confirm_yes") {
      const staged = state.pendingBooking;
      if (!staged) {
        console.log(`[DET] booking_confirm_yes no_pending`);
        await thread.post("I don't have your booking details staged anymore. Please share the date and time again.");
        return;
      }
      const raw = await (tools as any).create_booking.execute({
        ...staged,
        confirmed: true,
      });
      const data = parseJsonSafe(raw);
      console.log(`[DET] booking_confirm_yes success=${!!data?.success} bookingId=${data?.bookingId ?? "-"}`);
      await thread.post(
        data?.success
          ? String(data.message ?? "Booking created successfully.")
          : String(data?.error ?? "I couldn't complete the booking. Please try again.")
      );
      return;
    }
    if (interactiveReplyId === "booking_confirm_no") {
      console.log(`[DET] booking_confirm_no → edit picker`);
      const sent = await sendInteractivePlan(extractPhone(thread), {
        body: "What would you like to change?",
        options: [
          { id: "edit_service", title: "Service" },
          { id: "edit_date", title: "Date" },
          { id: "edit_time", title: "Time" },
          { id: "edit_method", title: "Method" },
          { id: "edit_note", title: "Add a note" },
          { id: "cancel_booking", title: "Cancel booking" },
        ],
      });
      if (!sent) {
        await thread.post(
          "What would you like to change? Reply with: service, date, time, method, note, or cancel."
        );
      }
      return;
    }
    if (interactiveReplyId === "NEAR_ME" && !state.lastLocation) {
      const body = "To find clinics near you, please share your location.";
      const sent = await sendLocationRequest(extractPhone(thread), body);
      console.log(`[DET] near_me request_location sent=${sent}`);
      if (!sent) {
        await thread.post(body);
      }
      return;
    }
    if (interactiveReplyId === "NEAR_ME" && state.lastLocation) {
      const raw = await (tools as any).search_services_near_me.execute({});
      const plan = buildInteractivePlanFromToolResults(
        [{ toolName: "search_services_near_me", result: raw }],
        state
      );
      const sent = plan ? await sendInteractivePlan(extractPhone(thread), plan) : false;
      console.log(`[DET] near_me search plan="${plan?.body ?? "-"}" sent=${sent}`);
      if (!sent) {
        const data = parseJsonSafe(raw);
        await thread.post(String(data?.message ?? "I found nearby clinics. Please choose one."));
      }
      return;
    }
    if (interactiveReplyId.startsWith("patient_select_")) {
      const index = parseIndexedReply(interactiveReplyId, "patient_select_");
      if (index) {
        const wasAwaitingDocVerify = state.awaitingDocVerification === true;
        const raw = await (tools as any).select_patient.execute({ index });
        const data = parseJsonSafe(raw);
        console.log(`[DET] patient_select idx=${index} success=${!!data?.success} name="${data?.patientName ?? "-"}" docFlow=${wasAwaitingDocVerify}`);
        if (data?.success && wasAwaitingDocVerify) {
          await updateState({ awaitingDocVerification: undefined });
          await thread.post(
            `Noted — acting on behalf of ${data.patientName ?? "the selected patient"}.\n\n` +
            `For security, please share the patient's full name and IC number to verify identity.`
          );
        } else {
          await thread.post(
            data?.success
              ? `Noted. ${data.message ?? "Patient selected."}`
              : String(data?.error ?? "Invalid patient selection.")
          );
        }
        return;
      }
    }
    if (interactiveReplyId.startsWith("view_booking:")) {
      const id = interactiveReplyId.split(":")[1];
      const raw = await (tools as any).get_booking_details.execute({ bookingId: id });
      const data = parseJsonSafe(raw);
      console.log(`[DET] view_booking id=${id} hasSummary=${typeof data?.summary === "string"}`);
      await thread.post(
        typeof data?.summary === "string"
          ? data.summary
          : typeof data?.message === "string"
          ? data.message
          : "Here are your booking details."
      );
      return;
    }
  }

  // Deterministic interactive handlers to avoid LLM guesswork loops.
  if (interactiveReplyId?.startsWith("clarify_service_")) {
    const encoded = interactiveReplyId.replace("clarify_service_", "").trim();
    const picked = decodeURIComponent(encoded || interactiveReplyTitle || "").trim();
    if (picked) {
      const originalQuery = state.pendingSelectionQuery;
      const raw = await (tools as any).search_services.execute({ query: picked });
      const data = parseJsonSafe(raw);

      // No bookable services at the auto-picked clinic: recover by re-running
      // the original search so the user has alternatives to choose from.
      if (data?.resultType === "no_bookable_services") {
        console.log(`[DET] clarify_service no_bookable picked="${picked}"`);
        await updateState({
          activeClinicId: undefined,
          activeServiceId: undefined,
          activeMethodId: undefined,
          serviceOptions: undefined,
          pendingSelectionType: undefined,
          pendingSelectionQuery: undefined,
        });
        const msg = typeof data.message === "string"
          ? data.message
          : `"${picked}" isn't currently bookable. Here's what's available:`;
        if (originalQuery) {
          const recoverRaw = await (tools as any).search_services.execute({ query: originalQuery });
          const recoverPlan = buildInteractivePlanFromToolResults(
            [{ toolName: "search_services", result: recoverRaw }],
            state
          );
          if (recoverPlan) {
            // Fold the explanation into the list body so the user sees the
            // reason and the new options together — no separate text bubble
            // that looks like the bot already chose something.
            const sentRecover = await sendInteractivePlan(
              extractPhone(thread),
              recoverPlan,
              `${msg}\n\n${recoverPlan.body}`
            );
            if (sentRecover) return;
          }
        }
        await thread.post(msg);
        return;
      }

      // search_services may auto-select a single clinic and return
      // serviceOptions directly. If so, and the picked label matches one of
      // those services exactly, auto-select that service too — otherwise the
      // user gets re-prompted for the same service they just chose.
      const clarifiedLower = picked.trim().toLowerCase();
      const opts = state.serviceOptions ?? [];
      const matchIdx = opts.findIndex(
        (s) => s.serviceName.trim().toLowerCase() === clarifiedLower
      );
      if (state.activeClinicId && matchIdx >= 0) {
        console.log(
          `[GUARD] Auto-selecting service "${opts[matchIdx].serviceName}" (idx=${matchIdx + 1}) from clarify pick`
        );
        const svcRaw = await (tools as any).select_service.execute({ index: matchIdx + 1 });
        const handled = await handleSelectServiceResult(svcRaw, "clarify_service->service");
        await updateState({ pendingSelectionType: undefined, pendingSelectionQuery: undefined });
        if (handled) return;
      }

      const plan = buildInteractivePlanFromToolResults([{ toolName: "search_services", result: raw }], state);
      const sent = plan ? await sendInteractivePlan(extractPhone(thread), plan) : false;
      console.log(`[DET] clarify_service picked="${picked}" plan="${plan?.body ?? "-"}" sent=${sent}`);
      await updateState({
        pendingSelectionType: plan?.body === PLAN_BODY.clinic ? "clinic" : undefined,
        pendingSelectionQuery: plan?.body === PLAN_BODY.clinic ? picked : undefined,
      });
      if (!sent) {
        await thread.post(typeof data?.message === "string" ? data.message : "Got it — what would you like to do next?");
      }
      return;
    }
  }

  async function sendDatePicker(): Promise<void> {
    const plan = buildDatePickerPlan();
    const sent = await sendInteractivePlan(extractPhone(thread), plan);
    console.log(`[DET] sendDatePicker sent=${sent}`);
    if (!sent) {
      await thread.post("Which day works for you? (e.g. 2026-05-15)");
    }
  }

  async function sendNewPatientGate(): Promise<void> {
    const sent = await sendReplyButtons(
      extractPhone(thread),
      "First time at this clinic, or have you been here before?",
      [
        { id: "new_patient_yes", title: "New patient" },
        { id: "new_patient_no", title: "Existing patient" },
      ]
    );
    console.log(`[DET] sendNewPatientGate sent=${sent}`);
    if (!sent) {
      await thread.post("First time at this clinic, or have you been here before? Reply 'new' or 'existing'.");
    }
  }

  function clinicHasNewPatientLimit(): boolean {
    const clinicOpt = (state.clinicOptions ?? []).find((c) => c.clinicId === state.activeClinicId);
    return clinicOpt?.newPatientLimit !== null && clinicOpt?.newPatientLimit !== undefined;
  }

  /** Move from doctor stage to either new-patient gate or directly to date. */
  async function advanceToDateOrPatientGate(): Promise<void> {
    if (clinicHasNewPatientLimit() && state.pendingIsNewPatient === undefined) {
      await sendNewPatientGate();
      return;
    }
    await sendDatePicker();
  }

  // Helper: after a service is fully picked (incl. method), drive the rest of
  // the flow deterministically — show doctors if the clinic requires it,
  // otherwise jump to the new-patient gate / date picker.
  async function chainAfterServicePicked(): Promise<void> {
    const clinicOpt = (state.clinicOptions ?? []).find((c) => c.clinicId === state.activeClinicId);
    if (clinicOpt?.doctorSelection) {
      const docRaw = await (tools as any).get_clinic_doctors.execute({});
      const docData = parseJsonSafe(docRaw);
      const docPlan = buildInteractivePlanFromToolResults([{ toolName: "get_clinic_doctors", result: docRaw }], state);
      const docSent = docPlan ? await sendInteractivePlan(extractPhone(thread), docPlan) : false;
      console.log(`[DET] chain->doctors auto=${!!docData?.autoSelected} plan="${docPlan?.body ?? "-"}" sent=${docSent}`);
      if (docSent) return;
      if (docData?.autoSelected) {
        await thread.post(docData.message ?? "Doctor selected.");
        await advanceToDateOrPatientGate();
        return;
      }
      await thread.post(typeof docData?.message === "string" ? docData.message : "Doctor selection unavailable.");
      return;
    }
    await advanceToDateOrPatientGate();
  }

  // Helper: select_service was just called. Send method list if needed,
  // otherwise chain to doctor stage. Returns false only if select_service
  // returned an unexpected error shape — caller decides fallback message.
  async function handleSelectServiceResult(raw: unknown, ctx: string): Promise<boolean> {
    const data = parseJsonSafe(raw);
    const plan = buildInteractivePlanFromToolResults([{ toolName: "select_service", result: raw }], state);
    const sent = plan ? await sendInteractivePlan(extractPhone(thread), plan) : false;
    console.log(`[DET] ${ctx} needsMethod=${!!data?.needsMethodSelection} plan="${plan?.body ?? "-"}" sent=${sent}`);
    if (sent) return true;
    if (data?.needsMethodSelection === true) {
      await thread.post(PLAN_BODY.method);
      return true;
    }
    if (data?.success) {
      await chainAfterServicePicked();
      return true;
    }
    return false;
  }

  if (interactiveReplyId?.startsWith("clinic_select_")) {
    const index = parseIndexedReply(interactiveReplyId, "clinic_select_");
    if (index) {
      console.log(`[DET] clinic_select idx=${index} pendingType=${state.pendingSelectionType ?? "-"} pendingQuery="${state.pendingSelectionQuery ?? "-"}" lastSearch="${state.lastSearchQuery ?? "-"}"`);
      // Deterministic refresh: if we have a clarified pending query,
      // rebuild clinicOptions from that query before selecting clinic index.
      if (
        state.pendingSelectionType === "clinic" &&
        state.pendingSelectionQuery &&
        state.pendingSelectionQuery.trim().length > 0 &&
        state.lastSearchQuery !== state.pendingSelectionQuery
      ) {
        await (tools as any).search_services.execute({ query: state.pendingSelectionQuery });
        console.log(
          `[GUARD] Refreshed clinicOptions from pendingSelectionQuery="${state.pendingSelectionQuery}" before clinic select`
        );
      } else if ((!state.clinicOptions || state.clinicOptions.length === 0) && state.pendingSelectionQuery) {
        await (tools as any).search_services.execute({ query: state.pendingSelectionQuery });
        console.log(`[GUARD] Recovered clinicOptions via pendingSelectionQuery="${state.pendingSelectionQuery}"`);
      }
      const raw = await (tools as any).select_clinic.execute({ index });

      // Auto-select a service when:
      //   1. user picked a service name via clarify_service_ and it exact-
      //      matches a service at this clinic; OR
      //   2. only one service option remains.
      const clarified = state.pendingSelectionQuery?.trim().toLowerCase();
      const opts = state.serviceOptions ?? [];
      let matchIdx = clarified
        ? opts.findIndex((s) => s.serviceName.trim().toLowerCase() === clarified)
        : -1;
      if (matchIdx < 0 && opts.length === 1) matchIdx = 0;

      await updateState({ pendingSelectionType: undefined, pendingSelectionQuery: undefined });

      if (matchIdx >= 0) {
        console.log(
          `[GUARD] Auto-selecting service "${opts[matchIdx].serviceName}" (idx=${matchIdx + 1}) from ${clarified ? "clarified pick" : "single option"}`
        );
        const svcRaw = await (tools as any).select_service.execute({ index: matchIdx + 1 });
        const handled = await handleSelectServiceResult(svcRaw, "clinic_select->service");
        if (handled) return;
      }

      // Fall back to the regular service list / message.
      const plan = buildInteractivePlanFromToolResults([{ toolName: "select_clinic", result: raw }], state);
      const sent = plan ? await sendInteractivePlan(extractPhone(thread), plan) : false;
      console.log(`[DET] clinic_select done svcOpts=${state.serviceOptions?.length ?? 0} plan="${plan?.body ?? "-"}" sent=${sent}`);
      if (sent) return;
      const data = parseJsonSafe(raw);
      if (Array.isArray(data?.services) && data.services.length === 0) {
        await thread.post("Hmm, I couldn't find matching services at this clinic. Want to try another?");
      } else {
        await thread.post(PLAN_BODY.service);
      }
      return;
    }
  }

  if (interactiveReplyId?.startsWith("service_select_")) {
    const index = parseIndexedReply(interactiveReplyId, "service_select_");
    if (index) {
      const raw = await (tools as any).select_service.execute({ index });
      const handled = await handleSelectServiceResult(raw, `service_select idx=${index}`);
      if (handled) return;
      await thread.post("Got it — let me continue with your booking.");
      return;
    }
  }

  if (interactiveReplyId?.startsWith("method_select_")) {
    const methodIndex = parseIndexedReply(interactiveReplyId, "method_select_");
    if (methodIndex && state.activeServiceId) {
      const currentIdx = (state.serviceOptions ?? []).findIndex((s) => s.serviceId === state.activeServiceId);
      const serviceIndex = currentIdx >= 0 ? currentIdx + 1 : null;
      if (serviceIndex) {
        const raw = await (tools as any).select_service.execute({ index: serviceIndex, methodIndex });
        const handled = await handleSelectServiceResult(raw, `method_select methodIdx=${methodIndex}`);
        if (handled) return;
        await thread.post("Got it. What date and time would you like?");
        return;
      }
      console.log(`[DET] method_select skipped methodIdx=${methodIndex} no_active_service`);
    }
  }

  if (interactiveReplyId?.startsWith("doctor_select_")) {
    const index = parseIndexedReply(interactiveReplyId, "doctor_select_");
    if (index) {
      const raw = await (tools as any).select_doctor.execute({ index });
      const data = parseJsonSafe(raw);
      console.log(`[DET] doctor_select idx=${index} success=${!!data?.success} name="${data?.doctorName ?? "-"}"`);
      await thread.post(
        data?.success
          ? `Doctor selected: ${data.doctorName ?? "selected"}.`
          : "Doctor selected."
      );
      await advanceToDateOrPatientGate();
      return;
    }
  }

  if (interactiveReplyId === "new_patient_yes" || interactiveReplyId === "new_patient_no") {
    const isNew = interactiveReplyId === "new_patient_yes";
    console.log(`[DET] new_patient_gate isNew=${isNew}`);
    await updateState({ pendingIsNewPatient: isNew });
    await sendDatePicker();
    return;
  }

  if (interactiveReplyId === "date_select_other") {
    console.log(`[DET] date_select_other`);
    await updateState({ awaitingDate: true, awaitingTime: undefined });
    await thread.post("Sure — type the date you'd like, in YYYY-MM-DD format (e.g. 2026-05-15).");
    return;
  }

  // Helper: present time options for the given date — period buckets when
  // there are too many to fit, otherwise a flat list.
  async function presentTimesForDate(date: string): Promise<void> {
    const raw = await (tools as any).get_clinic_availability.execute({ date });
    const data = parseJsonSafe(raw);
    if (data?.error) {
      await thread.post(typeof data.error === "string" ? data.error : "Couldn't load clinic hours.");
      await sendDatePicker();
      return;
    }
    if (data?.open === false) {
      await thread.post(typeof data.message === "string" ? data.message : `Clinic is closed on ${date}.`);
      await sendDatePicker();
      return;
    }
    const slots: string[] = Array.isArray(data?.freeSlots) ? data.freeSlots : [];
    console.log(`[DET] presentTimesForDate date=${date} slots=${slots.length}`);
    if (slots.length === 0) {
      await thread.post(`No free time slots on ${humanDay(date)}. Please pick another date.`);
      await sendDatePicker();
      return;
    }
    // Up to 9 slots fit alongside an "Other time" row in one list.
    const plan = slots.length <= 9
      ? buildTimeListPlan(date, slots)
      : buildPeriodPickerPlan(date, slots);
    const sent = await sendInteractivePlan(extractPhone(thread), plan);
    if (!sent) {
      await thread.post(`Here's what's open on ${humanDay(date)}: ${slots.slice(0, 10).join(", ")}`);
    }
  }

  // Helper: finalise a time pick — covers both interactive `time_select_*`
  // and the typed-time fallback after `time_select_other`.
  async function processSelectedTime(time: string): Promise<void> {
    const date = state.pendingBookingDate;
    if (!date) {
      console.log(`[DET] processSelectedTime no_date time=${time}`);
      await thread.post("I lost track of the date — let's pick it again.");
      await sendDatePicker();
      return;
    }
    const svc = (state.serviceOptions ?? []).find((s) => s.serviceId === state.activeServiceId);
    const meth = svc?.methods.find((mm) => mm.methodId === state.activeMethodId);
    if (meth?.requiresAddress) {
      console.log(`[DET] processSelectedTime needs_address time=${time}`);
      await updateState({
        pendingBooking: {
          date,
          time,
          isNewPatient: state.pendingIsNewPatient,
          bookingType: "consultation",
        },
        awaitingAddress: true,
        awaitingTime: undefined,
      });
      await thread.post(
        `Got it — ${humanDay(date)} at ${time}. Please share the address for the visit.`
      );
      return;
    }

    const raw = await (tools as any).create_booking.execute({
      date,
      time,
      isNewPatient: state.pendingIsNewPatient,
      confirmed: false,
    });
    const data = parseJsonSafe(raw);
    console.log(`[DET] processSelectedTime->stage time=${time} needsConfirmation=${!!data?.needsConfirmation}`);
    await updateState({ awaitingTime: undefined });
    await postBookingConfirmCard(thread, state);
  }

  if (interactiveReplyId?.startsWith("date_select_")) {
    const date = interactiveReplyId.replace("date_select_", "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.log(`[DET] date_select bad-format id=${interactiveReplyId}`);
    } else {
      console.log(`[DET] date_select date=${date}`);
      await updateState({ pendingBookingDate: date, awaitingTime: undefined });
      await presentTimesForDate(date);
      return;
    }
  }

  if (interactiveReplyId?.startsWith("period_select_")) {
    const period = interactiveReplyId.replace("period_select_", "") as Period;
    const date = state.pendingBookingDate;
    if (!date || !["morning", "afternoon", "evening"].includes(period)) {
      console.log(`[DET] period_select invalid period=${period} date=${date ?? "-"}`);
      await sendDatePicker();
      return;
    }
    const raw = await (tools as any).get_clinic_availability.execute({ date });
    const data = parseJsonSafe(raw);
    const slots: string[] = Array.isArray(data?.freeSlots) ? data.freeSlots : [];
    const filtered = bucketSlotsByPeriod(slots)[period];
    console.log(`[DET] period_select period=${period} slots=${filtered.length}`);
    if (filtered.length === 0) {
      await thread.post(`No ${PERIOD_LABELS[period].toLowerCase()} slots on ${humanDay(date)}.`);
      await presentTimesForDate(date);
      return;
    }
    const plan = buildTimeListPlan(date, filtered, PERIOD_LABELS[period]);
    const sent = await sendInteractivePlan(extractPhone(thread), plan);
    if (!sent) {
      await thread.post(`${PERIOD_LABELS[period]} times: ${filtered.slice(0, 10).join(", ")}`);
    }
    return;
  }

  if (interactiveReplyId === "time_select_other") {
    console.log(`[DET] time_select_other`);
    await updateState({ awaitingTime: true });
    await thread.post("Please type your preferred time in HH:mm format (e.g. 14:30).");
    return;
  }

  if (interactiveReplyId?.startsWith("time_select_")) {
    const m = /^time_select_(\d{2})(\d{2})$/.exec(interactiveReplyId);
    if (m) {
      const time = `${m[1]}:${m[2]}`;
      await processSelectedTime(time);
      return;
    }
  }

  if (interactiveReplyId === "cancel_booking") {
    console.log(`[DET] cancel_booking`);
    await updateState({
      activeClinicId: undefined,
      activeServiceId: undefined,
      activeMethodId: undefined,
      activeDoctorId: undefined,
      clinicOptions: undefined,
      serviceOptions: undefined,
      doctorOptions: undefined,
      lastSearchQuery: undefined,
      pendingBooking: undefined,
      pendingBookingDate: undefined,
      pendingIsNewPatient: undefined,
      awaitingAddress: undefined,
      awaitingTime: undefined,
      awaitingDate: undefined,
      awaitingRemark: undefined,
      extractedIntent: undefined,
    });
    await thread.post("Booking cancelled. Let me know if you'd like to start a new one.");
    return;
  }

  if (interactiveReplyId === "edit_service") {
    console.log(`[DET] edit_service`);
    await updateState({
      activeServiceId: undefined,
      activeMethodId: undefined,
      pendingBookingDate: undefined,
      pendingBooking: undefined,
      awaitingAddress: undefined,
      awaitingTime: undefined,
      awaitingDate: undefined,
      extractedIntent: state.extractedIntent
        ? { ...state.extractedIntent, serviceKeyword: undefined, method: undefined, time: undefined, date: undefined }
        : undefined,
    });
    const services = state.serviceOptions ?? [];
    if (services.length === 0) {
      await thread.post("Which service would you like? Reply with the service name.");
      return;
    }
    const sent = await sendInteractivePlan(extractPhone(thread), {
      body: "Which service?",
      options: services.slice(0, 10).map((s, i) => ({
        id: `service_select_${i + 1}`,
        title: clip(s.serviceName, 24),
        description: s.durationMinutes ? `${s.durationMinutes} min` : undefined,
      })),
    });
    if (!sent) {
      await thread.post("Which service? Reply with the service name.");
    }
    return;
  }

  if (interactiveReplyId === "edit_date") {
    console.log(`[DET] edit_date`);
    await updateState({
      pendingBookingDate: undefined,
      pendingBooking: undefined,
      awaitingTime: undefined,
      awaitingDate: undefined,
      extractedIntent: state.extractedIntent
        ? { ...state.extractedIntent, date: undefined, time: undefined }
        : undefined,
    });
    await updateState({ awaitingDate: true });
    await thread.post("Which date would you like? Reply with a date like 2026-05-15 or tap a quick option.");
    return;
  }

  if (interactiveReplyId === "edit_time") {
    console.log(`[DET] edit_time`);
    await updateState({
      pendingBooking: state.pendingBooking ? { ...state.pendingBooking, time: undefined } : undefined,
      awaitingTime: undefined,
      extractedIntent: state.extractedIntent
        ? { ...state.extractedIntent, time: undefined }
        : undefined,
    });
    if (!state.pendingBookingDate) {
      await thread.post("Pick a date first, then I'll show available times.");
      return;
    }
    const raw = await (tools as any).get_clinic_availability.execute({ date: state.pendingBookingDate });
    const plan = buildInteractivePlanFromToolResults(
      [{ toolName: "get_clinic_availability", result: raw }],
      state
    );
    const sent = plan ? await sendInteractivePlan(extractPhone(thread), plan) : false;
    if (!sent) {
      await thread.post("Which time would you like? Reply with HH:mm.");
    }
    return;
  }

  if (interactiveReplyId === "edit_method") {
    console.log(`[DET] edit_method`);
    await updateState({
      activeMethodId: undefined,
      pendingBookingDate: undefined,
      pendingBooking: undefined,
      awaitingAddress: undefined,
      awaitingTime: undefined,
      awaitingDate: undefined,
      extractedIntent: state.extractedIntent
        ? { ...state.extractedIntent, method: undefined, date: undefined, time: undefined }
        : undefined,
    });
    const svc = state.serviceOptions?.find((s) => s.serviceId === state.activeServiceId);
    if (!svc || svc.methods.length === 0) {
      await thread.post("Please pick a service first.");
      return;
    }
    const sent = await sendInteractivePlan(extractPhone(thread), {
      body: "Which method?",
      options: svc.methods.slice(0, 10).map((m, i) => ({
        id: `method_select_${i + 1}`,
        title: clip(m.methodName, 24),
      })),
    });
    if (!sent) {
      await thread.post("Which method? Reply with: in-clinic, house call, or video.");
    }
    return;
  }

  if (interactiveReplyId === "edit_note") {
    console.log(`[DET] edit_note → awaitingRemark`);
    await updateState({ awaitingRemark: true });
    await thread.post("Type the note you'd like attached to this booking.");
    return;
  }

  // Used downstream to force a search if the LLM replies with bare text on a
  // booking-intent message. Kept broad on purpose.
  const looksLikeNewBookingIntent =
    !isInteractiveClick &&
    !incomingLocation &&
    /\b(book|booking|appointment|schedule|checkup|consult)\b/i.test(incomingText);

  // Stale-clear must be conservative: mid-flow free text (e.g. "ok let me
  // book at 3pm") used to wipe state. Now only an explicit reset phrase or
  // a session-gap clears active selections.
  const looksLikeExplicitReset =
    !isInteractiveClick &&
    !incomingLocation &&
    /\b(start over|reset|new booking|cancel (this|the) booking|different clinic|change clinic|change service|nevermind|never mind)\b/i.test(incomingText);
  // Only trigger on the turn where the gap actually opened, not every
  // subsequent turn — otherwise mid-flow state (awaitingTime, active
  // selections) gets wiped on every message after a historical gap.
  const sessionBoundaryHit = sessionStart > 0 && sessionStart === allMessages.length - 1;

  if (
    !deepLinkApplied &&
    (sessionBoundaryHit || looksLikeExplicitReset) &&
    (state.activeClinicId || state.activeServiceId)
  ) {
    console.log(
      `[BOT] Clearing stale active selections (sessionBoundary=${sessionBoundaryHit} explicitReset=${looksLikeExplicitReset})`
    );
    await updateState({
      activeClinicId: undefined,
      activeServiceId: undefined,
      activeMethodId: undefined,
      activeDoctorId: undefined,
      clinicOptions: undefined,
      serviceOptions: undefined,
      doctorOptions: undefined,
      lastSearchQuery: undefined,
      lastLocation: undefined,
      pendingBooking: undefined,
      pendingBookingDate: undefined,
      pendingIsNewPatient: undefined,
      awaitingAddress: undefined,
      awaitingTime: undefined,
      awaitingDate: undefined,
      awaitingRemark: undefined,
      extractedIntent: undefined,
    });
  }

  const systemPrompt = buildSystemPrompt(state, extraSystemNotes);

  // Cap session messages to prevent token overflow
  const MAX_SESSION_MESSAGES = 50;
  const sessionMessages = allMessages.slice(sessionStart);
  const messages = sessionMessages.length > MAX_SESSION_MESSAGES
    ? sessionMessages.slice(-MAX_SESSION_MESSAGES)
    : sessionMessages;
  const history = await toAiMessages(messages);
  const replyIdForFallback = extractInteractiveReplyId(activeMessage);
  const deterministicTapPrefixes = [
    "patient_select_",
    "clinic_select_",
    "service_select_",
    "method_select_",
    "doctor_select_",
    "clarify_service_",
    "date_select_",
    "time_select_",
    "period_select_",
    "view_booking:",
    "edit_service",
    "edit_date",
    "edit_time",
    "edit_method",
    "edit_note",
    "cancel_booking",
  ];
  const deterministicTapIds = new Set([
    "NEAR_ME",
    "booking_confirm_yes",
    "booking_confirm_no",
    "date_select_other",
    "time_select_other",
    "new_patient_yes",
    "new_patient_no",
  ]);
  const shouldSkipFallbackMap =
    !!replyIdForFallback &&
    (deterministicTapIds.has(replyIdForFallback) ||
      deterministicTapPrefixes.some((p) => replyIdForFallback.startsWith(p)));
  const normalizedButtonReply = shouldSkipFallbackMap
    ? undefined
    : mapInteractiveReplyToText(replyIdForFallback);
  if (normalizedButtonReply) {
    const lastMessage = (history as any[])[history.length - 1];
    const lastContent = typeof lastMessage?.content === "string" ? lastMessage.content : "";
    if (!lastContent || !lastContent.includes(normalizedButtonReply)) {
      (history as any[]).push({ role: "user", content: normalizedButtonReply });
    }
  }
  if (incomingLocation) {
    const locText = `[location shared: ${incomingLocation.lat}, ${incomingLocation.lng}]`;
    const lastMessage = (history as any[])[history.length - 1];
    const lastContent = typeof lastMessage?.content === "string" ? lastMessage.content : "";
    if (!lastContent.includes(locText)) {
      (history as any[]).push({ role: "user", content: locText });
    }
  }

  console.log(`[LLM] History len=${history.length} last="${clip(String((history as any[])[history.length - 1]?.content ?? ""), 80)}"`);

  try {
    let lastToolResults: any[] | undefined;
    const result = await generateText({
      system: systemPrompt,
      tools,
      onStepFinish({ text, toolCalls, toolResults, finishReason }) {
        const calls = (toolCalls ?? []).map((c: any) => `${c.toolName}(${clip(JSON.stringify(c.input ?? {}), 80)})`).join(", ");
        const results = (toolResults ?? []).map((r: any) => {
          const out = typeof r.output === "string" ? r.output : JSON.stringify(r.output ?? "");
          return `${r.toolName}=>${clip(out, 120)}`;
        }).join(" | ");
        console.log(
          `[LLM STEP] finish=${finishReason}` +
          (text ? ` text="${clip(text, 120)}"` : "") +
          (calls ? ` calls=[${calls}]` : "") +
          (results ? ` results=[${results}]` : "")
        );
        if (toolResults?.length) {
          lastToolResults = toolResults as any[];
        }
      },
      stopWhen: stepCountIs(16),
      messages: history,
    });

    let effectiveText = result.text ?? "";
    let effectiveToolResults = lastToolResults;

    // If any tool returned the alreadyInProgress guard, the LLM tends to
    // emit a confused "I can't continue" sentence. Drop that text so the
    // state-derived plan body (e.g. "Please choose a service.") is shown.
    const hadAlreadyInProgress = (effectiveToolResults ?? []).some((r: any) => {
      const data = parseJsonSafe(r?.result ?? r?.output ?? r?.toolResult ?? r?.value);
      return data && typeof data === "object" && (data as any).alreadyInProgress === true;
    });
    if (hadAlreadyInProgress) {
      console.log("[GUARD] Dropping LLM text after alreadyInProgress; will re-render current step.");
      effectiveText = "";
    }

    // Guardrail: if the model replies with plain text on a fresh booking
    // intent (without calling tools), force a real search to avoid invented
    // service/clinic options.
    if (
      !effectiveToolResults?.length &&
      !isInteractiveClick &&
      looksLikeNewBookingIntent &&
      !state.activeClinicId &&
      !state.activeServiceId &&
      incomingText.trim().length > 0
    ) {
      try {
        const forcedRaw = await (tools as any).search_services.execute({ query: incomingText.trim() });
        effectiveToolResults = [{ toolName: "search_services", result: forcedRaw }];
        effectiveText = "";
        console.log("[GUARD] Forced search_services after text-only booking reply.");
      } catch (forceErr) {
        console.warn("[GUARD] Forced search_services failed:", forceErr);
      }
    }

    if (effectiveText || effectiveToolResults?.length) {
      const planFromTools = buildInteractivePlanFromToolResults(effectiveToolResults, state);
      const planFromState = planFromTools ? undefined : buildInteractivePlanFromState(state);
      const selectionPlan = planFromTools ?? planFromState;
      const lastToolName = effectiveToolResults?.length
        ? String(
          (effectiveToolResults[effectiveToolResults.length - 1] as any)?.toolName ?? "?"
        )
        : "(none)";
      console.log(
        `[INTERACTIVE] decide tools=${effectiveToolResults?.length ?? 0} lastTool=${lastToolName} ` +
        `state{cli=${!!state.activeClinicId} svc=${!!state.activeServiceId} mtd=${!!state.activeMethodId} doc=${!!state.activeDoctorId} pat=${!!state.activePatientId} | clinicOpts=${state.clinicOptions?.length ?? 0} svcOpts=${state.serviceOptions?.length ?? 0}} ` +
        `planTools=${planFromTools ? planFromTools.body : "-"} planState=${planFromState ? planFromState.body : "-"}`
      );
      const wantsLocationRequest = (() => {
        if (!effectiveToolResults?.length) return false;
        for (let i = effectiveToolResults.length - 1; i >= 0; i--) {
          const raw = effectiveToolResults[i] ?? {};
          const toolName = String(raw.toolName ?? raw.tool ?? raw.name ?? "");
          if (toolName !== "search_services_near_me") continue;
          const data = parseJsonSafe(raw.result ?? raw.output ?? raw.toolResult ?? raw.value);
          if (data && typeof data === "object" && (data as any).needsLocation === true) {
            return true;
          }
          return false;
        }
        return false;
      })();
      if (selectionPlan) {
        let pendingType: ThreadState["pendingSelectionType"] | undefined;
        let pendingQuery: string | undefined;
        if (selectionPlan.body === PLAN_BODY.serviceClarify) {
          pendingType = "service_clarify";
          pendingQuery = incomingText.trim() || state.lastSearchQuery;
        } else if (selectionPlan.body === PLAN_BODY.clinic) {
          pendingType = "clinic";
          pendingQuery = state.lastSearchQuery;
        }
        if (pendingType) {
          await updateState({ pendingSelectionType: pendingType, pendingSelectionQuery: pendingQuery });
        }
        // For the service-clarify plan the LLM tends to mix clinic and service
        // language ("here are clinics that offer …") even though the user only
        // needs to disambiguate the service type. Use the plan body alone to
        // keep the prompt focused.
        const useBodyOverride = selectionPlan.body !== PLAN_BODY.serviceClarify;
        const sent = await sendInteractivePlan(
          extractPhone(thread),
          selectionPlan,
          useBodyOverride ? effectiveText : undefined
        );
        console.log(`[INTERACTIVE] sent list "${selectionPlan.body}" success=${sent}`);
        if (!sent) {
          await thread.post(useBodyOverride ? effectiveText : selectionPlan.body);
        }
      } else if (wantsLocationRequest) {
        const sent = await sendLocationRequest(extractPhone(thread), effectiveText);
        console.log(`[INTERACTIVE] sent location_request success=${sent}`);
        if (!sent) {
          await thread.post(effectiveText);
        }
      } else if (shouldSendBookingConfirmButtons(effectiveText, state)) {
        const sent = await sendReplyButtons(extractPhone(thread), effectiveText, [
          { id: "booking_confirm_yes", title: "Yes, confirm" },
          { id: "booking_confirm_no", title: "Change details" },
        ]);
        if (!sent) {
          await thread.post(effectiveText);
        }
      } else {
        await thread.post(effectiveText);
      }
    } else {
      await thread.post(
        "I'm sorry, I couldn't find what you're looking for. Could you describe the service you need in a different way, or contact the clinic directly for help?"
      );
    }
  } catch (err) {
    console.error("handleMessage error:", err);
    await thread.post(
      "Sorry, I'm having trouble right now. Please try again in a moment."
    );
  } finally {
    if (state.unknownSlugThisTurn) {
      state.unknownSlugThisTurn = undefined;
      await thread.setState(state);
    }
  }
}
