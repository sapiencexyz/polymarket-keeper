/**
 * Filter combinators for composing filters with different logic
 */

import type { Filter, FilterResult } from './types';

/**
 * UnionFilter: Keep items that pass ANY of the sub-filters (OR logic)
 *
 * Use this when you want to keep items that match at least one condition.
 * Each sub-filter can be tested and reused independently.
 */
export class UnionFilter<T> implements Filter<T> {
  name: string;
  description: string;

  constructor(private filters: Filter<T>[]) {
    this.name = filters.map(f => f.name).join('-or-');
    this.description = `Keep items matching: ${filters.map(f => f.name).join(' OR ')}`;
  }

  apply(items: T[]): FilterResult<T> {
    const kept: T[] = [];
    const removed: T[] = [];

    for (const item of items) {
      // Keep if ANY filter would keep this item
      const wouldKeep = this.filters.some(f => f.apply([item]).kept.length > 0);
      if (wouldKeep) {
        kept.push(item);
      } else {
        removed.push(item);
      }
    }

    return { kept, removed };
  }
}
