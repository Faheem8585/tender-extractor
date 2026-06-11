import {
  ConsolidatedRequirement,
  ProcurementMatchDeliverable,
  LocaleObject,
} from "../types/procurement";
import { llmJson } from "../extractors/llmClient";
import { z } from "zod";

const MAX_RETRIES    = parseInt(process.env.MAX_RETRIES         ?? "3",   10);
const L2_BATCH_SIZE  = parseInt(process.env.TREE_L2_BATCH_SIZE  ?? "120", 10);
const CONCURRENCY    = parseInt(process.env.TREE_CONCURRENCY    ?? "5",   10);

// zod schemas for the two LLM calls
const L1Schema = z.object({
  l1Categories: z.array(z.object({
    name:           z.string().min(2),
    description:    z.string().min(5),
    requirementIds: z.array(z.string()).min(1),
  })).min(1).max(12),
});

const L2Schema = z.object({
  l2Categories: z.array(z.object({
    name:           z.string().min(2),
    description:    z.string().min(5),
    requirementIds: z.array(z.string()).min(1),
  })).min(1),
});

type L1Result = z.infer<typeof L1Schema>;
type L2Result = z.infer<typeof L2Schema>;

/**
 * Builds the 3-level ProcurementMatchDeliverable tree.
 *
 * Two-step approach to keep each LLM call manageable:
 *   Step A — one call to decide L1 categories and assign every req to a bucket
 *   Step B — one call per L1 bucket to decide L2 sub-categories
 *             (large buckets are split into sub-batches automatically)
 *
 * Both steps run in parallel where possible.
 */
export async function buildTree(
  consolidated: ConsolidatedRequirement[]
): Promise<ProcurementMatchDeliverable[]> {
  console.log(`[Tree Builder] Building tree from ${consolidated.length} consolidated requirements`);

  if (consolidated.length === 0) return [];

  // step A
  console.log("[Tree Builder] Step A — determining L1 categories");
  const l1 = await getL1Categories(consolidated);

  // step B — all L1 buckets in parallel
  console.log(`[Tree Builder] Step B — assigning L2 sub-categories for ${l1.l1Categories.length} L1 nodes (concurrency ${CONCURRENCY})`);

  const reqMap   = new Map(consolidated.map((r) => [r.consolidatedId, r]));
  const structure: Array<{ l1Name: string; l1Description: string; l2Categories: L2Result["l2Categories"] }> =
    new Array(l1.l1Categories.length);

  const queue = l1.l1Categories.map((cat, idx) => ({ cat, idx }));
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, async () => {
      while (queue.length > 0) {
        const { cat, idx } = queue.shift()!;
        const reqs = cat.requirementIds.map((id) => reqMap.get(id)).filter(Boolean) as ConsolidatedRequirement[];

        console.log(`[Tree Builder]   L1 "${cat.name}" — ${reqs.length} requirements → assigning L2`);
        const l2 = await getL2Categories(cat.name, reqs);

        structure[idx] = { l1Name: cat.name, l1Description: cat.description, l2Categories: l2.l2Categories };
      }
    })
  );

  // assemble tree
  const tree: ProcurementMatchDeliverable[] = structure.map((l1node) => {
    const l2nodes = l1node.l2Categories.map((l2node) => {
      const leaves = l2node.requirementIds
        .map((id) => reqMap.get(id))
        .filter(Boolean)
        .map((r) => buildLeaf(r!));
      return groupNode(l2node.name, { en: l2node.description }, leaves);
    });
    return groupNode(l1node.l1Name, { en: l1node.l1Description }, l2nodes);
  });

  const l1c = tree.length;
  const l2c = tree.reduce((s, n) => s + n.deliverableArray.length, 0);
  const l3c = tree.reduce((s, n) => s + n.deliverableArray.reduce((s2, n2) => s2 + n2.deliverableArray.length, 0), 0);
  console.log(`[Tree Builder] Final tree: ${l1c} L1 / ${l2c} L2 / ${l3c} L3 leaves`);

  // catch anything the LLM missed and dump it in a misc bucket
  const placed = new Set(structure.flatMap((s) => s.l2Categories.flatMap((l2) => l2.requirementIds)));
  const missed = consolidated.filter((r) => !placed.has(r.consolidatedId));
  if (missed.length > 0) {
    console.warn(`[Tree Builder] ${missed.length} requirement(s) not placed — adding to Miscellaneous`);
    tree.push(groupNode("Miscellaneous", { en: "Requirements not categorised in the main structure" }, [
      groupNode("Uncategorised", { en: "Uncategorised" }, missed.map(buildLeaf)),
    ]));
  }

  return tree;
}

