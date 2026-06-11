import { v4 as uuidv4 } from "uuid";
import { RawRequirement, ConsolidatedRequirement } from "../types/procurement";
import { llmJson } from "../extractors/llmClient";
import { ConsolidationOutputSchema, ConsolidationLLMOutput } from "../validators/zodSchemas";

const MAX_RETRIES            = parseInt(process.env.MAX_RETRIES               ?? "3",  10);
const BATCH_SIZE             = parseInt(process.env.CONSOLIDATION_BATCH_SIZE  ?? "30", 10);
const CONCURRENCY            = parseInt(process.env.CONSOLIDATION_CONCURRENCY ?? "5",  10);

/**
 * This is the trickiest part of the whole pipeline.
 *
 * A single tender requirement often shows up in multiple places:
 * the main notice names it, page 382 has the spec, an annex adds a datasheet.
 * We need to pull all those fragments onto ONE node.
 *
 * Approach:
 * 1. Coarse pass: bucket requirements by their suggested (L1, L2) label pair
 * 2. Fine pass: for each bucket, ask the LLM which ones are actually the same
 *    requirement and should be merged vs which are distinct
 *
 * The coarse grouping is a cheap heuristic — the LLM does the real work.
 * All coarse groups run in parallel.
 */
export async function consolidateRequirements(
  raw: RawRequirement[]
): Promise<ConsolidatedRequirement[]> {
  console.log(`[Consolidator] Starting — ${raw.length} raw requirements to consolidate`);

  const groups = buildCoarseGroups(raw);
  console.log(`[Consolidator] Coarse grouping produced ${groups.length} group(s)`);

  const groupResults: ConsolidatedRequirement[][] = new Array(groups.length).fill(null);
  const mergeCounts:  number[]                    = new Array(groups.length).fill(0);

  const queue = groups.map((_, i) => i);
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, async () => {
      while (queue.length > 0) {
        const gi    = queue.shift()!;
        const group = groups[gi];
        const out:  ConsolidatedRequirement[] = [];
        let merges = 0;

        if (group.length === 1) {
          out.push(toConsolidated(group[0], [group[0].rawId]));
        } else {
          console.log(
            `[Consolidator] Group ${gi + 1}/${groups.length} — ` +
            `"${group[0].suggestedL1Category} / ${group[0].suggestedL2Category}" (${group.length} candidates)`
          );

          for (const sub of makeBatches(group, BATCH_SIZE)) {
            const merged = await mergeBatch(sub);

            for (const mg of merged) {
              const members = mg.mergedIds
                .map((id) => raw.find((r) => r.rawId === id))
                .filter(Boolean) as RawRequirement[];
              if (!members.length) continue;

              const chunkIds = [...new Set(members.flatMap((m) => m.sourceChunkIds))];

              if (mg.mergedIds.length > 1) {
                merges++;
                console.log(
                  `[Consolidator] Merged ${mg.mergedIds.length} fragments → "${mg.mergedBulletPoint}" (chunks: ${chunkIds.join(", ")})`
                );
              }

              out.push({
                ...members[0],
                rawId:            mg.representativeId,
                consolidatedId:   uuidv4(),
                bulletPoint:      mg.mergedBulletPoint,
                descriptionEn:    mg.mergedDescriptionEn,
                priority:         mg.priority,
                confidence:       mg.confidence,
                equivalenceAllowed: mg.equivalenceAllowed,
                sourceChunkIds:   chunkIds,
                mergedFromIds:    mg.mergedIds,
              });
            }
          }
        }

        groupResults[gi] = out;
        mergeCounts[gi]  = merges;
      }
    })
  );

  const consolidated = groupResults.flat();
  const totalMerges  = mergeCounts.reduce((a, b) => a + b, 0);

  console.log(
    `[Consolidator] Complete — ${raw.length} raw → ${consolidated.length} consolidated ` +
    `(${totalMerges} merge operations performed)`
  );

  return consolidated;
}

