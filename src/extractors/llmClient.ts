import OpenAI from "openai";

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES ?? "3", 10);
const MAX_CONCURRENT = parseInt(process.env.LLM_MAX_CONCURRENT ?? "5", 10);

// simple semaphore so we don't blast the API with too many parallel calls
let _active = 0;
const _queue: Array<() => void> = [];

function grab(): Promise<void> {
  return new Promise((resolve) => {
    if (_active < MAX_CONCURRENT) {
      _active++;
      resolve();
    } else {
      _queue.push(() => { _active++; resolve(); });
    }
  });
}

function release(): void {
  _active--;
  if (_queue.length > 0) _queue.shift()!();
}

function buildClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set — check your .env file");
  return new OpenAI({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  });
}

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) _client = buildClient();
  return _client;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMCallOptions {
  temperature?: number;
  maxTokens?: number;
}

export async function llmChat(
  messages: LLMMessage[],
  options: LLMCallOptions = {}
): Promise<string> {
  const model = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await grab();
      let text: string;
      try {
        const res = await getClient().chat.completions.create({
          model,
          messages,
          temperature: options.temperature ?? 0.1,
          max_tokens: options.maxTokens ?? 8192,
        });
        text = res.choices[0]?.message?.content ?? "";
        if (!text) throw new Error("empty response from API");
      } finally {
        release();
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        const wait = attempt * 2000;
        console.warn(`[LLM] attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${wait / 1000}s — ${String(err)}`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  throw new Error(`[LLM] all ${MAX_RETRIES} attempts failed: ${String(lastErr)}`);
}

// parse JSON out of the LLM response — strips markdown fences if the model wraps them
export async function llmJson<T>(
  messages: LLMMessage[],
  options: LLMCallOptions = {}
): Promise<T> {
  const raw = await llmChat(messages, options);
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new Error(`[LLM] JSON parse failed. Response preview:\n${raw.slice(0, 500)}`);
  }
}
