import * as fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { DocumentChunk, RawRequirement } from "../types/procurement";
import { llmJson } from "./llmClient";
import { RawRequirementArraySchema, RawRequirementLLMOutput } from "../validators/zodSchemas";
import { log, warn, error } from "../utils/logger";

const BATCH_SIZE  = parseInt(process.env.EXTRACTION_BATCH_SIZE  ?? "3", 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES            ?? "3", 10);
const CONCURRENCY = parseInt(process.env.EXTRACTION_CONCURRENCY ?? "5", 10);

/**
 * Main extraction entry point. Processes chunks in parallel batches,
 * validates every response with Zod, retries on failure.
 * Saves a checkpoint file so we can resume if something crashes halfway.
 */
export async function extractRequirements(
  chunks: DocumentChunk[],
  checkpointPath?: string
): Promise<RawRequirement[]> {
  const batches = makeBatches(chunks, BATCH_SIZE);

  log(
    `[Extractor] Starting extraction — ${chunks.length} chunks, ` +
    `batch size ${BATCH_SIZE}, concurrency ${CONCURRENCY}`
  );

  // load checkpoint if we're resuming a previous run
  const done = new Map<number, RawRequirement[]>();
  if (checkpointPath && fs.existsSync(checkpointPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(checkpointPath, "utf-8")) as Record<string, RawRequirement[]>;
      for (const [k, v] of Object.entries(saved)) done.set(parseInt(k), v);
      log(`[Extractor] Resuming — ${done.size}/${batches.length} batches already done`);
    } catch {
      warn("[Extractor] Couldn't read checkpoint, starting fresh");
    }
  }

  const results: Array<RawRequirement[]> = new Array(batches.length).fill(null);
  for (const [i, reqs] of done) {
    if (i < batches.length) results[i] = reqs;
  }

  const pending = batches.map((_, i) => i).filter((i) => results[i] === null);
  log(`[Extractor] ${pending.length} batches to process (${batches.length - pending.length} from checkpoint)`);

  await runParallel(pending, CONCURRENCY, async (idx) => {
    const reqs = await processBatch(batches[idx], idx + 1, batches.length);
    results[idx] = reqs;

    if (checkpointPath) {
      const snap: Record<string, RawRequirement[]> = {};
      results.forEach((r, i) => { if (r !== null) snap[i] = r; });
      fs.writeFileSync(checkpointPath, JSON.stringify(snap), "utf-8");
    }

    const total = results.flat().filter(Boolean).length;
    log(
      `[Extractor] Batch ${idx + 1}/${batches.length} — ` +
      `extracted ${reqs.length} req(s). Progress: ${results.filter(Boolean).length}/${batches.length} batches done, ${total} reqs so far`
    );
  });

  const all = results.flat();
  log(`[Extractor] Complete — ${all.length} raw requirements extracted`);

  if (checkpointPath && fs.existsSync(checkpointPath)) {
    fs.unlinkSync(checkpointPath);
    log(`[Extractor] Checkpoint removed`);
  }

  return all;
}

async function processBatch(
  batch: DocumentChunk[],
  num: number,
  total: number
): Promise<RawRequirement[]> {
  const context = batch
    .map((c) => `--- CHUNK ${c.chunkId} (${c.documentName}, page ${c.pageNumber}) ---\n${c.text}`)
    .join("\n\n");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw = await llmJson<RawRequirementLLMOutput>(
        [
          { role: "system", content: systemPrompt() },
          { role: "user",   content: userPrompt(context) },
        ],
        { temperature: 0.05, maxTokens: 8192 }
      );

      const parsed = RawRequirementArraySchema.parse(raw);
      return parsed.requirements.map((r) => ({ ...r, rawId: uuidv4() }));

    } catch (err) {
      warn(
        `[Extractor] Batch ${num}/${total} attempt ${attempt}/${MAX_RETRIES} failed: ${String(err).slice(0, 120)}`
      );
      if (attempt === MAX_RETRIES) {
        error(`[Extractor] Batch ${num}/${total} — all retries exhausted, skipping`);
        return [];
      }
    }
  }
  return [];
}

function makeBatches<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function runParallel<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
      while (queue.length > 0) await fn(queue.shift()!);
    })
  );
}

function systemPrompt(): string {
  return `You are an expert procurement analyst extracting requirements from tender documents.

Read the provided text chunks and identify EVERY requirement, obligation, specification, and constraint.

Rules:
- Extract every distinct requirement — do not skip anything.
- priority: "must" = mandatory (must, shall, required, obligatory)
  "should" = recommended (should, is expected to, preferred)
  "optional" = nice-to-have (may, can, optional, desirable)
- equivalenceAllowed: true ONLY if source says "or equivalent", "or equal", "oder gleichwertig". null if silent.
- confidence: "high" = clear and unambiguous, "medium" = needs interpretation, "low" = implied or vague.
- suggestedL1Category: broad grouping (e.g. "Installation", "Maintenance", "Health & Safety", "Technical Specifications")
- suggestedL2Category: sub-grouping within L1 (e.g. "Electrical Testing", "Anchor Points")
- If tender is not in English: write descriptionEn in English AND keep key original text in descriptionOriginal.
- sourceChunkIds: all chunks in this batch that mention this requirement.
- Keep descriptionEn under 80 words. Keep descriptionOriginal under 80 words.

Respond ONLY with valid JSON, no preamble, no markdown:
{
  "requirements": [
    {
      "bulletPoint": "short label max 120 chars",
      "descriptionEn": "concise English description (max 80 words)",
      "descriptionOriginal": "key phrase in original language if not English, else omit",
      "priority": "must" | "should" | "optional",
      "confidence": "high" | "medium" | "low",
      "equivalenceAllowed": true | false | null,
      "sourceChunkIds": ["chunkId1"],
      "suggestedL1Category": "broad category",
      "suggestedL2Category": "sub-category"
    }
  ]
}`;
}

function userPrompt(context: string): string {
  return `Extract all requirements from these tender document chunks:

${context}

Extract EVERY requirement, obligation, and specification. Don't skip anything.
Return ONLY the JSON object.`;
}
