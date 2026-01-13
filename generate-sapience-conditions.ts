#!/usr/bin/env tsx
/// <reference types="node" />
/**
 * Generate Sapience condition groups and conditions from Polymarket markets
 * 
 * This script fetches Polymarket markets ending within 24 hours and formats them 
 * for the Sapience database:
 * - Uses Polymarket's conditionId as the Sapience conditionHash
 * - Groups related markets into ConditionGroups by event
 * - Transforms match questions ("X vs Y") to clear "X beats Y?" format
 * - Optionally submits to Sapience API if SAPIENCE_API_URL and ADMIN_PRIVATE_KEY are set
 * 
 * Usage: 
 *   tsx generate-sapience-conditions.ts
 *   tsx generate-sapience-conditions.ts --dry-run
 * 
 * Options:
 *   --dry-run  Show what would be submitted without actually submitting
 *   --help     Show this help message
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { privateKeyToAccount } from 'viem/accounts';
import 'dotenv/config';


// Admin authentication message (used for signing admin API requests)
const ADMIN_AUTHENTICATE_MSG = 'Sign this message to authenticate for admin actions.';

// ============ CLI Arguments ============

interface CLIOptions {
  dryRun: boolean;
  help: boolean;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function showHelp(): void {
  console.log(`
Usage: tsx generate-sapience-conditions.ts [options]

Fetches markets ending within 24 hours from Polymarket and submits them to the Sapience API.

Options:
  --dry-run      Show what would be submitted without actually submitting
  --help, -h     Show this help message

Environment Variables (required for API submission):
  SAPIENCE_API_URL     API URL to submit conditions (default: https://api.sapience.xyz)
  ADMIN_PRIVATE_KEY    64-char hex private key for signing admin requests

Examples:
  # Generate JSON file only
  tsx generate-sapience-conditions.ts

  # Dry run - show what would be submitted
  tsx generate-sapience-conditions.ts --dry-run

  # Fetch and push to API
  SAPIENCE_API_URL=http://localhost:3001 ADMIN_PRIVATE_KEY=abc123... \\
    tsx generate-sapience-conditions.ts
`); 
}

// ============ Constants ============

// Placeholder resolver address - update this with actual resolver contract address
const RESOLVER_ADDRESS = '0x04aD4e8AE0F828E4BeA2C86165a7800Db499e0F5' as const;

const DEFAULT_SAPIENCE_API_URL = 'https://api.sapience.xyz';

// Ethereal chain ID (from @sapience/sdk/constants/chain.ts)
const CHAIN_ID_ETHEREAL = 5064014 as const;

// Minimum volume threshold (in USD) for including markets
const MIN_VOLUME_THRESHOLD = 50_000;

// ============ Types ============

interface PolymarketMarket {
  id: string;
  question: string;
  conditionId: string;
  outcomes: string[] | string;
  volume: string;
  liquidity: string;
  endDate: string;
  description: string;
  slug: string;
  marketSlug?: string;  // Alternative slug field
  url?: string;  // Direct URL from API
  category?: string;
  questionID?: string;
  sportsMarketType?: string;
  events?: Array<{
    id?: string;
    title?: string;
    slug?: string;
    description?: string;
    seriesSlug?: string;
    series?: Array<{
      slug?: string;
      ticker?: string;
      title?: string;
    }>;
  }>;
  active: boolean;
  closed: boolean;
  groupItemTitle?: string;
  groupItemThreshold?: string;
  marketGroup?: string;
}

type SapienceCategorySlug =
  | 'crypto'
  | 'weather'
  | 'tech-science'
  | 'geopolitics'
  | 'economy-finance'
  | 'sports'
  | 'culture';

interface SapienceCondition {
  conditionHash: string;  // Polymarket's conditionId - used to resolve via LZ
  question: string;
  shortName: string;  // Short display name (using question since Polymarket doesn't provide one)
  categorySlug: SapienceCategorySlug;
  endDate: string;
  description: string;
  similarMarkets: string[];  // Polymarket URLs (slug is in the URL)
  chainId: number;  // Chain ID where condition will be deployed (Ethereal: 5064014)
  groupTitle?: string;  // Group title for API submission (API will find-or-create group by name)
}

interface SapienceConditionGroup {
  title: string;
  categorySlug: SapienceCategorySlug;
  description: string;
  conditions: SapienceCondition[];
}

interface SapienceOutput {
  metadata: {
    generatedAt: string;
    source: string;
    totalConditions: number;
    totalGroups: number;
    binaryConditions: number;
  };
  groups: SapienceConditionGroup[];
  ungroupedConditions: SapienceCondition[];
}

// ============ Category Inference ============

function inferSapienceCategorySlug(market: PolymarketMarket): SapienceCategorySlug {
  // Build normalized text for keyword matching
  const searchText = [
    market.question,
    market.slug,
    market.events?.[0]?.series?.[0]?.slug,
    market.events?.[0]?.series?.[0]?.title,
    market.events?.[0]?.seriesSlug,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  
  // 1. Sports: Check sportsMarketType or series slugs
  if (market.sportsMarketType || 
      /\b(nba|nfl|nhl|mlb|epl|premier-league|uefa|fifa|world-cup|super-bowl|bowl|playoff|championship|bundesliga|la-liga|serie-a|ligue-1|champions-league|valorant|league-of-legends|dota|soccer|football|basketball|baseball|hockey|tennis|golf|ufc|boxing|mma|formula-1|cricket|rugby|buccaneers|chiefs|eagles|49ers|cowboys|packers|patriots|lakers|warriors|celtics|yankees|dodgers|mets|red-sox)\b/.test(searchText)) {
    return 'sports';
  }
  
  // 2. Crypto: Check for crypto keywords
  if (/\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|crypto|cryptocurrency|blockchain|defi|nft|token|coin|satoshi)\b/.test(searchText)) {
    return 'crypto';
  }
  
  // 3. Weather: Check for weather/climate keywords
  if (/\b(weather|temperature|hottest|coldest|hurricane|tornado|flood|drought|rain|snow|climate|celsius|fahrenheit|el-nino)\b/.test(searchText)) {
    return 'weather';
  }
  
  // 4. Tech & Science: Check for tech/science keywords
  if (/\b(ai|artificial-intelligence|chatgpt|openai|tech|technology|science|nasa|space|spacex|tesla|apple|google|microsoft|amazon|meta|robot|quantum|semiconductor|chip)\b/.test(searchText)) {
    return 'tech-science';
  }
  
  // 5. Economy & Finance: Check for financial keywords
  if (/\b(stock|stocks|s&p|spx|dow|nasdaq|earning|market|fed|federal-reserve|interest-rate|inflation|gdp|economy|economic|finance|financial|bank|dollar|euro|yen|bond|treasury)\b/.test(searchText)) {
    return 'economy-finance';
  }
  
  // 6. Geopolitics: Check for politics/elections/war keywords
  if (/\b(election|president|presidential|senate|senator|congress|governor|prime-minister|parliament|vote|voting|poll|republican|democrat|party|political|politics|war|military|nato|ukraine|russia|china|israel|palestine|iran|korea|taiwan|diplomacy|treaty|sanction)\b/.test(searchText)) {
    return 'geopolitics';
  }
  
  // 7. Culture: Check for entertainment/celebrity keywords
  if (/\b(oscar|emmy|grammy|award|movie|film|music|album|celebrity|actor|actress|director|streaming|netflix|spotify|pop-culture|entertainment|fashion|art|artist)\b/.test(searchText)) {
    return 'culture';
  }
  
  // Default fallback: geopolitics (most common category for prediction markets)
  return 'geopolitics';
}

// ============ Utilities ============

function parseOutcomes(outcomes: string[] | string): string[] {
  if (Array.isArray(outcomes)) return outcomes;
  if (typeof outcomes === 'string') {
    try {
      const parsed = JSON.parse(outcomes);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function getPolymarketUrl(market: PolymarketMarket): string {
  // Simple reference URL with slug
  // Note: Polymarket URLs vary by market type (event, sports, etc.)
  // so we just provide a reference with the slug identifier
  return `https://polymarket.com#${market.slug}`;
}

/**
 * Transform sports market questions to clearer formats:
 * - "X vs. Y" → "X beats Y? (context)"
 * - "Spread: Team (-X.5)" → "Team covers -X.5 spread vs Opponent?"
 * - "Map Handicap: Team (-X.5)" → "Team covers -X.5 handicap vs Opponent?"
 * 
 * Preserves prefix/suffix context from original question.
 * The first outcome in Polymarket = "Yes" = first team wins/covers
 */
