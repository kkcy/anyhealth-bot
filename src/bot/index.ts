import { Chat, toAiMessages } from "chat";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { createPostgresState } from "@chat-adapter/state-pg";
import { generateText, stepCountIs } from "ai";
import { createTools } from "./tools";
import { buildSystemPrompt } from "./prompt";
import { getModel } from "@/lib/config";
import type { ThreadState } from "@/types";

let _bot: ReturnType<typeof createBot> | null = null;

function createBot() {
  const adapters = {
    whatsapp: createWhatsAppAdapter(),
  };

  const bot = new Chat<typeof adapters, ThreadState>({
    userName: "anyhealth-bot",
    adapters,
    state: createPostgresState(),
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

async function handleMessage(thread: any, _message: any) {
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

  const messages = [];
  for await (const msg of thread.allMessages) {
    messages.push(msg);
  }
  const history = await toAiMessages(messages);

  try {
    const result = await generateText({
      model: getModel(),
      system: systemPrompt,
      tools,
      stopWhen: stepCountIs(8),
      messages: history,
    });

    if (result.text) {
      await thread.post(result.text);
    }
  } catch (err) {
    console.error("handleMessage error:", err);
    await thread.post(
      "Sorry, I'm having trouble right now. Please try again in a moment."
    );
  }
}
