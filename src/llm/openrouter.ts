/**
 * OpenRouter API client
 */

import { fetchWithRetry } from '../utils';
import type { MarketEnrichmentInput, MarketEnrichmentOutput, LLMResponseItem } from './types';
import { buildEnrichmentPrompt, SYSTEM_PROMPT, VALID_CATEGORIES } from './prompts';
import type { SapienceCategorySlug } from '../types';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const TIMEOUT_MS = 30000;

interface OpenRouterConfig {
  apiKey: string;
  model?: string;
}

export async function callOpenRouter(
  markets: MarketEnrichmentInput[],
  config: OpenRouterConfig
): Promise<MarketEnrichmentOutput[]> {
  const prompt = buildEnrichmentPrompt(markets);
  const model = config.model || DEFAULT_MODEL;

  const response = await fetchWithRetry(
    OPENROUTER_API_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        'HTTP-Referer': 'https://sapience.xyz',
        'X-Title': 'polymarket-keeper',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
    3,
    1000
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';

  return parseResponse(content, markets);
}

function parseResponse(
  content: string,
  markets: MarketEnrichmentInput[]
): MarketEnrichmentOutput[] {
  // Extract JSON from response (handle potential markdown code blocks)
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`No valid JSON array in LLM response: ${content.slice(0, 200)}`);
  }

  let parsed: LLMResponseItem[];
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`Failed to parse LLM JSON: ${e}`);
  }

  const marketMap = new Map(markets.map((m) => [m.conditionId, m]));

  return parsed
    .filter((item) => marketMap.has(item.id))
    .map((item) => {
      const category = VALID_CATEGORIES.includes(item.cat as SapienceCategorySlug)
        ? (item.cat as SapienceCategorySlug)
        : 'geopolitics';

      // Enforce 20 char limit
      const shortName = (item.name || '').slice(0, 20) || marketMap.get(item.id)!.question.slice(0, 20);

      return {
        conditionId: item.id,
        category,
        shortName,
      };
    });
}
