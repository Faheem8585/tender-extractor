// ============================================================
// rebuild-tree.ts — rebuild just the tree step from an existing
// extracted JSON (skips re-parsing and re-extraction).
//
// Usage:
//   npx ts-node rebuild-tree.ts output/Salzburg\ Laboratory\ Tender_extracted.json
// ============================================================

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { buildTree } from "./src/builders/treeBuilder";
import { ConsolidatedRequirement, PipelineResult } from "./src/types/procurement";

dotenv.config();

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath || !fs.existsSync(inputPath)) {
    console.error("Usage: npx ts-node rebuild-tree.ts <extracted.json>");
    process.exit(1);
  }

  console.log(`[Rebuild] Loading: ${inputPath}`);
  const existing: PipelineResult & { consolidatedRequirements?: ConsolidatedRequirement[] } =
    JSON.parse(fs.readFileSync(inputPath, "utf-8"));

  // The pipeline result doesn't store the consolidated requirements by default,
  // so we reconstruct them from the flat leaf nodes in the existing tree.
  // Better: load from a sidecar file if present.
  const sidecarPath = inputPath.replace("_extracted.json", "_consolidated.json");
  let consolidated: ConsolidatedRequirement[];

  if (fs.existsSync(sidecarPath)) {
    console.log(`[Rebuild] Loading consolidated requirements from sidecar: ${sidecarPath}`);
    consolidated = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
  } else {
    console.error(
      `[Rebuild] No sidecar file found at ${sidecarPath}.\n` +
      `Run the full pipeline with the updated code — it now saves a sidecar.`
    );
    process.exit(1);
  }

  console.log(`[Rebuild] ${consolidated.length} consolidated requirements loaded`);
  console.log("[Rebuild] Rebuilding tree with batched tree builder...");

  const start = Date.now();
  const tree = await buildTree(consolidated);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  const result: PipelineResult = {
    ...existing,
    tree,
  };

  fs.writeFileSync(inputPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`[Rebuild] Done in ${elapsed}s — tree written back to ${inputPath}`);
}

main().catch((err) => {
  console.error("[Rebuild] Fatal:", err);
  process.exit(1);
});
