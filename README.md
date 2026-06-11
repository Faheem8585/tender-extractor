# Tender Extraction Pipeline

Reads procurement tender PDFs (main notice + annexes + datasheets) and extracts every
requirement, specification, and obligation into a structured 3-level JSON tree.

Each node in the tree is a `ProcurementMatchDeliverable`. The hard part is pulling
fragments of the same requirement — scattered across different pages or even different
files — onto a single leaf node.

---

## Quick Start

```bash
# 1. install
npm install

# 2. copy env and add your API key
cp .env.example .env
# edit .env — set DEEPSEEK_API_KEY

# 3. run on a tender
npx ts-node src/main.ts sample-tenders/your_tender.pdf

# multiple files (main notice + annexes)
npx ts-node src/main.ts main.pdf annex_a.pdf annex_b.pdf --output output/
```

Requires Node.js ≥ 18.

---

## How it works

```
PDFs
 │
 ▼
pdfParser.ts          — reads pages, splits into overlapping chunks (~3000 chars each)
 │                      chunk IDs: doc{i}_p{page}_c{chunk}
 ▼
requirementExtractor.ts — sends chunks to DeepSeek in parallel batches
 │                         Zod-validates every response, retries on failure
 │                         saves a checkpoint file so crashes can resume
 ▼
chunkConsolidator.ts  — THE hard part
 │  two-pass approach:
 │    1. coarse grouping by suggested L1/L2 category labels
 │    2. LLM decides which members of each group are the same requirement
 │       all sourceChunkIds from merged fragments end up on one node
 ▼
treeBuilder.ts        — two-step batched tree building:
 │    step A: one LLM call decides L1 categories, assigns every req to a bucket
 │    step B: one LLM call per L1 bucket decides L2 sub-categories
 │            large buckets auto-split into sub-batches of 120
 ▼
output/<tender>_extracted.json
```

All three LLM-heavy stages run requests in parallel (configurable concurrency).

---

## Dense / large tenders

Dense technical specs (lots of DIN/ISO standards per page) can overflow the default
chunk settings. For anything over ~100 pages I use smaller chunks:

```bash
CHUNK_SIZE_CHARS=1500 CHUNK_OVERLAP_CHARS=150 EXTRACTION_BATCH_SIZE=1 \
  npx ts-node src/main.ts large_tender.pdf
```

---

## Rebuilding the tree without re-extracting

Extraction is the expensive step (~1 API call per chunk). Every run saves a
`output/<tender>_consolidated.json` sidecar. To tweak just the tree structure:

```bash
npx ts-node rebuild-tree.ts output/your_tender_extracted.json
```

Takes about a minute regardless of tender size.

---

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | required |
| `DEEPSEEK_MODEL` | `deepseek-chat` | |
| `CHUNK_SIZE_CHARS` | `3000` | reduce for dense tenders |
| `CHUNK_OVERLAP_CHARS` | `300` | |
| `MAX_RETRIES` | `3` | per LLM call |
| `EXTRACTION_BATCH_SIZE` | `3` | chunks per extraction call |
| `EXTRACTION_CONCURRENCY` | `5` | parallel extraction workers |
| `CONSOLIDATION_BATCH_SIZE` | `30` | candidates per consolidation call |
| `CONSOLIDATION_CONCURRENCY` | `5` | |
| `TREE_L2_BATCH_SIZE` | `120` | max reqs per L2-assignment call |
| `TREE_CONCURRENCY` | `5` | parallel L1→L2 calls |
| `LLM_MAX_CONCURRENT` | `5` | global API concurrency cap |

---

## Output format

`output/<tender>_extracted.json`:

```json
{
  "tenderName": "...",
  "extractedAt": "...",
  "documentCount": 1,
  "totalChunks": 506,
  "rawRequirementCount": 3469,
  "consolidatedRequirementCount": 2684,
  "tree": [ /* ProcurementMatchDeliverable[] */ ]
}
```

Fields that don't apply at this stage are set to their null/empty defaults:
`fullfillable`, `aiReasoning`, `feedback`, `feedbackText`, `openQuestionId` → `null`
`workspaceDocumentChunkIdArray`, `citedProductIdArray`, `citedPersonIdArray` → `[]`
`status` → `"waitingForAnalysis"`

---

## Known limitations

**1. Coarse consolidation misses cross-category duplicates.**
The consolidator groups candidates by their L1/L2 label before running the merge pass.
If two fragments of the same requirement get different labels (e.g. one tagged
"Electrical Testing", the other "Testing"), they land in separate buckets and never get
compared. This is the main source of missed merges. A semantic similarity pass
(embeddings) across groups would fix it.

**2. Scanned PDFs degrade quality.**
`pdf-parse` only works on PDFs with a proper text layer. Scanned/image-based pages and
broken font encodings produce garbled text that the LLM struggles with. OCR fallback
(e.g. Tesseract) would help for pages below a text-density threshold.

**3. Cross-document consolidation is limited.**
Fragments from the main notice and an annex only get merged if they end up in the same
coarse group. There's no explicit cross-document similarity check right now.

**4. Priority inference is heuristic.**
Passive constructions like "the supplier is expected to..." are ambiguous between
"must" and "should". These get flagged as `confidence: "medium"` or `"low"`.

**5. Very large L1 buckets may produce inconsistent L2 naming.**
When a bucket exceeds `TREE_L2_BATCH_SIZE`, it gets split into sub-batches and the
results are merged by name. The LLM may name the same sub-category slightly differently
across batches, leading to near-duplicate L2 nodes.

---

## Design notes

**Why DeepSeek?** It has an OpenAI-compatible API so the same `openai` npm package
works without any extra SDK. Good enough for structured extraction tasks.

**Why overlapping chunks?** A requirement that straddles a page boundary would be split
by a hard cut. The overlap ensures the LLM always sees enough context at each boundary.

**Why Zod on every response?** LLMs occasionally return wrong field names, missing
fields, or invalid enum values. Zod catches all of that before it silently corrupts the
pipeline, and triggers the retry logic.

**Why not embeddings for consolidation?** Embeddings would be more principled than
label-based coarse grouping. I went with the label approach first because it's simpler,
cheaper, and good enough when the LLM assigns consistent categories. Embeddings are
the obvious next step if consolidation quality needs to improve.
