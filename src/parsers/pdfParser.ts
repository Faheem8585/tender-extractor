// ============================================================
// parsers/pdfParser.ts
// Reads one or more PDF files and produces DocumentChunk[].
// Each chunk is a slice of a page with a stable unique ID.
// ============================================================

import * as fs from "fs";
import * as path from "path";
import pdfParse from "pdf-parse";
import { DocumentChunk } from "../types/procurement";

const CHUNK_SIZE_CHARS = parseInt(process.env.CHUNK_SIZE_CHARS ?? "3000", 10);
const CHUNK_OVERLAP_CHARS = parseInt(process.env.CHUNK_OVERLAP_CHARS ?? "300", 10);

/**
 * Parse a single PDF file into DocumentChunks.
 *
 * Strategy: extract full text page-by-page, then split each page
 * into overlapping chunks of ~CHUNK_SIZE_CHARS characters.
 * Overlap preserves context that would otherwise be cut at a boundary.
 */
export async function parsePdf(
  filePath: string,
  documentIndex: number
): Promise<DocumentChunk[]> {
  const documentName = path.basename(filePath);
  console.log(`[PDF Parser] Reading: ${documentName}`);

  const buffer = fs.readFileSync(filePath);

  // pdf-parse gives us the full text; we use a custom page_render
  // callback to capture per-page text so our chunkIds carry pageNumbers.
  const pageTexts: string[] = [];

  await pdfParse(buffer, {
    // Called once per page; we collect text in order
    pagerender: (pageData: any) => {
      return pageData.getTextContent().then((textContent: any) => {
        const pageText = textContent.items
          .map((item: any) => item.str)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        pageTexts.push(pageText);
        return pageText;
      });
    },
  });

  console.log(
    `[PDF Parser] ${documentName} — ${pageTexts.length} pages extracted`
  );

  const chunks: DocumentChunk[] = [];

  for (let pageIndex = 0; pageIndex < pageTexts.length; pageIndex++) {
    const pageNumber = pageIndex + 1;
    const pageText = pageTexts[pageIndex];

    if (!pageText || pageText.length < 10) {
      // Skip effectively empty pages (cover pages, blank pages, etc.)
      continue;
    }

    const pageChunks = splitIntoChunks(pageText, CHUNK_SIZE_CHARS, CHUNK_OVERLAP_CHARS);

    for (let chunkIndex = 0; chunkIndex < pageChunks.length; chunkIndex++) {
      const chunkId = `doc${documentIndex}_p${pageNumber}_c${chunkIndex}`;
      chunks.push({
        chunkId,
        documentName,
        documentIndex,
        pageNumber,
        chunkIndex,
        text: pageChunks[chunkIndex],
        charCount: pageChunks[chunkIndex].length,
      });
    }
  }

  console.log(
    `[PDF Parser] ${documentName} — ${chunks.length} chunks produced ` +
      `(~${CHUNK_SIZE_CHARS} chars each, ${CHUNK_OVERLAP_CHARS} overlap)`
  );

  return chunks;
}

/**
 * Parse multiple PDFs and return a flat list of all chunks.
 * DocumentIndex is assigned per file so chunkIds are globally unique.
 */
export async function parseAllPdfs(filePaths: string[]): Promise<DocumentChunk[]> {
  console.log(`[PDF Parser] Processing ${filePaths.length} file(s)`);
  const allChunks: DocumentChunk[] = [];

  for (let i = 0; i < filePaths.length; i++) {
    const chunks = await parsePdf(filePaths[i], i);
    allChunks.push(...chunks);
  }

  console.log(
    `[PDF Parser] Total: ${allChunks.length} chunks across ${filePaths.length} document(s)`
  );

  return allChunks;
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Split text into overlapping chunks.
 * Tries to break on sentence or paragraph boundaries where possible.
 */
function splitIntoChunks(
  text: string,
  chunkSize: number,
  overlap: number
): string[] {
  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);

    // Try to snap to a sentence boundary (period + space) within last 20% of window
    if (end < text.length) {
      const snapZoneStart = end - Math.floor(chunkSize * 0.2);
      const snapIndex = text.lastIndexOf(". ", end);
      if (snapIndex > snapZoneStart) {
        end = snapIndex + 2; // include the period and space
      }
    }

    chunks.push(text.slice(start, end).trim());

    if (end >= text.length) break;

    // Next chunk starts with overlap so cross-boundary requirements aren't split
    start = end - overlap;
  }

  return chunks.filter((c) => c.length > 0);
}
