import "dotenv/config";
import { generateText, stepCountIs } from "ai";
import { getModel } from "../src/lib/config";
import { buildSystemPrompt } from "../src/bot/prompt";
import { createTools } from "../src/bot/tools";
import type { ThreadState } from "../src/types";

const testPhone = process.argv[2] ?? "60123456789";
const userMessage = process.argv[3] ?? "Hi, I want to book a checkup";

async function main() {
  console.log(`\nTest phone: ${testPhone}`);
  console.log(`User message: ${userMessage}\n`);

  const state: ThreadState = {
    phone: testPhone,
    verified: false,
    verifyAttempts: 0,
  };

  const updateState = async (partial: Partial<ThreadState>) => {
    Object.assign(state, partial);
    console.log("[State updated]:", JSON.stringify(partial, null, 2));
  };

  const tools = createTools(state, updateState);

  const result = await generateText({
    model: getModel(),
    system: buildSystemPrompt(),
    tools,
    stopWhen: stepCountIs(8),
    messages: [{ role: "user", content: userMessage }],
  });

  console.log("\n--- Tool calls ---");
  for (const step of result.steps) {
    for (const tc of step.toolCalls) {
      console.log(`  ${tc.toolName}(${JSON.stringify(tc.args)})`);
    }
    for (const tr of step.toolResults) {
      const text = typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result);
      console.log(`  → ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
    }
  }

  console.log("\n--- Bot response ---");
  console.log(result.text || "(no text response)");

  console.log("\n--- Final state ---");
  console.log(JSON.stringify(state, null, 2));
}

main().catch(console.error);
