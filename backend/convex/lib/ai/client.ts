import { LIMITS } from "../constants";

// OpenAI-compatible chat completions on the UCSB L&S AI service (https://docs.cloud.college.ucsb.edu/AI-LLM).

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const DEFAULT_BASE_URL = "https://api.ai.college.ucsb.edu/v1";

export function aiModels() {
  return {
    fast: process.env.AI_MODEL_FAST || "gemma-4-26b-a4b-it",
    answer: process.env.AI_MODEL_ANSWER || "qwen3.8-27b",
  };
}

function isDryRun() {
  return process.env.AI_DRY_RUN === "true";
}

function endpoint() {
  return `${(process.env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
}

/** The provider echoes parts of the key (prefix, last characters, its hash) in auth errors; keep them out of the database and logs. */
async function serviceError(response: Response) {
  const text = (await response.text())
    .replace(/sk-[^\s"',]*/g, "sk-…")
    .replace(/\b[0-9a-f]{32,}\b/gi, "…");
  return new Error(`AI service ${response.status}: ${text.slice(0, 200)}`);
}

async function post(body: Record<string, unknown>, timeoutMs: number = LIMITS.aiRequestTimeoutMs) {
  const key = process.env.AI_API_KEY;
  if (!key) throw new Error("AI_API_KEY is not set");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { response, done: () => clearTimeout(timer) };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

/** Removes reasoning blocks some models (qwen) put in the content. An unclosed block hides everything after it. */
export function stripThinking(text: string) {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trimStart();
}

/** The first JSON object in a reply, tolerating code fences and text around it. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = stripThinking(text);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(cleaned.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function complete(model: string, messages: ChatMessage[], temperature: number, timeoutMs?: number) {
  const { response, done } = await post({ model, messages, temperature, stream: false }, timeoutMs);
  try {
    if (!response.ok) throw await serviceError(response);
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  } finally {
    done();
  }
}

/** A JSON-only call (relevance filter, task scan). Returns null when the reply isn't a JSON object. */
export async function chatJson(model: string, messages: ChatMessage[], dryRun: () => Record<string, unknown>) {
  if (isDryRun()) return dryRun();
  return parseJsonObject(await complete(model, messages, 0));
}

/**
 * Streams an answer, calling `onText` with the visible text so far (reasoning stripped).
 * Falls back to one non-streaming call if the gateway refuses `stream`.
 */
export async function chatStream(
  model: string,
  messages: ChatMessage[],
  onText: (text: string) => Promise<void>,
  dryRun: () => string,
  options: { temperature?: number; timeoutMs?: number } = {},
): Promise<string> {
  if (isDryRun()) {
    const text = dryRun();
    await onText(text);
    return text;
  }
  const temperature = options.temperature ?? 0.4;
  const { response, done } = await post({ model, messages, temperature, stream: true }, options.timeoutMs);
  try {
    if (response.status === 400 || response.status === 422) {
      const text = stripThinking(await complete(model, messages, temperature, options.timeoutMs)).trim();
      await onText(text);
      return text;
    }
    if (!response.ok || !response.body) throw await serviceError(response);
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const text = stripThinking(data.choices?.[0]?.message?.content ?? "").trim();
      await onText(text);
      return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let raw = "";
    let finished = false;
    while (!finished) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      let changed = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          finished = true;
          break;
        }
        try {
          const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            raw += delta;
            changed = true;
          }
        } catch {
          // Keep-alive comments and partial frames are skipped.
        }
      }
      if (changed) await onText(stripThinking(raw));
    }
    const text = stripThinking(raw).trim();
    if (!text) throw new Error("AI service returned an empty answer");
    await onText(text);
    return text;
  } finally {
    done();
  }
}