async function getL1Categories(consolidated: ConsolidatedRequirement[]): Promise<L1Result> {
  const sys = `You are a procurement analyst. Given a list of tender requirements, decide the top-level (L1) grouping.

Rules:
- 4–12 broad coherent categories reflecting the tender's main subject areas
- Assign EVERY requirement ID to exactly one L1
- Keep names concise (2–5 words)

Return ONLY valid JSON:
{ "l1Categories": [{ "name": "...", "description": "one sentence", "requirementIds": ["id1"] }] }`;

  const list = consolidated
    .map((r) => `id: "${r.consolidatedId}" | "${r.bulletPoint}" [${r.suggestedL1Category}]`)
    .join("\n");

  const usr = `Assign these ${consolidated.length} requirements to L1 categories. Every id must appear in exactly one category.\n\n${list}\n\nReturn ONLY the JSON object.`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw    = await llmJson<L1Result>([{ role: "system", content: sys }, { role: "user", content: usr }], { temperature: 0.1, maxTokens: 8192 });
      const parsed = L1Schema.parse(raw);

      const covered = new Set(parsed.l1Categories.flatMap((c) => c.requirementIds));
      const missing = consolidated.map((r) => r.consolidatedId).filter((id) => !covered.has(id));
      if (missing.length > 0) {
        console.warn(`[Tree Builder] L1 pass missed ${missing.length} ids — adding to last bucket`);
        parsed.l1Categories[parsed.l1Categories.length - 1].requirementIds.push(...missing);
      }
      return parsed;
    } catch (err) {
      console.warn(`[Tree Builder] L1 attempt ${attempt}/${MAX_RETRIES} failed: ${String(err)}`);
      if (attempt === MAX_RETRIES) {
        console.error("[Tree Builder] L1 retries exhausted — using heuristic L1 grouping");
        return heuristicL1(consolidated);
      }
    }
  }
  return heuristicL1(consolidated);
}

