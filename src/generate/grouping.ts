/**
 * Market grouping and transformation logic
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import type {
  PolymarketMarket,
  SapienceCondition,
  SapienceConditionGroup,
  SapienceOutput,
  SapienceCategorySlug,
} from '../types';
import { CHAIN_ID_ETHEREAL } from '../constants';
import { inferSapienceCategorySlug } from './category';
import { transformMatchQuestion, getPolymarketUrl } from './transform';
import {
  runPipeline,
  printPipelineStats,
  GROUP_FILTERS,
  UNGROUPED_MARKET_FILTERS,
  type MarketGroup,
} from './pipeline';

/**
 * Compute group category by majority vote from its conditions
 */
export function computeGroupCategory(conditions: SapienceCondition[]): SapienceCategorySlug {
  const counts = new Map<SapienceCategorySlug, number>();

  for (const condition of conditions) {
    counts.set(condition.categorySlug, (counts.get(condition.categorySlug) || 0) + 1);
  }

  // Find category with most votes
  let maxCount = 0;
  let majorityCategory: SapienceCategorySlug = 'geopolitics';

  for (const [category, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      majorityCategory = category;
    }
  }

  return majorityCategory;
}

export function transformToSapienceCondition(market: PolymarketMarket, groupTitle?: string): SapienceCondition {
  // Transform "X vs Y" questions to "X beats Y?" for clarity
  const question = transformMatchQuestion(market);

  return {
    conditionHash: market.conditionId,  // Use Polymarket's conditionId directly
    question,
    shortName: question,  // Use transformed question as shortName
    endDate: market.endDate,
    description: market.description || '',
    similarMarkets: [getPolymarketUrl(market)],
    categorySlug: inferSapienceCategorySlug(market),
    chainId: CHAIN_ID_ETHEREAL,
    groupTitle,
  };
}

export function groupMarkets(markets: PolymarketMarket[]): SapienceOutput {
  const allGroups: MarketGroup[] = [];
  const ungrouped: PolymarketMarket[] = [];

  // Each market with an event becomes its own group entry (not bundled with other markets from same event)
  for (const market of markets) {
    const event = market.events?.[0];

    if (event?.title) {
      // Each market is its own "group" with 1 market
      allGroups.push({
        title: event.title,
        markets: [market],
        eventSlug: event.slug,
      });
    } else {
      ungrouped.push(market);
    }
  }

  // Apply group filters pipeline (volume OR always-include)
  const { output: filteredGroups, stats: groupStats } = runPipeline(
    allGroups,
    GROUP_FILTERS,
    { verbose: false }
  );
  printPipelineStats(groupStats, 'Group Pipeline');

  // Apply ungrouped market filters pipeline
  const { output: filteredUngrouped, stats: ungroupedStats } = runPipeline(
    ungrouped,
    UNGROUPED_MARKET_FILTERS,
    { verbose: false }
  );
  printPipelineStats(ungroupedStats, 'Ungrouped Pipeline');

  // Transform single-market groups to SapienceConditionGroup[]
  const conditionGroups: SapienceConditionGroup[] = [];

  for (const group of filteredGroups) {
    const market = group.markets[0]; // Each group has exactly 1 market now
    const condition = transformToSapienceCondition(market, group.title);

    // Use event description if available, otherwise use market's description
    const event = market.events?.[0];
    const groupDescription = event?.description?.split('\n')[0] ||
                            market.description?.split('\n')[0] ||
                            group.title;

    conditionGroups.push({
      title: group.title,
      description: groupDescription,
      categorySlug: condition.categorySlug,
      similarMarkets: [`https://polymarket.com#${group.eventSlug}`],
      conditions: [condition],
    });
  }

  // Create ungrouped conditions from markets without events
  const ungroupedConditions = filteredUngrouped.map(m => transformToSapienceCondition(m));

  // Count total conditions after filtering
  const totalConditions = conditionGroups.reduce((sum, g) => sum + g.conditions.length, 0) + ungroupedConditions.length;

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      source: 'Polymarket Gamma API',
      totalConditions,
      totalGroups: conditionGroups.length,
      binaryConditions: totalConditions,
    },
    groups: conditionGroups,
    ungroupedConditions,
  };
}

export function exportJSON(data: SapienceOutput, filename: string = 'sapience-conditions.json'): void {
  const outputPath = join(process.cwd(), filename);
  writeFileSync(outputPath, JSON.stringify(data, null, 2));
  console.log(`Exported to ${outputPath}`);
}
