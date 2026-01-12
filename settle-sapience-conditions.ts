#!/usr/bin/env tsx
/// <reference types="node" />
/**
 * Settle Sapience conditions by bridging resolution data from Polymarket via LayerZero
 * 
 * This script:
 * 1. Queries Sapience API for unsettled conditions that have ended
 * 2. Checks if each condition is resolved on Polymarket (via ConditionalTokensReader on Polygon)
 * 3. Triggers LayerZero resolution bridging by calling requestResolution
 * 
 * Usage: 
 *   tsx settle-sapience-conditions.ts --dry-run
 *   tsx settle-sapience-conditions.ts --execute
 * 
 * Options:
 *   --dry-run      Check conditions without sending transactions (default)
 *   --execute      Actually send settlement transactions
 *   --wait         Wait for transaction confirmations
 *   --limit N      Limit number of conditions to process
 *   --help         Show this help message
 * 
 * Environment Variables (can be set in .env file):
 *   POLYGON_RPC_URL    Polygon RPC URL (required)
 *   ADMIN_PRIVATE_KEY        Private key for signing transactions (required for --execute)
 *   SAPIENCE_API_URL   Sapience GraphQL API URL (default: https://api.sapience.xyz/graphql)
 */

import 'dotenv/config';

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type Account,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Chain,
  formatEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

// ============ Constants ============

// ConditionalTokensReader contract on Polygon
const CONDITIONAL_TOKENS_READER_ADDRESS = '0xe94a1978f725cefa53487adbc588fdddf01e20ff' as Address;

// Default Sapience API URL
const DEFAULT_SAPIENCE_API_URL = 'https://api.sapience.xyz/graphql';

// Polygon chain ID
const POLYGON_CHAIN_ID = 137;

// ============ Types ============

interface CLIOptions {
  dryRun: boolean;
  execute: boolean;
  wait: boolean;
  limit: number;
  help: boolean;
}