async function getL2Categories(l1Name: string, reqs: ConsolidatedRequirement[]): Promise<L2Result> {
  if (reqs.length === 0) return { l2Categories: [] };

  // for big buckets, run in sub-batches and merge results by name
  if (reqs.length > L2_BATCH_SIZE) {
    console.log(`[Tree Builder]   "${l1Name}" has ${reqs.length} reqs — splitting into batches of ${L2_BATCH_SIZE}`);
    const batches = makeBatches(reqs, L2_BATCH_SIZE);
    const merged  = new Map<string, { name: string; description: string; requirementIds: string[] }>();

    for (let bi = 0; bi < batches.length; bi++) {
      console.log(`[Tree Builder]   L2 batch ${bi + 1}/${batches.length} for "${l1Name}" (${batches[bi].length} reqs)`);
      const res = await getL2Categories(l1Name, batches[bi]);
      for (const cat of res.l2Categories) {
        const key = cat.name.toLowerCase().trim();
        if (!merged.has(key)) merged.set(key, { name: cat.name, description: cat.description, requirementIds: [] });
        merged.get(key)!.requirementIds.push(...cat.requirementIds);
      }
    }
    return { l2Categories: Array.from(merged.values()) };
  }

  const sys = `You are a procurement analyst organising requirements within one section of a tender.

Given requirements under "${l1Name}", decide the L2 sub-categories and assign every requirement.

Rules:
- 2–8 sub-categories appropriate for this section
- Assign EVERY requirement ID to exactly one L2
- Keep names concise

Return ONLY valid JSON:
{ "l2Categories": [{ "name": "...", "description": "one sentence", "requirementIds": ["id1"] }] }`;

  const list = reqs
    .map((r) => `id: "${r.consolidatedId}" | "${r.bulletPoint}" [${r.suggestedL2Category}]`)
    .join("\n");

  const usr = `Assign these ${reqs.length} requirements within "${l1Name}" to L2 sub-categories. Every id must appear in exactly one sub-category.\n\n${list}\n\nReturn ONLY the JSON object.`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw    = await llmJson<L2Result>([{ role: "system", content: sys }, { role: "user", content: usr }], { temperature: 0.1, maxTokens: 8192 });
      const parsed = L2Schema.parse(raw);

      const covered = new Set(parsed.l2Categories.flatMap((c) => c.requirementIds));
      const missing = reqs.map((r) => r.consolidatedId).filter((id) => !covered.has(id));
      if (missing.length > 0) {
        console.warn(`[Tree Builder] L2 pass for "${l1Name}" missed ${missing.length} ids — adding to last bucket`);
        parsed.l2Categories[parsed.l2Categories.length - 1].requirementIds.push(...missing);
      }
      return parsed;
    } catch (err) {
      console.warn(`[Tree Builder] L2 attempt ${attempt}/${MAX_RETRIES} for "${l1Name}" failed: ${String(err)}`);
      if (attempt === MAX_RETRIES) {
        console.error(`[Tree Builder] L2 retries exhausted for "${l1Name}" — using heuristic`);
        return heuristicL2(reqs);
      }
    }
  }
  return heuristicL2(reqs);
}

// fallback groupings when the LLM keeps failing
function heuristicL1(consolidated: ConsolidatedRequirement[]): L1Result {
  const map = new Map<string, string[]>();
  for (const r of consolidated) {
    const k = r.suggestedL1Category || "General";
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r.consolidatedId);
  }
  return { l1Categories: Array.from(map.entries()).map(([name, ids]) => ({ name, description: name, requirementIds: ids })) };
}

function heuristicL2(reqs: ConsolidatedRequirement[]): L2Result {
  const map = new Map<string, string[]>();
  for (const r of reqs) {
    const k = r.suggestedL2Category || "Requirements";
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r.consolidatedId);
  }
  return { l2Categories: Array.from(map.entries()).map(([name, ids]) => ({ name, description: name, requirementIds: ids })) };
}

function buildLeaf(req: ConsolidatedRequirement): ProcurementMatchDeliverable {
  const description: LocaleObject<string> = { en: req.descriptionEn };
  if (req.descriptionOriginal) description["original"] = req.descriptionOriginal;

  return {
    bulletPoint: req.bulletPoint,
    description,
    priority:    req.priority,
    confidence:  req.confidence,
    equivalenceAllowed: req.equivalenceAllowed,
    fullfillable:  null,
    status:        "waitingForAnalysis",
    aiReasoning:   null,
    feedback:      null,
    feedbackText:  null,
    openQuestionId: null,
    deliverableArray:                  [],
    procurementDocumentChunkIdArray:   req.sourceChunkIds,
    workspaceDocumentChunkIdArray:     [],
    citedProductIdArray:               [],
    citedPersonIdArray:                [],
  };
}

function groupNode(
  bulletPoint: string,
  description: LocaleObject<string>,
  children: ProcurementMatchDeliverable[]
): ProcurementMatchDeliverable {
  return {
    bulletPoint,
    description,
    priority:    "must",
    confidence:  null,
    equivalenceAllowed: null,
    fullfillable:  null,
    status:        "waitingForAnalysis",
    aiReasoning:   null,
    feedback:      null,
    feedbackText:  null,
    openQuestionId: null,
    deliverableArray:                  children,
    procurementDocumentChunkIdArray:   [],
    workspaceDocumentChunkIdArray:     [],
    citedProductIdArray:               [],
    citedPersonIdArray:                [],
  };
}

function makeBatches<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
