import { Chat, toAiMessages } from "chat";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { createPostgresState } from "@chat-adapter/state-pg";
import { generateText } from "@/lib/config";
import { createTools } from "./tools";
import { buildSystemPrompt } from "./prompt";
import { validateEnv } from "@/lib/env";
import { sendListMessage, sendReplyButtons } from "@/lib/whatsapp";
import type { ThreadState } from "@/types";
import { stepCountIs } from "ai";

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
    await thread.setState({
      phone,
      verified: false,
      verifyAttempts: 0,
    });

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

  const hasBookingContext =
    Boolean(state.userId) &&
    Boolean(state.activePatientId) &&
    Boolean(state.activeClinicId) &&
    Boolean(state.activeServiceId);
  if (!hasBookingContext) return false;

  const asksForConfirm = /\b(confirm|confirmation)\b/i.test(text);
  const mentionsBooking = /\b(booking|appointment|details)\b/i.test(text);
  const alreadyFinalized = /\b(created successfully|booking created|booking id)\b/i.test(text);

  return asksForConfirm && mentionsBooking && !alreadyFinalized;
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

function mapInteractiveReplyToText(replyId: string | undefined): string | undefined {
  if (!replyId) return undefined;

  if (replyId === "booking_confirm_yes") {
    return "Yes, I confirm all booking details. Please create the booking now.";
  }
  if (replyId === "booking_confirm_no") {
    return "I want to change my booking details.";
  }
  if (replyId.startsWith("patient_select_")) {
    const index = Number(replyId.replace("patient_select_", ""));
    if (Number.isInteger(index) && index > 0) return `I choose patient ${index}.`;
  }
  if (replyId.startsWith("clinic_select_")) {
    const index = Number(replyId.replace("clinic_select_", ""));
    if (Number.isInteger(index) && index > 0) return `I choose clinic ${index}.`;
  }
  if (replyId.startsWith("service_select_")) {
    const index = Number(replyId.replace("service_select_", ""));
    if (Number.isInteger(index) && index > 0) return `I choose service ${index}.`;
  }
  if (replyId.startsWith("method_select_")) {
    const index = Number(replyId.replace("method_select_", ""));
    if (Number.isInteger(index) && index > 0) return `I choose method ${index}.`;
  }
  if (replyId.startsWith("doctor_select_")) {
    const index = Number(replyId.replace("doctor_select_", ""));
    if (Number.isInteger(index) && index > 0) return `I choose doctor ${index}.`;
  }

  return undefined;
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
      toolName === "user_lookup" &&
      data.found === true &&
      data.patientCount > 1 &&
      Array.isArray(data.patients) &&
      !state.activePatientId
    ) {
      const options = data.patients
        .slice(0, 10)
        .map((p: any) => ({
          id: `patient_select_${Number(p.index)}`,
          title: clip(String(p.name ?? `Patient ${p.index}`), 24),
          description: p.ic ? `IC ending ${String(p.ic)}` : undefined,
        }));
      if (options.length > 0) {
        return { body: "Please choose a patient.", options };
      }
    }

    if (
      toolName === "search_services" &&
      data.found === true &&
      Array.isArray(data.clinics) &&
      !state.activeClinicId
    ) {
      const options = data.clinics
        .slice(0, 10)
        .map((c: any) => ({
          id: `clinic_select_${Number(c.index)}`,
          title: clip(String(c.name ?? `Clinic ${c.index}`), 24),
          description: c.address ? clip(String(c.address), 72) : undefined,
        }));
      if (options.length > 0) {
        return { body: "Please choose a clinic.", options };
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
        return { body: "Please choose a service.", options };
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
        return { body: "Please choose a method.", options };
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
        return { body: "Please choose a doctor.", options };
      }
    }
  }

  return undefined;
}

function buildInteractivePlanFromState(state: ThreadState): InteractivePlan | undefined {
  if (!state.activePatientId && (state.patients?.length ?? 0) > 1) {
    return {
      body: "Please choose a patient.",
      options: (state.patients ?? []).slice(0, 10).map((p, i) => ({
        id: `patient_select_${i + 1}`,
        title: clip(String(p.name ?? `Patient ${i + 1}`), 24),
      })),
    };
  }

  if (!state.activeClinicId && (state.clinicOptions?.length ?? 0) > 1) {
    return {
      body: "Please choose a clinic.",
      options: (state.clinicOptions ?? []).slice(0, 10).map((c, i) => ({
        id: `clinic_select_${i + 1}`,
        title: clip(String(c.clinicName ?? `Clinic ${i + 1}`), 24),
        description: c.clinicAddress ? clip(String(c.clinicAddress), 72) : undefined,
      })),
    };
  }

  if (!state.activeServiceId && (state.serviceOptions?.length ?? 1) > 1) {
    return {
      body: "Please choose a service.",
      options: (state.serviceOptions ?? []).slice(0, 10).map((s, i) => ({
        id: `service_select_${i + 1}`,
        title: clip(String(s.serviceName ?? `Service ${i + 1}`), 24),
      })),
    };
  }

  if (!state.activeDoctorId && (state.doctorOptions?.length ?? 0) > 1) {
    return {
      body: "Please choose a doctor.",
      options: (state.doctorOptions ?? []).slice(0, 10).map((d, i) => ({
        id: `doctor_select_${i + 1}`,
        title: clip(String(d.name ?? `Doctor ${i + 1}`), 24),
      })),
    };
  }

  return undefined;
}

