/**
 * CLI entry point.
 *
 * Usage:
 *   npx ts-node src/main.ts <pdf1> [pdf2 ...] [--output <dir>]
 *
 * Examples:
 *   npx ts-node src/main.ts tenders/main.pdf
 *   npx ts-node src/main.ts main.pdf annex_a.pdf annex_b.pdf --output output/
 */

import * as path from "path";
import * as fs   from "fs";
import * as dotenv from "dotenv";
import { parseAllPdfs }           from "./parsers/pdfParser";
import { extractRequirements }    from "./extractors/requirementExtractor";
import { consolidateRequirements } from "./consolidators/chunkConsolidator";
import { buildTree }              from "./builders/treeBuilder";
import { PipelineResult }         from "./types/procurement";
import { log, error as logError } from "./utils/logger";

dotenv.config();

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help") {
    printUsage();
    process.exit(0);
  }

  const pdfPaths: string[] = [];
  let outputDir = "./output";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) {
      outputDir = args[++i];
    } else if (args[i].endsWith(".pdf")) {
      pdfPaths.push(args[i]);
    }
  }

  if (pdfPaths.length === 0) {
    logError("No PDF files provided. Run with --help for usage.");
    process.exit(1);
  }

  for (const p of pdfPaths) {
    if (!fs.existsSync(p)) {
      logError(`File not found: ${p}`);
      process.exit(1);
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const tenderName = path.basename(pdfPaths[0], ".pdf");
  const startTime  = Date.now();

  log("=".repeat(60));
  log(`Tender Extraction Pipeline`);
  log(`Tender:    ${tenderName}`);
  log(`Input:     ${pdfPaths.join(", ")}`);
  log(`Output:    ${outputDir}`);
  log(`Provider:  ${process.env.LLM_PROVIDER ?? "deepseek"}`);
  log("=".repeat(60));

  // step 1 — parse PDFs into chunks
  log("Step 1/4 — PDF Parsing");
  const chunks = await parseAllPdfs(pdfPaths);

  // step 2 — extract raw requirements from each chunk
  log("Step 2/4 — Requirement Extraction");
  const checkpointPath = path.join(outputDir, `${tenderName}_checkpoint.json`);
  const rawRequirements = await extractRequirements(chunks, checkpointPath);

  // step 3 — merge scattered fragments of the same requirement
  log("Step 3/4 — Chunk Consolidation");
  const consolidated = await consolidateRequirements(rawRequirements);

  // step 4 — build the 3-level tree
  log("Step 4/4 — Tree Building");
  const tree = await buildTree(consolidated);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const result: PipelineResult = {
    tenderName,
    extractedAt:                new Date().toISOString(),
    documentCount:              pdfPaths.length,
    totalChunks:                chunks.length,
    rawRequirementCount:        rawRequirements.length,
    consolidatedRequirementCount: consolidated.length,
    tree,
  };

  const outputPath  = path.join(outputDir, `${tenderName}_extracted.json`);
  const sidecarPath = path.join(outputDir, `${tenderName}_consolidated.json`);

  fs.writeFileSync(outputPath,  JSON.stringify(result, null, 2), "utf-8");
  fs.writeFileSync(sidecarPath, JSON.stringify(consolidated, null, 2), "utf-8");

  log("=".repeat(60));
  log(`Pipeline complete in ${elapsed}s`);
  log(`Chunks:      ${chunks.length}`);
  log(`Raw reqs:    ${rawRequirements.length}`);
  log(`Consolidated: ${consolidated.length}`);
  log(
    `Tree:        ${tree.length} L1 / ` +
    `${tree.reduce((s, n) => s + n.deliverableArray.length, 0)} L2 / ` +
    `${tree.reduce((s, n) => s + n.deliverableArray.reduce((s2, n2) => s2 + n2.deliverableArray.length, 0), 0)} L3 leaves`
  );
  log(`Output:      ${outputPath}`);
  log(`Sidecar:     ${sidecarPath}`);
  log("=".repeat(60));
}

function printUsage(): void {
  console.log(`
Tender Extraction Pipeline
Usage:
  npx ts-node src/main.ts <pdf1> [pdf2 ...] [--output <dir>]

Options:
  --output <dir>   Output directory (default: ./output)
  --help           Show this help

Examples:
  npx ts-node src/main.ts sample-tenders/tender.pdf
  npx ts-node src/main.ts main.pdf annex_a.pdf annex_b.pdf --output output/

Environment (.env):
  DEEPSEEK_API_KEY         Required
  CHUNK_SIZE_CHARS         Characters per chunk (default 3000)
  CHUNK_OVERLAP_CHARS      Overlap between chunks (default 300)
  EXTRACTION_BATCH_SIZE    Chunks per extraction call (default 3)
  EXTRACTION_CONCURRENCY   Parallel extraction calls (default 5)
`);
}

main().catch((err) => {
  logError(`Fatal error: ${String(err)}`);
  process.exit(1);
});
