import { z } from "zod";

// schema for what the extractor LLM returns
export const RawRequirementSchema = z.object({
  bulletPoint:         z.string().min(3).max(120),
  descriptionEn:       z.string().min(10),
  descriptionOriginal: z.string().optional(),
  priority:            z.enum(["must", "should", "optional"]),
  confidence:          z.enum(["high", "medium", "low"]),
  equivalenceAllowed:  z.boolean().nullable(),
  sourceChunkIds:      z.array(z.string()).min(1),
  suggestedL1Category: z.string().min(2),
  suggestedL2Category: z.string().min(2),
});

export const RawRequirementArraySchema = z.object({
  requirements: z.array(RawRequirementSchema),
});

export type RawRequirementLLMOutput = z.infer<typeof RawRequirementArraySchema>;

// schema for what the consolidator LLM returns
export const ConsolidationGroupSchema = z.object({
  representativeId:    z.string(),
  mergedIds:           z.array(z.string()).min(1),
  mergedBulletPoint:   z.string().min(3).max(120),
  mergedDescriptionEn: z.string().min(10),
  priority:            z.enum(["must", "should", "optional"]),
  confidence:          z.enum(["high", "medium", "low"]),
  equivalenceAllowed:  z.boolean().nullable(),
});

export const ConsolidationOutputSchema = z.object({
  groups: z.array(ConsolidationGroupSchema),
});

export type ConsolidationLLMOutput = z.infer<typeof ConsolidationOutputSchema>;