interface SapienceCondition {
  id: string;
  question: string;
  shortName: string;
  endTime: number;
  settled: boolean;
  resolver: string | null;
  claimStatement: string | null;
  chainId: number;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface ConditionsQueryResponse {
  conditions: SapienceCondition[];
}

// ============ ABI ============

const conditionalTokensReaderAbi = [
  {
    type: 'function',
    name: 'canRequestResolution',
    stateMutability: 'view',
    inputs: [{ name: 'conditionId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'quoteResolution',
    stateMutability: 'view',
    inputs: [{ name: 'conditionId', type: 'bytes32' }],
    outputs: [
      {
        name: 'fee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', type: 'uint256' },
          { name: 'lzTokenFee', type: 'uint256' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'requestResolution',
    stateMutability: 'payable',
    inputs: [{ name: 'conditionId', type: 'bytes32' }],
    outputs: [],
  },
] as const;

// ============ CLI Arguments ============

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  
  const getArgValue = (name: string): string | undefined => {
    const idx = args.findIndex(a => a === `--${name}`);
    if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) {
      return args[idx + 1];
    }
    const withEq = args.find(a => a.startsWith(`--${name}=`));
    if (withEq) return withEq.slice(`--${name}=`.length);
    return undefined;
  };
  
  const hasArg = (name: string): boolean => 
    args.includes(`--${name}`) || args.some(a => a.startsWith(`--${name}=`));
  
  const limitStr = getArgValue('limit');
  const limit = limitStr ? parseInt(limitStr, 10) : Infinity;
  
  return {
    dryRun: hasArg('dry-run') || !hasArg('execute'),
    execute: hasArg('execute'),
    wait: hasArg('wait'),
    limit: Number.isFinite(limit) ? limit : Infinity,
    help: hasArg('help') || hasArg('h'),
  };
}

function showHelp(): void {
  console.log(`
Usage: tsx settle-sapience-conditions.ts [options]

Options:
  --dry-run      Check conditions without sending transactions (default)
  --execute      Actually send settlement transactions
  --wait         Wait for transaction confirmations
  --limit N      Limit number of conditions to process (default: all)
  --help, -h     Show this help message

Environment Variables:
  POLYGON_RPC_URL    Polygon RPC URL (required)
  ADMIN_PRIVATE_KEY        Private key for signing transactions (required for --execute)
  SAPIENCE_API_URL   Sapience GraphQL API URL (default: https://api.sapience.xyz/graphql)

Examples:
  # Dry run - check which conditions can be settled
  tsx settle-sapience-conditions.ts --dry-run

  # Execute settlements
  POLYGON_RPC_URL=https://polygon-rpc.com ADMIN_PRIVATE_KEY=0x... \\
    tsx settle-sapience-conditions.ts --execute --wait

  # Process only 10 conditions
  tsx settle-sapience-conditions.ts --dry-run --limit 10
`);
}

// ============ GraphQL Query ============

const UNRESOLVED_CONDITIONS_QUERY = `
query UnresolvedConditions($now: Int!) {
  conditions(
    where: {
      AND: [
        { endTime: { lt: $now } }
        { settled: { equals: false } }
        { public: { equals: true } }
      ]
    }
    orderBy: { endTime: asc }
  ) {
    id
    question
    shortName
    endTime
    settled
    resolver
    claimStatement
    chainId
  }
}
`;

// ============ API Functions ============

async function fetchUnresolvedConditions(
  apiUrl: string,
  limit: number
): Promise<SapienceCondition[]> {
  const nowTimestamp = Math.floor(Date.now() / 1000);
  
  console.log(`📥 Fetching unsettled conditions from Sapience API...`);
  console.log(`   API URL: ${apiUrl}`);
  console.log(`   Current timestamp: ${nowTimestamp}`);
  
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      query: UNRESOLVED_CONDITIONS_QUERY,
      variables: { now: nowTimestamp },
    }),
  });
  
  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
  }
  
  const result = await response.json() as GraphQLResponse<ConditionsQueryResponse>;
  
  if (result.errors?.length) {
    throw new Error(`GraphQL errors: ${result.errors.map(e => e.message).join('; ')}`);
  }
  
  if (!result.data?.conditions) {
    throw new Error('No conditions data in response');
  }
  
  const conditions = result.data.conditions.slice(0, limit);
  console.log(`✅ Found ${result.data.conditions.length} unsettled conditions (processing ${conditions.length})`);
  
  return conditions;
}

// ============ Blockchain Functions ============

interface SettlementResult {
  conditionId: string;
  canResolve: boolean;
  settled: boolean;
  txHash?: string;
  error?: string;
}

async function checkAndSettleCondition(
  publicClient: PublicClient,
  walletClient: WalletClient<Transport, Chain, Account> | null,
  condition: SapienceCondition,
  options: CLIOptions
): Promise<SettlementResult> {
  const conditionId = condition.id as Hex;
  
  try {
    // Check if condition can be resolved on Polymarket
    const canResolve = await publicClient.readContract({
      address: CONDITIONAL_TOKENS_READER_ADDRESS,
      abi: conditionalTokensReaderAbi,
      functionName: 'canRequestResolution',
      args: [conditionId],
    });
    
    if (!canResolve) {
      return { conditionId, canResolve: false, settled: false };
    }
    
    // Get the LayerZero fee quote
    const fee = await publicClient.readContract({
      address: CONDITIONAL_TOKENS_READER_ADDRESS,
      abi: conditionalTokensReaderAbi,
      functionName: 'quoteResolution',
      args: [conditionId],
    });
    
    const nativeFee = fee.nativeFee;
    console.log(`   💰 LayerZero fee: ${formatEther(nativeFee)} POL`);
    
    if (options.dryRun) {
      console.log(`   🔍 DRY RUN: Would call requestResolution with ${formatEther(nativeFee)} POL`);
      return { conditionId, canResolve: true, settled: false };
    }
    
    if (!walletClient) {
      return { conditionId, canResolve: true, settled: false, error: 'No wallet client (missing ADMIN_PRIVATE_KEY)' };
    }
    
    // Execute the settlement
    const hash = await walletClient.writeContract({
      address: CONDITIONAL_TOKENS_READER_ADDRESS,
      abi: conditionalTokensReaderAbi,
      functionName: 'requestResolution',
      args: [conditionId],
      value: nativeFee,
    });
    
    console.log(`   ✅ Transaction sent: ${hash}`);
    
    if (options.wait) {
      console.log(`   ⏳ Waiting for confirmation...`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);
    }
    
    return { conditionId, canResolve: true, settled: true, txHash: hash };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { conditionId, canResolve: false, settled: false, error: errorMessage };
  }
}