async function sendInteractivePlan(phone: string, plan: InteractivePlan): Promise<boolean> {
  const body = clip(plan.body, 900);
  return sendListMessage(phone, body, "Choose option", [
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
    async startTyping() {},
    async subscribe() {},
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
  console.log("[BOT] handleMessage build-marker=v2-2026-04-26");
  console.log(`[BOT] Incoming message from ${thread.id}:`, JSON.stringify(message, null, 2));

  await thread.startTyping?.();

  const state: ThreadState = (await thread.state) ?? {
    phone: extractPhone(thread),
    verified: false,
    verifyAttempts: 0,
  };

  if (!state.phone) {
    state.phone = extractPhone(thread);
  }

  console.log("[BOT] Loaded state:", JSON.stringify({
    userId: state.userId,
    activePatientId: state.activePatientId,
    activeClinicId: state.activeClinicId,
    activeServiceId: state.activeServiceId,
    activeMethodId: state.activeMethodId,
    activeDoctorId: state.activeDoctorId,
  }));

  async function updateState(partial: Partial<ThreadState>) {
    Object.assign(state, partial);
    await thread.setState(state);
  }

  const tools = createTools(state, updateState);
  const systemPrompt = buildSystemPrompt();

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

  // Cap session messages to prevent token overflow
  const MAX_SESSION_MESSAGES = 50;
  const sessionMessages = allMessages.slice(sessionStart);
  const messages = sessionMessages.length > MAX_SESSION_MESSAGES
    ? sessionMessages.slice(-MAX_SESSION_MESSAGES)
    : sessionMessages;
  const history = await toAiMessages(messages);
  const normalizedButtonReply = mapInteractiveReplyToText(extractInteractiveReplyId(message));
  if (normalizedButtonReply) {
    const lastMessage = (history as any[])[history.length - 1];
    const lastContent = typeof lastMessage?.content === "string" ? lastMessage.content : "";
    if (!lastContent || !lastContent.includes(normalizedButtonReply)) {
      (history as any[]).push({ role: "user", content: normalizedButtonReply });
    }
  }

  console.log("[LLM] System Prompt:", systemPrompt);
  console.log("[LLM] History:", JSON.stringify(history, null, 2));

  try {
    let lastToolResults: any[] | undefined;
    const result = await generateText({
      system: systemPrompt,
      tools,
      onStepFinish({ text, toolCalls, toolResults, finishReason }) {
        console.log("[LLM STEP] Finish Reason:", finishReason);
        if (text) console.log("[LLM STEP] Response:", text);
        if (toolCalls?.length)
          console.log("[LLM STEP] Tool Calls:", JSON.stringify(toolCalls, null, 2));
        if (toolResults?.length)
          console.log(
            "[LLM STEP] Tool Results:",
            JSON.stringify(toolResults, null, 2)
          );
        if (toolResults?.length) {
          lastToolResults = toolResults as any[];
        }
      },
      stopWhen: stepCountIs(16),
      messages: history,
    });

    if (result.text) {
      const planFromTools = buildInteractivePlanFromToolResults(lastToolResults, state);
      const planFromState = planFromTools ? undefined : buildInteractivePlanFromState(state);
      const selectionPlan = planFromTools ?? planFromState;
      const lastToolName = lastToolResults?.length
        ? String(
            (lastToolResults[lastToolResults.length - 1] as any)?.toolName ?? "?"
          )
        : "(none)";
      console.log(
        `[INTERACTIVE] decide tools=${lastToolResults?.length ?? 0} lastTool=${lastToolName} ` +
          `state{cli=${!!state.activeClinicId} svc=${!!state.activeServiceId} mtd=${!!state.activeMethodId} doc=${!!state.activeDoctorId} pat=${!!state.activePatientId} | clinicOpts=${state.clinicOptions?.length ?? 0} svcOpts=${state.serviceOptions?.length ?? 0}} ` +
          `planTools=${planFromTools ? planFromTools.body : "-"} planState=${planFromState ? planFromState.body : "-"}`
      );
      if (selectionPlan) {
        const sent = await sendInteractivePlan(extractPhone(thread), selectionPlan);
        console.log(`[INTERACTIVE] sent list "${selectionPlan.body}" success=${sent}`);
        if (!sent) {
          await thread.post(result.text);
        }
      } else if (shouldSendBookingConfirmButtons(result.text, state)) {
        const sent = await sendReplyButtons(extractPhone(thread), result.text, [
          { id: "booking_confirm_yes", title: "Yes, confirm" },
          { id: "booking_confirm_no", title: "Change details" },
        ]);
        if (!sent) {
          await thread.post(result.text);
        }
      } else {
        await thread.post(result.text);
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
  }
}
