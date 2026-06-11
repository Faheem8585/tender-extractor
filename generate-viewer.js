// Generates a self-contained HTML viewer from the extracted JSON output
const fs = require("fs");
const path = require("path");

const outputDir = "./output";
const files = fs.readdirSync(outputDir).filter((f) => f.endsWith("_extracted.json"));

if (files.length === 0) {
  console.error("No extracted JSON files found in ./output");
  process.exit(1);
}

// Use the most recently modified file
const latest = files.sort((a, b) => {
  return fs.statSync(path.join(outputDir, b)).mtimeMs - fs.statSync(path.join(outputDir, a)).mtimeMs;
})[0];
const jsonPath = path.join(outputDir, latest);
const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

const priorityColor = { must: "#ef4444", should: "#f59e0b", optional: "#22c55e" };
const confidenceColor = { high: "#22c55e", medium: "#f59e0b", low: "#ef4444" };

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tender Extractor — ${data.tenderName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  header { background: #1e293b; border-bottom: 1px solid #334155; padding: 20px 32px; display: flex; align-items: center; justify-content: space-between; }
  header h1 { font-size: 18px; font-weight: 700; color: #f1f5f9; }
  header h1 span { color: #60a5fa; }
  .meta { display: flex; gap: 24px; }
  .meta-item { text-align: center; }
  .meta-item .val { font-size: 22px; font-weight: 700; color: #60a5fa; }
  .meta-item .lbl { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; }
  .controls { padding: 16px 32px; display: flex; gap: 12px; align-items: center; background: #1e293b; border-bottom: 1px solid #334155; }
  .controls button { background: #334155; border: none; color: #e2e8f0; padding: 7px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; transition: background .15s; }
  .controls button:hover { background: #475569; }
  .search { background: #0f172a; border: 1px solid #334155; color: #e2e8f0; padding: 7px 14px; border-radius: 6px; font-size: 13px; width: 280px; outline: none; }
  .search:focus { border-color: #60a5fa; }
  #tree { padding: 24px 32px; }
  .node { margin-bottom: 4px; }
  .node-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 8px; cursor: pointer; transition: background .12s; user-select: none; }
  .node-header:hover { background: #1e293b; }
  .toggle { width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; color: #64748b; font-size: 11px; flex-shrink: 0; transition: transform .15s; }
  .toggle.open { transform: rotate(90deg); }
  .toggle.leaf { cursor: default; color: #334155; }
  .level-1 > .node-header { background: #1e293b; border: 1px solid #334155; }
  .level-1 > .node-header:hover { background: #263347; }
  .level-2 > .node-header { background: #172033; }
  .level-3 > .node-header { background: transparent; }
  .bullet { font-weight: 600; font-size: 14px; flex: 1; }
  .level-1 .bullet { font-size: 15px; color: #f1f5f9; }
  .level-2 .bullet { font-size: 14px; color: #cbd5e1; }
  .level-3 .bullet { font-size: 13px; color: #94a3b8; font-weight: 400; }
  .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 99px; text-transform: uppercase; letter-spacing: .04em; flex-shrink: 0; }
  .badge-must { background: #3f1515; color: #f87171; }
  .badge-should { background: #3d2d08; color: #fbbf24; }
  .badge-optional { background: #0f2d1a; color: #4ade80; }
  .badge-high { background: #0f2d1a; color: #4ade80; }
  .badge-medium { background: #3d2d08; color: #fbbf24; }
  .badge-low { background: #3f1515; color: #f87171; }
  .chunk-ids { font-size: 10px; color: #475569; font-family: monospace; }
  .children { padding-left: 28px; border-left: 1px solid #1e293b; margin-left: 20px; }
  .detail-panel { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin: 6px 0 6px 46px; display: none; }
  .detail-panel.visible { display: block; }
  .detail-row { display: flex; gap: 8px; margin-bottom: 8px; font-size: 13px; }
  .detail-label { color: #64748b; min-width: 120px; font-size: 12px; }
  .detail-value { color: #cbd5e1; }
  .eq-true { color: #4ade80; } .eq-false { color: #f87171; } .eq-null { color: #64748b; }
  .count-chip { font-size: 11px; color: #64748b; background: #0f172a; border: 1px solid #1e293b; border-radius: 99px; padding: 1px 8px; flex-shrink: 0; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<header>
  <h1>BOND/JUHUU Tender Extractor — <span>${data.tenderName.replace(/_/g," ")}</span></h1>
  <div class="meta">
    <div class="meta-item"><div class="val">${data.totalChunks}</div><div class="lbl">Chunks</div></div>
    <div class="meta-item"><div class="val">${data.rawRequirementCount}</div><div class="lbl">Raw reqs</div></div>
    <div class="meta-item"><div class="val">${data.consolidatedRequirementCount}</div><div class="lbl">Consolidated</div></div>
    <div class="meta-item"><div class="val">${data.tree.length}</div><div class="lbl">L1 nodes</div></div>
    <div class="meta-item"><div class="val">${data.tree.reduce((s,n)=>s+n.deliverableArray.length,0)}</div><div class="lbl">L2 nodes</div></div>
    <div class="meta-item"><div class="val">${data.tree.reduce((s,n)=>s+n.deliverableArray.reduce((s2,n2)=>s2+n2.deliverableArray.length,0),0)}</div><div class="lbl">L3 leaves</div></div>
    <div class="meta-item"><div class="val" style="font-size:14px;color:#94a3b8">${new Date(data.extractedAt).toLocaleDateString()}</div><div class="lbl">Extracted</div></div>
  </div>
</header>
<div class="controls">
  <input class="search" type="text" placeholder="Search requirements…" id="search" oninput="filterTree(this.value)">
  <button onclick="expandAll()">Expand All</button>
  <button onclick="collapseAll()">Collapse All</button>
</div>
<div id="tree"></div>
<script>
const data = ${JSON.stringify(data)};

function badge(cls, val) {
  if (!val) return "";
  return \`<span class="badge badge-\${val}">\${val}</span>\`;
}

function renderNode(node, level) {
  const hasChildren = node.deliverableArray && node.deliverableArray.length > 0;
  const isLeaf = level === 3 || !hasChildren;
  const id = "n" + Math.random().toString(36).slice(2);
  const chunkStr = (node.procurementDocumentChunkIdArray||[]).join(", ");

  let inner = "";
  if (hasChildren) {
    inner = node.deliverableArray.map(c => renderNode(c, level+1)).join("");
  }

  const toggle = isLeaf
    ? \`<span class="toggle leaf">●</span>\`
    : \`<span class="toggle open" id="t\${id}">▶</span>\`;

  const detail = isLeaf ? \`
    <div class="detail-panel visible" id="d\${id}">
      <div class="detail-row"><span class="detail-label">Description</span><span class="detail-value">\${(node.description&&node.description.en)||""}</span></div>
      <div class="detail-row"><span class="detail-label">Priority</span>\${badge("priority", node.priority)}</div>
      <div class="detail-row"><span class="detail-label">Confidence</span>\${badge("confidence", node.confidence||"")}</div>
      <div class="detail-row"><span class="detail-label">Equivalence</span><span class="\${node.equivalenceAllowed===true?"eq-true":node.equivalenceAllowed===false?"eq-false":"eq-null"}">\${node.equivalenceAllowed===null?"not specified":String(node.equivalenceAllowed)}</span></div>
      \${chunkStr ? \`<div class="detail-row"><span class="detail-label">Source chunks</span><span class="detail-value" style="font-family:monospace;font-size:11px">\${chunkStr}</span></div>\` : ""}
    </div>\` : "";

  const countChip = hasChildren ? \`<span class="count-chip">\${node.deliverableArray.length}</span>\` : "";

  return \`<div class="node level-\${level}" id="\${id}" data-text="\${(node.bulletPoint||"").toLowerCase()}">
    <div class="node-header" onclick="toggle('\${id}')">
      \${toggle}
      <span class="bullet">\${node.bulletPoint||""}</span>
      \${countChip}
      \${level>=3?badge("priority",node.priority):""}
      \${level>=3&&node.confidence?badge("confidence",node.confidence):""}
      \${chunkStr&&level>=3?'<span class="chunk-ids">'+chunkStr+'</span>':""}
    </div>
    \${detail}
    \${hasChildren ? \`<div class="children" id="c\${id}">\${inner}</div>\` : ""}
  </div>\`;
}

document.getElementById("tree").innerHTML = data.tree.map(n => renderNode(n, 1)).join("");

function toggle(id) {
  const children = document.getElementById("c"+id);
  const tgl = document.getElementById("t"+id);
  const detail = document.getElementById("d"+id);
  if (children) {
    const hidden = children.style.display === "none";
    children.style.display = hidden ? "" : "none";
    if (tgl) tgl.classList.toggle("open", hidden);
  }
  if (detail) detail.classList.toggle("visible");
}

function expandAll() {
  document.querySelectorAll(".children").forEach(el => el.style.display = "");
  document.querySelectorAll(".toggle:not(.leaf)").forEach(el => el.classList.add("open"));
}

function collapseAll() {
  document.querySelectorAll(".children").forEach(el => el.style.display = "none");
  document.querySelectorAll(".toggle:not(.leaf)").forEach(el => el.classList.remove("open"));
}

function filterTree(q) {
  q = q.toLowerCase().trim();
  if (!q) {
    document.querySelectorAll(".node").forEach(n => n.classList.remove("hidden"));
    return;
  }
  document.querySelectorAll(".node").forEach(n => {
    const text = n.getAttribute("data-text") || "";
    const desc = (n.querySelector(".detail-value")||{}).textContent || "";
    n.classList.toggle("hidden", !text.includes(q) && !desc.toLowerCase().includes(q));
  });
}
</script>
</body>
</html>`;

const outPath = path.join(outputDir, latest.replace("_extracted.json", "_viewer.html"));
fs.writeFileSync(outPath, html, "utf-8");
console.log("Viewer written to:", outPath);
