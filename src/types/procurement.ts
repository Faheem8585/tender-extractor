// ============================================================
// types/procurement.ts
// Official interface from BOND/JUHUU assessment brief.
// The same shape is used at all three levels of the tree.
// Children hang off `deliverableArray`.
// ============================================================

export type LocaleObject<T> = {
  en?: T;
  de?: T;
  [locale: string]: T | undefined;
};

/**
 * One node of the requirement tree.
 * Level 1 / Level 2 are grouping nodes.
 * Level 3 leaves carry the actual requirement.
 */
export interface ProcurementMatchDeliverable {
  bulletPoint: string;

  description: LocaleObject<string>;

  /** "must" = mandatory knock-out, "should" = should-have, "optional" = nice-to-have */
  priority: "must" | "should" | "optional";

  /** Extractor's self-assessment — low confidence should flag for human review */
  confidence: "high" | "medium" | "low" | null;

  /**
   * Whether "or equivalent" is explicitly accepted for this deliverable/spec.
   * Null when the source is silent.
   */
  equivalenceAllowed: boolean | null;

  /** Not assessed in this pipeline — set to null */
  fullfillable: "yes" | "no" | "maybe" | null;

  /** Not assessed in this pipeline — set to default */
  status:
    | "waitingForAnalysis"
    | "waitingForAnswer"
    | "waitingForAnswerPropagation"
    | "waitingForReview"
    | "userDefined";

  /** Not assessed in this pipeline — set to null */
  aiReasoning: LocaleObject<string> | null;

  /** Not assessed in this pipeline — set to null */
  feedback: "good" | "bad" | null;

  feedbackText: string | null;

  openQuestionId: string | null;

  /** Children of this node. Empty array on Level 3 leaves. */
  deliverableArray: ProcurementMatchDeliverable[];

  /**
   * Source chunks this deliverable was extracted from.
   * ALL chunks for one requirement pulled together here,
   * however far apart in the document they sit.
   */
  procurementDocumentChunkIdArray: string[];

  /** Not populated in this pipeline */
  workspaceDocumentChunkIdArray: string[];

  /** Not populated in this pipeline — only on leaves */
  citedProductIdArray: string[];

  /** Not populated in this pipeline — only on leaves */
  citedPersonIdArray: string[];
}

// ============================================================
// Internal pipeline types (not part of the official interface)
// ============================================================

/** A parsed chunk of text from a PDF page */
export interface DocumentChunk {
  chunkId: string;        // e.g. "doc1_p60_chunk3"
  documentName: string;   // e.g. "tender_main.pdf"
  documentIndex: number;  // 0-based index among all input docs
  pageNumber: number;
  chunkIndex: number;     // within the page
  text: string;
  charCount: number;
}

/** A single raw requirement extracted from one or more chunks by the LLM */
export interface RawRequirement {
  rawId: string;
  bulletPoint: string;
  descriptionEn: string;
  descriptionOriginal?: string;   // preserved if tender is not in English
  priority: "must" | "should" | "optional";
  confidence: "high" | "medium" | "low";
  equivalenceAllowed: boolean | null;
  sourceChunkIds: string[];       // which chunks this came from
  suggestedL1Category: string;    // LLM's hint for grouping
  suggestedL2Category: string;
}

/** A requirement after cross-document consolidation */
export interface ConsolidatedRequirement extends RawRequirement {
  consolidatedId: string;
  mergedFromIds: string[];        // all rawIds that were merged into this
}

/** Result of the full pipeline run */
export interface PipelineResult {
  tenderName: string;
  extractedAt: string;
  documentCount: number;
  totalChunks: number;
  rawRequirementCount: number;
  consolidatedRequirementCount: number;
  tree: ProcurementMatchDeliverable[];
}
