/**
 * LLM enrichment types
 */

import type { SapienceCategorySlug } from '../types';

export interface MarketEnrichmentInput {
  conditionId: string;
  question: string;
  description: string;
  slug: string;
  eventTitle?: string;
  outcomes: string[];
}

export interface MarketEnrichmentOutput {
  conditionId: string;
  category: SapienceCategorySlug;
  shortName: string;
}

export interface EnrichmentResult {
  results: Map<string, MarketEnrichmentOutput>;
  errors: string[];
  usedFallback: boolean;
}

/** Raw LLM response item */
export interface LLMResponseItem {
  id: string;
  cat: string;
  name: string;
}