function transformMatchQuestion(market: PolymarketMarket): string {
  const outcomes = parseOutcomes(market.outcomes);
  
  // Skip if not exactly 2 outcomes
  if (outcomes.length !== 2) return market.question;
  
  // Skip if outcomes are standard Yes/No or Over/Under (not team names)
  const standardOutcomes = ['Yes', 'No', 'Over', 'Under'];
  if (standardOutcomes.includes(outcomes[0]) || standardOutcomes.includes(outcomes[1])) {
    return market.question;
  }
  
  // Detect spread markets: "1H Spread: Team (-X.5)" or "Spread: Team (-X.5)"
  const spreadMatch = market.question.match(/^(?:(\S+)\s+)?Spread:\s*.+?\s*\(([+-]?\d+(?:\.\d+)?)\)$/i);
  if (spreadMatch) {
    const [, prefix, spread] = spreadMatch;
    const context = prefix ? ` (${prefix})` : '';
    const transformed = `${outcomes[0]} covers ${spread} spread vs ${outcomes[1]}?${context}`;
    console.log(`[Transform Spread] "${market.question}" → "${transformed}"`);
    return transformed;
  }
  
  // Detect handicap markets: "Map Handicap: Team (-X.5)" or "Handicap: Team (-X.5)"
  const handicapMatch = market.question.match(/^(?:(\S+)\s+)?(?:Map\s+)?Handicap:\s*.+?\s*\(([+-]?\d+(?:\.\d+)?)\)$/i);
  if (handicapMatch) {
    const [, prefix, handicap] = handicapMatch;
    const context = prefix ? ` (${prefix})` : '';
    const transformed = `${outcomes[0]} covers ${handicap} handicap vs ${outcomes[1]}?${context}`;
    console.log(`[Transform Handicap] "${market.question}" → "${transformed}"`);
    return transformed;
  }
  
  // Detect "X vs. Y" pattern with optional prefix and suffix
  // Patterns supported:
  //   "Prefix: Team1 vs Team2 (Suffix)" - e.g., "LoL: GnG vs FN (BO3)"
  //   "Prefix: Team1 vs Team2 - Suffix" - e.g., "CS: Aurora vs HOTU - Map 1 Winner"
  //   "Team1 vs Team2: Suffix" - e.g., "Suns vs Heat: 1H Moneyline"
  //   "Team1 vs Team2 (Suffix)" - e.g., "Team1 vs Team2 (W)"
  const vsMatch = market.question.match(
    /^(?:(.+?):\s+)?(.+?)\s+vs\.?\s+(.+?)(?::\s+(.+?))?(?:\s+-\s+(.+?))?(?:\s+\((.+?)\))?$/i
  );
  if (!vsMatch) return market.question;
  
  const [, prefix, , , colonSuffix, dashSuffix, parenSuffix] = vsMatch;
  
  // Build context string from prefix and suffixes
  const contextParts: string[] = [];
  if (prefix) contextParts.push(prefix);
  if (parenSuffix) contextParts.push(parenSuffix);
  if (dashSuffix) contextParts.push(dashSuffix);
  if (colonSuffix) contextParts.push(colonSuffix);
  
  const context = contextParts.length > 0 ? ` (${contextParts.join(', ')})` : '';
  
  // Log transformation for debugging
  const transformed = `${outcomes[0]} beats ${outcomes[1]}?${context}`;
  console.log(`[Transform] "${market.question}" → "${transformed}"`);
  
  // Rephrase: first outcome (Yes) beats second outcome (No)
  return transformed;
}


