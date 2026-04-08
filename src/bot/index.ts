import { Chat, toAiMessages } from "chat";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { createPostgresState } from "@chat-adapter/state-pg";
import { generateText, stepCountIs } from "ai";
import { createTools } from "./tools";
import { buildSystemPrompt } from "./prompt";
import { getModel } from "@/lib/config";
import { validateEnv } from "@/lib/env";
import type { ThreadState } from "@/types";

let _bot: ReturnType<typeof createBot> | null = null;

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
    await handleMessage(thread, message);
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

async function handleMessage(thread: any, message: any) {
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
    if (currMs - prevMs > sessionGapMs) {
      sessionStart = i;
      break;
    }
  }

  const messages = allMessages.slice(sessionStart);
  const history = await toAiMessages(messages);

  console.log("[LLM] System Prompt:", systemPrompt);
  console.log("[LLM] History:", JSON.stringify(history, null, 2));

  try {
    const result = await generateText({
      model: getModel(),
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
      },
      stopWhen: stepCountIs(16),
      messages: history,
    });

    if (result.text) {
      await thread.post(result.text);
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
