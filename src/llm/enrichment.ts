/**
 * Market enrichment with LLM - batching, caching, and fallback logic
 */

import type { PolymarketMarket } from '../types';
import type { MarketEnrichmentInput, MarketEnrichmentOutput, EnrichmentResult } from './types';
import { inferSapienceCategorySlug } from '../generate/category';
import { callOpenRouter } from './openrouter';
import { parseOutcomes } from '../generate/transform';

const LLM_BATCH_SIZE = 20;

// In-memory cache for current run
const enrichmentCache = new Map<string, MarketEnrichmentOutput>();

export function marketToEnrichmentInput(market: PolymarketMarket): MarketEnrichmentInput {
  return {
    conditionId: market.conditionId,
    question: market.question,
    description: market.description || '',
    slug: market.slug,
    eventTitle: market.events?.[0]?.title,
    outcomes: parseOutcomes(market.outcomes),
  };
}

export function getFallbackEnrichment(market: PolymarketMarket): MarketEnrichmentOutput {
  return {
    conditionId: market.conditionId,
    category: inferSapienceCategorySlug(market),
    shortName: market.question.slice(0, 20),
  };
}

export async function enrichMarkets(
  markets: PolymarketMarket[],
  apiKey: string,
  model?: string
): Promise<EnrichmentResult> {
  const results = new Map<string, MarketEnrichmentOutput>();
  const errors: string[] = [];
  let usedFallback = false;

  // Check cache first
  const uncachedMarkets: PolymarketMarket[] = [];
  for (const market of markets) {
    const cached = enrichmentCache.get(market.conditionId);
    if (cached) {
      results.set(market.conditionId, cached);
    } else {
      uncachedMarkets.push(market);
    }
  }

  if (uncachedMarkets.length === 0) {
    return { results, errors, usedFallback: false };
  }

  // Process in batches
  const batches: PolymarketMarket[][] = [];
  for (let i = 0; i < uncachedMarkets.length; i += LLM_BATCH_SIZE) {
    batches.push(uncachedMarkets.slice(i, i + LLM_BATCH_SIZE));
  }

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    console.log(`[LLM] Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} markets)`);

    try {
      const inputs = batch.map(marketToEnrichmentInput);
      const outputs = await callOpenRouter(inputs, { apiKey, model });

      // Map outputs back and cache
      for (const output of outputs) {
        results.set(output.conditionId, output);
        enrichmentCache.set(output.conditionId, output);
      }

      // Fallback for any markets not in output
      for (const market of batch) {
        if (!results.has(market.conditionId)) {
          const fallback = getFallbackEnrichment(market);
          results.set(market.conditionId, fallback);
          usedFallback = true;
          console.log(`[LLM] Missing in response, using fallback for: ${market.conditionId}`);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push(`Batch ${batchIndex + 1} failed: ${errorMsg}`);
      console.error(`[LLM] Batch ${batchIndex + 1} failed, using fallback: ${errorMsg}`);

      // Use fallback for entire batch
      for (const market of batch) {
        if (!results.has(market.conditionId)) {
          results.set(market.conditionId, getFallbackEnrichment(market));
        }
      }
      usedFallback = true;
    }
  }

  return { results, errors, usedFallback };
}

/**
 * Main entry point - handles LLM disabled case
 */
export async function enrichMarketsWithLLM(
  markets: PolymarketMarket[],
  options: { enabled: boolean; apiKey?: string; model?: string }
): Promise<Map<string, MarketEnrichmentOutput>> {
  // If LLM disabled or no API key, use fallback for all
  if (!options.enabled || !options.apiKey) {
    const results = new Map<string, MarketEnrichmentOutput>();
    for (const market of markets) {
      results.set(market.conditionId, getFallbackEnrichment(market));
    }
    console.log(`[LLM] Disabled or no API key, using regex fallback for ${markets.length} markets`);
    return results;
  }

  console.log(`[LLM] Enriching ${markets.length} markets via OpenRouter...`);

  const result = await enrichMarkets(markets, options.apiKey, options.model);

  if (result.usedFallback) {
    console.log(`[LLM] Warning: Used fallback for some markets. Errors: ${result.errors.join(', ')}`);
  }

  console.log(`[LLM] Enriched ${result.results.size} markets (${result.errors.length} errors)`);
  return result.results;
}