/**
 * Fetch markets that end soonest (for --ending-soon mode)
 * Orders by endDate ascending, no volume sorting
 * Iteratively fetches pages by moving end_date_min based on max endDate from previous response
 */
async function fetchEndingSoonestMarkets(): Promise<PolymarketMarket[]> {
  // Minimum end time: current time + 1 minute (ISO format for API)
  let currentMinEndDate = new Date(Date.now() + 60 * 1000).toISOString();
  // Maximum end time: current time + 24 hours
  const maxEndDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  
  const allMarkets: PolymarketMarket[] = [];
  const PAGE_SIZE = 500;
  let pageCount = 0;
  
  console.log(`[Polymarket] Fetching ending-soon markets until ${maxEndDate.toISOString()}...`);
  
  while (true) {
    pageCount++;
    const url = `https://gamma-api.polymarket.com/markets?limit=${PAGE_SIZE}&closed=false&order=endDate&ascending=true&end_date_min=${currentMinEndDate}`;
    
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.error(`[Polymarket API] Failed to fetch ending-soon markets: HTTP ${response.status} ${response.statusText}`);
      if (errorBody) console.error(`[Polymarket API] Response body: ${errorBody}`);
      throw new Error(`Polymarket API error: ${response.status} ${response.statusText}`);
    }

    const markets: PolymarketMarket[] = await response.json();
    
    if (markets.length === 0) {
      console.log(`[Polymarket] Page ${pageCount}: No more markets`);
      break;
    }
    
    // Find the max endDate in this batch to use as next page's min
    const maxEndDateInBatch = markets.reduce((max, m) => {
      const endDate = new Date(m.endDate);
      return endDate > max ? endDate : max;
    }, new Date(0));
    
    console.log(`[Polymarket] Page ${pageCount}: Fetched ${markets.length} markets (max endDate: ${maxEndDateInBatch.toISOString()})`);
    
    // Add markets that are within our time window
    const marketsInWindow = markets.filter(m => new Date(m.endDate) < maxEndDate);
    allMarkets.push(...marketsInWindow);
    
    // Stop conditions:
    // 1. Got less than PAGE_SIZE markets (no more pages)
    // 2. Max endDate in batch exceeds our window (all remaining markets are beyond our window)
    if (markets.length < PAGE_SIZE || maxEndDateInBatch >= maxEndDate) {
      break;
    }
    
    // Move the cursor to fetch next page (add 1ms to avoid duplicates)
    currentMinEndDate = new Date(maxEndDateInBatch.getTime() + 1).toISOString();
  }
  
  console.log(`[Polymarket] Total fetched: ${allMarkets.length} markets across ${pageCount} pages`);
  
  // Filter for binary markets only (volume filtering happens after grouping)
  const binaryMarkets = allMarkets
    .filter(m => parseOutcomes(m.outcomes).length === 2);
  
  console.log(`[Polymarket] Filtered to ${binaryMarkets.length} binary ending-soon markets`);
  
  return binaryMarkets;
}