// group by normalised L1+L2 label — cheap heuristic before the LLM pass
function buildCoarseGroups(raw: RawRequirement[]): RawRequirement[][] {
  const map = new Map<string, RawRequirement[]>();
  for (const r of raw) {
    const key = `${r.suggestedL1Category.toLowerCase().trim()}||${r.suggestedL2Category.toLowerCase().trim()}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  return Array.from(map.values());
}

async function mergeBatch(
  candidates: RawRequirement[]
): Promise<ConsolidationLLMOutput["groups"]> {
  const sys = `You are a procurement document analyst consolidating requirement fragments.

A single requirement is often described in multiple places — page 60 names the deliverable,
page 382 gives its spec, an annex adds a datasheet. Your job: decide which fragments describe
the SAME requirement (merge them) vs which are distinct (keep separate).

Merge if: same deliverable/obligation, one is a detail/spec of the other, or one references the other.
Don't merge: different deliverables in same category, different time periods, items in an enumerated list.

For each group:
- representativeId: rawId that best names the requirement
- mergedIds: ALL rawIds in group (including representative)
- mergedBulletPoint: refined label covering all merged fragments
- mergedDescriptionEn: combined English description from all fragments
- priority: strongest among merged ("must" > "should" > "optional")
- confidence: lowest among merged
- equivalenceAllowed: true if ANY fragment says "or equivalent", otherwise keep value

Every input rawId must appear in exactly one output group.

Respond ONLY with valid JSON:
{
  "groups": [
    {
      "representativeId": "...",
      "mergedIds": ["id1", "id2"],
      "mergedBulletPoint": "...",
      "mergedDescriptionEn": "...",
      "priority": "must",
      "confidence": "high",
      "equivalenceAllowed": null
    }
  ]
}`;

  const list = candidates
    .map((c, i) =>
      `[${i + 1}] rawId: "${c.rawId}"\n  bulletPoint: "${c.bulletPoint}"\n  description: "${c.descriptionEn}"\n  priority: ${c.priority}\n  chunks: ${c.sourceChunkIds.join(", ")}`
    )
    .join("\n\n");

  const usr = `Consolidate these ${candidates.length} requirement fragments. Every rawId must appear in exactly one group.\n\n${list}\n\nReturn ONLY the JSON object.`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw    = await llmJson<ConsolidationLLMOutput>([{ role: "system", content: sys }, { role: "user", content: usr }], { temperature: 0.05, maxTokens: 8192 });
      const parsed = ConsolidationOutputSchema.parse(raw);

      // make sure the LLM didn't silently drop any ids
      const covered = new Set(parsed.groups.flatMap((g) => g.mergedIds));
      for (const c of candidates) {
        if (!covered.has(c.rawId)) {
          console.warn(`[Consolidator] LLM dropped rawId ${c.rawId} — adding as singleton`);
          parsed.groups.push({
            representativeId:   c.rawId,
            mergedIds:          [c.rawId],
            mergedBulletPoint:  c.bulletPoint,
            mergedDescriptionEn: c.descriptionEn,
            priority:           c.priority,
            confidence:         c.confidence,
            equivalenceAllowed: c.equivalenceAllowed,
          });
        }
      }
      return parsed.groups;

    } catch (err) {
      console.warn(`[Consolidator] Attempt ${attempt}/${MAX_RETRIES} failed: ${String(err)}`);
      if (attempt === MAX_RETRIES) {
        console.error(`[Consolidator] All retries exhausted — returning candidates as singletons`);
        return candidates.map((c) => ({
          representativeId:    c.rawId,
          mergedIds:           [c.rawId],
          mergedBulletPoint:   c.bulletPoint,
          mergedDescriptionEn: c.descriptionEn,
          priority:            c.priority,
          confidence:          c.confidence,
          equivalenceAllowed:  c.equivalenceAllowed,
        }));
      }
    }
  }

  return candidates.map((c) => ({
    representativeId:    c.rawId,
    mergedIds:           [c.rawId],
    mergedBulletPoint:   c.bulletPoint,
    mergedDescriptionEn: c.descriptionEn,
    priority:            c.priority,
    confidence:          c.confidence,
    equivalenceAllowed:  c.equivalenceAllowed,
  }));
}

function toConsolidated(r: RawRequirement, mergedFromIds: string[]): ConsolidatedRequirement {
  return { ...r, consolidatedId: uuidv4(), mergedFromIds };
}

function makeBatches<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