// ============ Main ============

async function main() {
  const options = parseArgs();
  
  if (options.help) {
    showHelp();
    process.exit(0);
  }
  
  console.log('🚀 Sapience Condition Settlement Script\n');
  console.log(`   Mode: ${options.dryRun ? 'DRY RUN' : 'EXECUTE'}`);
  console.log(`   Wait for confirmations: ${options.wait}`);
  console.log(`   Limit: ${Number.isFinite(options.limit) ? options.limit : 'all'}`);
  console.log('');
  
  // Get environment variables
  const polygonRpcUrl = process.env.POLYGON_RPC_URL;
  const privateKey = process.env.ADMIN_PRIVATE_KEY;
  const sapienceApiUrl = process.env.SAPIENCE_API_URL || DEFAULT_SAPIENCE_API_URL;
  
  if (!polygonRpcUrl) {
    console.error('❌ POLYGON_RPC_URL environment variable is required');
    process.exit(1);
  }
  
  if (options.execute && !privateKey) {
    console.error('❌ ADMIN_PRIVATE_KEY environment variable is required for --execute mode');
    process.exit(1);
  }
  
  // Create clients
  const publicClient = createPublicClient({
    chain: polygon,
    transport: http(polygonRpcUrl),
  });
  
  let walletClient: WalletClient<Transport, typeof polygon, Account> | null = null;
  
  if (privateKey) {
    const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const account = privateKeyToAccount(formattedKey as Hex);
    
    walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(polygonRpcUrl),
    });
    
    console.log(`   Wallet: ${account.address}`);
    
    // Check balance
    const balance = await publicClient.getBalance({ address: account.address });
    console.log(`   Balance: ${formatEther(balance)} POL`);
  }
  
  console.log('');
  
  try {
    // Fetch unsettled conditions from Sapience API
    const conditions = await fetchUnresolvedConditions(sapienceApiUrl, options.limit);
    
    if (conditions.length === 0) {
      console.log('\n✅ No unsettled conditions found. Nothing to do.');
      return;
    }
    
    // Display conditions
    console.log('\n📋 Processing conditions:\n');
    
    const results = {
      total: conditions.length,
      canResolve: 0,
      settled: 0,
      skipped: 0,
      errors: 0,
    };
    
    for (let i = 0; i < conditions.length; i++) {
      const condition = conditions[i];
      const endDate = new Date(condition.endTime * 1000);
      
      console.log(`[${i + 1}/${conditions.length}] ${condition.shortName || condition.question.slice(0, 60)}...`);
      console.log(`   ID: ${condition.id}`);
      console.log(`   End time: ${endDate.toISOString()}`);
      
      const result = await checkAndSettleCondition(
        publicClient,
        walletClient,
        condition,
        options
      );
      
      if (result.error) {
        console.log(`   ❌ Error: ${result.error}`);
        results.errors++;
      } else if (!result.canResolve) {
        console.log(`   ⏭️  Not resolved on Polymarket yet`);
        results.skipped++;
      } else if (result.settled) {
        results.settled++;
        results.canResolve++;
      } else {
        results.canResolve++;
      }
      
      console.log('');
    }
    
    // Summary
    console.log('='.repeat(80));
    console.log('\n📊 SETTLEMENT SUMMARY\n');
    console.log(`   Total conditions processed: ${results.total}`);
    console.log(`   Resolved on Polymarket: ${results.canResolve}`);
    console.log(`   Not yet resolved: ${results.skipped}`);
    console.log(`   Settlements sent: ${results.settled}`);
    console.log(`   Errors: ${results.errors}`);
    
    if (options.dryRun && results.canResolve > 0) {
      console.log('\n💡 Run with --execute to actually send settlement transactions');
    }
    
  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  }
}

// Run
main();