// ============ Data Transformation ============

/**
 * Compute group category by majority vote from its conditions
 */
function computeGroupCategory(conditions: SapienceCondition[]): SapienceCategorySlug {
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

function transformToSapienceCondition(market: PolymarketMarket, groupTitle?: string): SapienceCondition {
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

function groupMarkets(markets: PolymarketMarket[]): SapienceOutput {
  const groupsMap = new Map<string, { markets: PolymarketMarket[]; eventSlug?: string }>();
  const ungrouped: PolymarketMarket[] = [];
  
  // Log event names for verification
  console.log('\n[Events] Discovered event titles:');
  const seenEvents = new Set<string>();
  
  // Separate grouped and ungrouped markets based on event data
  for (const market of markets) {
    const event = market.events?.[0];
    
    if (event?.title) {
      // Log unique event titles for readability verification
      if (!seenEvents.has(event.title)) {
        seenEvents.add(event.title);
        console.log(`  - "${event.title}" (slug: ${event.slug || 'N/A'})`);
      }
      
      // Use event title as the group title
      const groupTitle = event.title;
      
      if (!groupsMap.has(groupTitle)) {
        groupsMap.set(groupTitle, { markets: [], eventSlug: event.slug });
      }
      groupsMap.get(groupTitle)!.markets.push(market);
    } else {
      ungrouped.push(market);
    }
  }
  
  console.log(`[Events] Total unique events: ${seenEvents.size}\n`);
  
  // Apply volume filter: keep entire group if at least one market has sufficient volume
  const filteredGroupsMap = new Map<string, { markets: PolymarketMarket[]; eventSlug?: string }>();
  let groupsFilteredOut = 0;
  
  for (const [groupTitle, groupData] of groupsMap) {
    const hasHighVolumeMarket = groupData.markets.some(
      m => parseFloat(m.volume || '0') >= MIN_VOLUME_THRESHOLD
    );
    
    if (hasHighVolumeMarket) {
      filteredGroupsMap.set(groupTitle, groupData);
    } else {
      groupsFilteredOut++;
    }
  }
  
  // Filter ungrouped markets by volume
  const filteredUngrouped = ungrouped.filter(
    m => parseFloat(m.volume || '0') >= MIN_VOLUME_THRESHOLD
  );
  
  const ungroupedFilteredOut = ungrouped.length - filteredUngrouped.length;
  
  console.log(`[Volume Filter] Kept ${filteredGroupsMap.size} groups (filtered out ${groupsFilteredOut} low-volume groups)`);
  console.log(`[Volume Filter] Kept ${filteredUngrouped.length} ungrouped markets (filtered out ${ungroupedFilteredOut})`);
  
  // Create ConditionGroups
  const groups: SapienceConditionGroup[] = [];
  
  for (const [groupTitle, { markets: groupMarkets, eventSlug }] of filteredGroupsMap) {
    const conditions = groupMarkets.map(m => transformToSapienceCondition(m, groupTitle));
    
    // Use event description if available, otherwise use first market's description
    const event = groupMarkets[0]?.events?.[0];
    const groupDescription = event?.description?.split('\n')[0] || 
                            groupMarkets[0]?.description?.split('\n')[0] || 
                            groupTitle;
    
    // Compute group categorySlug by majority vote from conditions
    const categorySlug = computeGroupCategory(conditions);
    
    groups.push({
      title: groupTitle,
      description: groupDescription,
      categorySlug,
      conditions,
    });
  }
  
  // Sort groups by number of conditions (most popular)
  groups.sort((a, b) => b.conditions.length - a.conditions.length);
  
  // Move single-condition groups to ungrouped (no point creating a group for one condition)
  const singleConditionGroups = groups.filter(g => g.conditions.length === 1);
  const multiConditionGroups = groups.filter(g => g.conditions.length > 1);
  
  if (singleConditionGroups.length > 0) {
    console.log(`[Groups] Moving ${singleConditionGroups.length} single-condition groups to ungrouped`);
  }
  
  // Create ungrouped conditions (include conditions from single-condition groups without groupTitle)
  const ungroupedConditions = [
    ...filteredUngrouped.map(m => transformToSapienceCondition(m)),
    ...singleConditionGroups.flatMap(g => g.conditions.map(c => ({ ...c, groupTitle: undefined }))),
  ];
  
  // Count total conditions after filtering
  const totalConditions = multiConditionGroups.reduce((sum, g) => sum + g.conditions.length, 0) + ungroupedConditions.length;
  
  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      source: 'Polymarket Gamma API',
      totalConditions,
      totalGroups: multiConditionGroups.length,
      binaryConditions: totalConditions,
    },
    groups: multiConditionGroups,
    ungroupedConditions,
  };
}

