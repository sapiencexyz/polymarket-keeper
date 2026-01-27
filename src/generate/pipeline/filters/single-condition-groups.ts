/**
 * Filter: Identify single-market groups (to be moved to ungrouped)
 */

import type { Filter, FilterResult } from '../types';
import type { MarketGroup } from './volume-threshold';

/**
 * Filter out groups with only one market
 * These will be moved to ungrouped conditions
 */
export class SingleMarketGroupFilter implements Filter<MarketGroup> {
  name = 'single-market-groups';
  description = 'Remove groups with only 1 market (moved to ungrouped)';

  apply(groups: MarketGroup[]): FilterResult<MarketGroup> {
    const kept: MarketGroup[] = [];
    const removed: MarketGroup[] = [];

    for (const group of groups) {
      if (group.markets.length > 1) {
        kept.push(group);
      } else {
        removed.push(group);
      }
    }

    return { kept, removed };
  }
}
