# DSPy Evaluation for AnyHealth WhatsApp Bot

_Evaluated: 2026-04-02_

## Verdict: Not a natural fit (for now)

### 1. Language mismatch

DSPy is Python-only. The bot is TypeScript/Next.js using Vercel AI SDK. Adopting DSPy would mean either rewriting the bot in Python or running a separate Python microservice — significant overhead for a bot that's already well-structured.

### 2. Architecture already solves what DSPy targets

DSPy replaces manual prompt engineering with declarative "signatures" and automatic prompt optimization. But the bot's complexity is in **tool orchestration**, not prompt fragility:

- A single static system prompt (`src/bot/prompt.ts`) with clear behavioral rules
- 13 well-defined tools with Zod schemas that constrain LLM behavior
- Security enforced in code (not prompt), so prompt drift doesn't create vulnerabilities
- Model-agnostic design via Vercel AI SDK providers

DSPy shines when you have multi-stage NLP pipelines (classify → retrieve → synthesize) where each stage's prompt needs tuning against metrics. The bot is a single `generateText()` call with a tool loop — less surface area for DSPy to optimize.

### 3. Optimization requires training data we don't have yet

DSPy's compilers (MIPROv2, BootstrapFewShot) need labeled examples: input/output pairs with quality scores. The bot is pre-launch — no production conversation logs to optimize against.

## What to invest in instead

| Need | Better Fit | Why |
|------|-----------|-----|
| **Prompt evaluation** | [Braintrust](https://braintrust.dev) or [Langfuse](https://langfuse.com) | TypeScript-native, works with Vercel AI SDK, tracks prompt versions against metrics |
| **Observability/tracing** | Langfuse or Vercel AI SDK's built-in tracing | See every tool call, latency, token usage per conversation |
| **Insurance Q&A quality** | Better RAG (chunking + embeddings) | `ask_insurance` nested LLM call dumps full policy text as context — embeddings + retrieval would scale better |
| **Prompt iteration** | A/B test prompt variants with `test-tools.ts` | Testing script already exists — add assertions |

## When DSPy would make sense

If we later build a **separate Python service** for a specific subtask — like insurance document classification, medical entity extraction, or triage routing — DSPy's optimization loop would be genuinely useful there. But bolting it onto the existing TypeScript bot would add complexity without proportional benefit.

## References

- DSPy: <https://dspy.ai>
- Braintrust: <https://braintrust.dev>
- Langfuse: <https://langfuse.com>