// ============ Export Functions ============

function exportJSON(data: SapienceOutput, filename: string = 'sapience-conditions.json'): void {
  const outputPath = join(process.cwd(), filename);
  writeFileSync(outputPath, JSON.stringify(data, null, 2));
  console.log(`Exported to ${outputPath}`);
}

// ============ API Submission Functions ============

/**
 * Convert ISO date string to Unix timestamp (seconds)
 */
function toUnixTimestamp(isoDate: string): number {
  return Math.floor(new Date(isoDate).getTime() / 1000);
}

/**
 * Get admin auth headers by signing the authentication message
 * The API expects signature-based auth, not Bearer tokens
 */
async function getAdminAuthHeaders(privateKey: `0x${string}`): Promise<{
  'x-admin-signature': string;
  'x-admin-signature-timestamp': string;
}> {
  const account = privateKeyToAccount(privateKey);
  const timestampSeconds = Math.floor(Date.now() / 1000);
  const messageToSign = `${ADMIN_AUTHENTICATE_MSG}:${timestampSeconds}`;
  
  const signature = await account.signMessage({ message: messageToSign });
  
  return {
    'x-admin-signature': signature,
    'x-admin-signature-timestamp': String(timestampSeconds),
  };
}

/**
 * Submit a condition group to the API
 */
