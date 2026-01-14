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
const CONDITIONAL_TOKENS_READER_ADDRESS = '0x97b356E9689dCEa3a268Ac6D7d8A87A24fa95ae2' as Address;

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
  openInterest: string | null;  // Open interest in wei (string for BigInt compatibility)
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
    openInterest
  }
}
`;

// ============ API Functions ============

async function fetchUnresolvedConditions(
  apiUrl: string,
  limit: number
): Promise<SapienceCondition[]> {
  const nowTimestamp = Math.floor(Date.now() / 1000);
  
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
  
  return result.data.conditions.slice(0, limit);
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
    console.log(`[${conditionId}] Checking canRequestResolution...`);
    const canResolve = await publicClient.readContract({
      address: CONDITIONAL_TOKENS_READER_ADDRESS,
      abi: conditionalTokensReaderAbi,
      functionName: 'canRequestResolution',
      args: [conditionId],
    });
    
    if (!canResolve) {
      console.log(`[${conditionId}] Not resolved on Polymarket yet`);
      return { conditionId, canResolve: false, settled: false };
    }
    
    // Get the LayerZero fee quote
    console.log(`[${conditionId}] Getting LayerZero fee quote...`);
    const fee = await publicClient.readContract({
      address: CONDITIONAL_TOKENS_READER_ADDRESS,
      abi: conditionalTokensReaderAbi,
      functionName: 'quoteResolution',
      args: [conditionId],
    });
    
    const nativeFee = fee.nativeFee;
    console.log(`[${conditionId}] LayerZero fee: ${formatEther(nativeFee)} POL`);
    
    if (options.dryRun) {
      console.log(`[${conditionId}] DRY RUN - would call requestResolution`);
      return { conditionId, canResolve: true, settled: false };
    }
    
    if (!walletClient) {
      return { conditionId, canResolve: true, settled: false, error: 'No wallet client (missing ADMIN_PRIVATE_KEY)' };
    }
    
    // Execute the settlement
    console.log(`[${conditionId}] Sending requestResolution transaction...`);
    const hash = await walletClient.writeContract({
      address: CONDITIONAL_TOKENS_READER_ADDRESS,
      abi: conditionalTokensReaderAbi,
      functionName: 'requestResolution',
      args: [conditionId],
      value: nativeFee,
    });
    
    console.log(`[${conditionId}] Transaction sent: ${hash}`);
    
    if (options.wait) {
      console.log(`[${conditionId}] Waiting for confirmation...`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`[${conditionId}] Confirmed in block ${receipt.blockNumber}`);
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
  
  const polygonRpcUrl = process.env.POLYGON_RPC_URL;
  const privateKey = process.env.ADMIN_PRIVATE_KEY;
  const sapienceApiUrl = process.env.SAPIENCE_API_URL || DEFAULT_SAPIENCE_API_URL;
  
  if (!polygonRpcUrl) {
    console.error('POLYGON_RPC_URL environment variable is required');
    process.exit(1);
  }
  
  if (options.execute && !privateKey) {
    console.error('ADMIN_PRIVATE_KEY environment variable is required for --execute mode');
    process.exit(1);
  }
  
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
    
    // Check wallet balance
    const balance = await publicClient.getBalance({ address: account.address });
    console.log(`Wallet ${account.address} balance: ${formatEther(balance)} POL`);
  }
  
  try {
    const allConditions = await fetchUnresolvedConditions(sapienceApiUrl, options.limit);
    
    if (allConditions.length === 0) {
      console.log('No unsettled conditions found');
      return;
    }
    
    // Filter to only conditions with non-zero open interest
    const conditions = allConditions.filter(c => {
      const oi = c.openInterest ? BigInt(c.openInterest) : BigInt(0);
      return oi > BigInt(0);
    });
    
    const skippedZeroOI = allConditions.length - conditions.length;
    if (skippedZeroOI > 0) {
      console.log(`Skipping ${skippedZeroOI} conditions with zero open interest`);
    }
    
    if (conditions.length === 0) {
      console.log('No conditions with non-zero open interest to settle');
      return;
    }
    
    console.log(`Processing ${conditions.length} conditions with open interest (mode: ${options.dryRun ? 'dry-run' : 'execute'})`);
    
    const results = {
      total: conditions.length,
      canResolve: 0,
      settled: 0,
      skipped: 0,
      errors: 0,
    };
    
    for (const condition of conditions) {
      const result = await checkAndSettleCondition(
        publicClient,
        walletClient,
        condition,
        options
      );
      
      if (result.error) {
        console.error(`Error for ${condition.id}: ${result.error}`);
        results.errors++;
      } else if (!result.canResolve) {
        results.skipped++;
      } else if (result.settled) {
        results.settled++;
        results.canResolve++;
      } else {
        results.canResolve++;
      }
    }
    
    // Summary
    console.log(`Summary: ${results.total} processed, ${results.canResolve} resolvable, ${results.settled} settled, ${results.skipped} skipped, ${results.errors} errors`);
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run
main();

