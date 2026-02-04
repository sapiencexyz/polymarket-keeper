/**
 * LLM prompt templates for market enrichment
 */

import type { SapienceCategorySlug } from '../types';
import type { MarketEnrichmentInput } from './types';

export const VALID_CATEGORIES: SapienceCategorySlug[] = [
  'crypto',
  'weather',
  'tech-science',
  'economy-finance',
  'geopolitics',
  'sports',
  'culture',
];

export function buildEnrichmentPrompt(markets: MarketEnrichmentInput[]): string {
  const marketsJson = markets.map((m) => ({
    id: m.conditionId,
    q: m.question,
    desc: m.description?.slice(0, 150),
    event: m.eventTitle,
  }));

  return `Categorize prediction markets and generate short names.

CATEGORIES: ${VALID_CATEGORIES.join(', ')}

RULES for "name" (shortName):
- MUST be under 20 characters
- Use abbreviations: vs, @, &
- Team abbreviations: LAL, BOS, NYK, etc.
- Drop articles (the, a, an)
- Examples:
  - "Will Lakers beat Celtics?" -> "LAL vs BOS"
  - "Bitcoin above $100k by Dec?" -> "BTC $100k Dec"
  - "Fed rate cut January?" -> "Fed Rate Jan"
  - "Trump wins 2024 election?" -> "Trump 2024"

MARKETS:
${JSON.stringify(marketsJson, null, 2)}

Respond ONLY with valid JSON array, no markdown:
[{"id":"<conditionId>","cat":"<category>","name":"<shortName under 20 chars>"}]`;
}

export const SYSTEM_PROMPT =
  'You are a prediction market categorization assistant. Respond only with valid JSON arrays. No markdown code blocks.';