async function submitConditionGroup(
  apiUrl: string,
  privateKey: `0x${string}`,
  group: SapienceConditionGroup
): Promise<{ success: boolean; error?: string }> {
  try {
    const authHeaders = await getAdminAuthHeaders(privateKey);
    
    const response = await fetch(`${apiUrl}/admin/conditionGroups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        name: group.title, // API uses 'name' field
        categorySlug: group.categorySlug,
      }),
    });

    if (response.ok) {
      return { success: true };
    }

    // Handle duplicate groups gracefully (409 Conflict)
    if (response.status === 409) {
      return { success: true, error: 'Already exists (skipped)' };
    }

    const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
    const errorMsg = `HTTP ${response.status}: ${errorData.message || response.statusText}`;
    console.error(`[Group] "${group.title}" submission failed: ${errorMsg}`);
    return { success: false, error: errorMsg };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Group] "${group.title}" submission error: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

/**
 * Submit a condition to the API
 */
async function submitCondition(
  apiUrl: string,
  privateKey: `0x${string}`,
  condition: SapienceCondition
): Promise<{ success: boolean; error?: string }> {
  try {
    const authHeaders = await getAdminAuthHeaders(privateKey);
    
    const response = await fetch(`${apiUrl}/admin/conditions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        conditionHash: condition.conditionHash, // Use Polymarket's conditionId directly as the condition ID
        question: condition.question,
        shortName: condition.shortName,
        categorySlug: condition.categorySlug,
        endTime: toUnixTimestamp(condition.endDate),
        description: condition.description,
        similarMarkets: condition.similarMarkets,
        chainId: condition.chainId,
        groupName: condition.groupTitle, // API will find or create the group
        resolver: RESOLVER_ADDRESS, // Polymarket LZ ConditionalTokens resolver
        public: true,
      }),
    });

    if (response.ok) {
      return { success: true };
    }

    // Handle duplicate conditions gracefully (409 Conflict)
    if (response.status === 409) {
      return { success: true, error: 'Already exists (skipped)' };
    }

    const responseText = await response.text();
    console.error(`[Condition] Response body: ${responseText}`);
    let errorData = { message: 'Unknown error' };
    try {
      errorData = JSON.parse(responseText);
    } catch {}
    const errorMsg = `HTTP ${response.status}: ${errorData.message || response.statusText}`;
    console.error(`[Condition] ${condition.question} submission failed: ${errorMsg}`);
    return { success: false, error: errorMsg };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Condition] ${condition.question} submission error: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

/**
 * Print what would be submitted in dry-run mode
 */
function printDryRun(data: SapienceOutput): void {
  console.log('\n========== DRY RUN ==========\n');
  
  // Count non-crypto items
  const nonCryptoGroups = data.groups.filter(g => g.categorySlug !== 'crypto');
  const nonCryptoGroupConditions = nonCryptoGroups.flatMap(g => g.conditions.filter(c => c.categorySlug !== 'crypto'));
  const nonCryptoUngrouped = data.ungroupedConditions.filter(c => c.categorySlug !== 'crypto');
  
  console.log(`Would submit ${nonCryptoGroups.length} groups and ${nonCryptoGroupConditions.length + nonCryptoUngrouped.length} conditions\n`);
  
  // Print groups
  if (nonCryptoGroups.length > 0) {
    console.log('Groups to create:');
    for (const group of nonCryptoGroups) {
      console.log(`  [${group.categorySlug}] "${group.title}" (${group.conditions.length} conditions)`);
      for (const condition of group.conditions) {
        if (condition.categorySlug === 'crypto') continue;
        const endDate = new Date(condition.endDate).toLocaleString();
        console.log(`    - ${condition.question.slice(0, 60)}${condition.question.length > 60 ? '...' : ''}`);
        console.log(`      End: ${endDate} | Hash: ${condition.conditionHash.slice(0, 10)}...`);
      }
    }
    console.log('');
  }
  
  // Print ungrouped conditions
  if (nonCryptoUngrouped.length > 0) {
    console.log('Ungrouped conditions to create:');
    for (const condition of nonCryptoUngrouped) {
      const endDate = new Date(condition.endDate).toLocaleString();
      console.log(`  [${condition.categorySlug}] ${condition.question.slice(0, 60)}${condition.question.length > 60 ? '...' : ''}`);
      console.log(`    End: ${endDate} | Hash: ${condition.conditionHash.slice(0, 10)}...`);
    }
    console.log('');
  }
  
  // Print skipped crypto
  const cryptoGroups = data.groups.filter(g => g.categorySlug === 'crypto');
  const cryptoConditions = data.groups.flatMap(g => g.conditions.filter(c => c.categorySlug === 'crypto')).length +
                          data.ungroupedConditions.filter(c => c.categorySlug === 'crypto').length;
  
  if (cryptoGroups.length > 0 || cryptoConditions > 0) {
    console.log(`Would skip: ${cryptoGroups.length} crypto groups, ${cryptoConditions} crypto conditions`);
  }
  
  console.log('\n========== END DRY RUN ==========\n');
}

/**
 * Submit all condition groups and conditions to the API
 */
async function submitToAPI(
  apiUrl: string,
  privateKey: `0x${string}`,
  data: SapienceOutput
): Promise<void> {
  console.log(`Submitting to API: ${apiUrl}`);
  
  let groupsCreated = 0;
  let groupsSkipped = 0;
  let groupsFailed = 0;
  let cryptoGroupsSkipped = 0;
  let conditionsCreated = 0;
  let conditionsSkipped = 0;
  let conditionsFailed = 0;
  let cryptoConditionsSkipped = 0;

  // Submit groups and their conditions (skip crypto category)
  for (const group of data.groups) {
    // Skip crypto groups entirely
    if (group.categorySlug === 'crypto') {
      cryptoGroupsSkipped++;
      cryptoConditionsSkipped += group.conditions.length;
      continue;
    }
    
    const groupResult = await submitConditionGroup(apiUrl, privateKey, group);
    if (groupResult.success) {
      if (groupResult.error) {
        groupsSkipped++;
      } else {
        groupsCreated++;
        console.log(`[API] Created group: "${group.title}" (${group.conditions.length} conditions)`);
      }
    } else {
      groupsFailed++;
    }

    for (const condition of group.conditions) {
      // Skip crypto conditions
      if (condition.categorySlug === 'crypto') {
        cryptoConditionsSkipped++;
        continue;
      }
      
      const conditionResult = await submitCondition(apiUrl, privateKey, condition);
      if (conditionResult.success) {
        if (conditionResult.error) {
          conditionsSkipped++;
        } else {
          conditionsCreated++;
          console.log(`[API] Created condition: "${condition.question.slice(0, 50)}${condition.question.length > 50 ? '...' : ''}"`);
        }
      } else {
        conditionsFailed++;
      }
    }
  }

  // Submit ungrouped conditions (skip crypto category)
  for (const condition of data.ungroupedConditions) {
    // Skip crypto conditions
    if (condition.categorySlug === 'crypto') {
      cryptoConditionsSkipped++;
      continue;
    }
    
    const conditionResult = await submitCondition(apiUrl, privateKey, condition);
    if (conditionResult.success) {
      if (conditionResult.error) {
        conditionsSkipped++;
      } else {
        conditionsCreated++;
        console.log(`[API] Created condition: "${condition.question.slice(0, 50)}${condition.question.length > 50 ? '...' : ''}" (ungrouped)`);
      }
    } else {
      conditionsFailed++;
    }
  }

  // Final summary
  console.log(`Groups: ${groupsCreated} created, ${groupsSkipped} skipped, ${groupsFailed} failed`);
  console.log(`Conditions: ${conditionsCreated} created, ${conditionsSkipped} skipped, ${conditionsFailed} failed`);
  if (cryptoGroupsSkipped > 0 || cryptoConditionsSkipped > 0) {
    console.log(`Crypto skipped: ${cryptoGroupsSkipped} groups, ${cryptoConditionsSkipped} conditions`);
  }
}


// ============ Main ============

async function main() {
  const options = parseArgs();
  
  if (options.help) {
    showHelp();
    process.exit(0);
  }
  
  const apiUrl = process.env.SAPIENCE_API_URL || DEFAULT_SAPIENCE_API_URL;
  const rawPrivateKey = process.env.ADMIN_PRIVATE_KEY;
  
  // Validate and format private key (must be 0x-prefixed hex string)
  let privateKey: `0x${string}` | undefined;
  if (rawPrivateKey) {
    const formattedKey = rawPrivateKey.startsWith('0x') 
      ? rawPrivateKey 
      : `0x${rawPrivateKey}`;
    if (/^0x[0-9a-fA-F]{64}$/.test(formattedKey)) {
      privateKey = formattedKey as `0x${string}`;
    } else {
      console.error('ADMIN_PRIVATE_KEY is invalid (must be 64 hex chars, optionally 0x-prefixed)');
      process.exit(1);
    }
  }
  
  const hasAPICredentials = apiUrl && privateKey;
  
  try {
    // Fetch Polymarket markets ending within 24 hours
    const markets = await fetchEndingSoonestMarkets();
    
    const sapienceData = groupMarkets(markets);
    
    console.log(`Fetched ${sapienceData.metadata.totalConditions} conditions (${sapienceData.metadata.totalGroups} groups)`);
    
    // Export JSON file
    exportJSON(sapienceData);
    
    // Dry run mode - just print what would be submitted
    if (options.dryRun) {
      printDryRun(sapienceData);
      return;
    }
    
    // Submit to API if credentials are available
    if (hasAPICredentials && apiUrl && privateKey) {
      await submitToAPI(apiUrl, privateKey, sapienceData);
    }
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run
main();

