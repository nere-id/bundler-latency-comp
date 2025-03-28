import fs from 'fs';
import path from 'path';
import { BundlerClient, createBundlerClient } from 'viem/account-abstraction';
import { toBiconomySmartAccount, ToBiconomySmartAccountReturnType } from 'permissionless/accounts';
import { createPublicClient, formatEther, http, parseGwei, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import dotenv from 'dotenv';

dotenv.config();

const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
const ENTRY_POINT = process.env.ENTRY_POINT as `0x${string}`;

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY!;
const PIMLICO_API_KEY = process.env.PIMLICO_API_KEY!;

const pubClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL)
});

const BUNDLER_CLIENTS = {
  biconomy: createBundlerClient({
    client: pubClient,
    transport: http('https://bundler.biconomy.io/api/v2/8453/nJPK7B3ru.dd7f7861-190d-41bd-af80-6877f74b8f44')
  }),
  alchemy: createBundlerClient({
    client: pubClient,
    transport: http(`https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`)
  }),
  pimlico: createBundlerClient({
    client: pubClient,
    transport: http(`https://api.pimlico.io/v2/base/rpc?apikey=${PIMLICO_API_KEY}`)
  }),
};

const NUM_ITERATIONS = 100;
const OUTPUT_DIR = 'output';
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'latency_results_2.csv');
const AVG_OUTPUT_FILE = path.join(OUTPUT_DIR, 'average_latency_results_2.csv');

async function runBundlerComp(
  account: ToBiconomySmartAccountReturnType,
  bundlerName: string,
  bundlerClient: BundlerClient
) {
  console.log(`\nTesting bundler: ${bundlerName}`);
  
  const results = [];

  for (let i = 0; i < NUM_ITERATIONS; i++) {
    console.log(`Submitting UserOp #${i + 1}`);
        
    let userOpHash: `0x${string}`;
    let submissionEnd: number | null = null;
    let onChainTime: number | null = null;
    let txHash: `0x${string}` | null = null;

    try {
      // 1. Prepare userOp
      const userOperation = await bundlerClient.prepareUserOperation({
        account,
        calls: [{ 
          to: account.address, 
          value: BigInt(Math.floor(Math.random() * 10_000))
        }]
      });
      // userOperation.callGasLimit = 30_000_000n;
      // userOperation.callGasLimit = 20_000_000n;
      // userOperation.preVerificationGas = 30_000_000n;
      userOperation.maxPriorityFeePerGas = parseGwei('0.002');
      userOperation.signature = await account.signUserOperation(userOperation);
      // console.log({ 
      //   gas: { 
      //     callGasLimit: userOperation.callGasLimit,
      //     verificationGasLimit: userOperation.verificationGasLimit,
      //     preVerificationGas: userOperation.preVerificationGas,
      //     maxFeePerGas: userOperation.maxFeePerGas,
      //     maxPriorityFeePerGas: userOperation.maxPriorityFeePerGas,
      //   }          
      // });
  
      // 2. Send userOp
      const start = Date.now();
      const submissionStart = Date.now();
      userOpHash = await bundlerClient.sendUserOperation(userOperation);
      submissionEnd = Date.now();
      const submissionLatency = submissionEnd - submissionStart;
      console.log(`UserOp submitted: ${userOpHash} (Submission Latency: ${submissionLatency} ms)`);

      // 3. Wait on inclusion
      const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });
      txHash = receipt.receipt.transactionHash;
      const block = await pubClient.getBlock({ blockNumber: receipt.receipt.blockNumber });
      onChainTime = Number(block.timestamp) * 1000;
      
      const totalLatency = onChainTime - start;
      console.log(`UserOp included on-chain. Total Latency: ${totalLatency} ms (Submission: ${submissionLatency} ms, Inclusion: ${totalLatency - submissionLatency} ms, Tx Hash: ${txHash})`);

      results.push({
        bundler: bundlerName,
        userOpHash,
        submissionLatency,
        onChainTime,
        totalLatency,
        txHash
      });
    } catch (error) {
      console.error(`Error submitting UserOp #${i + 1}:`, error);
      results.push({
        bundler: bundlerName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function main() {  
  const allResults = [];
  const avgResults: any = {};

  const account = await toBiconomySmartAccount({
    client: pubClient,
    owners: [privateKeyToAccount(PRIVATE_KEY)],
    entryPoint: {
      address: ENTRY_POINT,
      version: "0.6",
    }
  });
  
  for (const [bundlerName, bundlerClient] of Object.entries(BUNDLER_CLIENTS)) {
    const results = await runBundlerComp(account, bundlerName, bundlerClient);
    allResults.push(...results);

    const filteredResults = results.filter(r => r.totalLatency && r.submissionLatency);
    if (filteredResults.length > 0) {
      avgResults[bundlerName] = {
        submissionLatency: filteredResults.reduce((sum, r) => sum + r.submissionLatency!, 0) / filteredResults.length,
        onChainLatency: filteredResults.reduce((sum, r) => sum + (r.totalLatency! - r.submissionLatency!), 0) / filteredResults.length,
        totalLatency: filteredResults.reduce((sum, r) => sum + r.totalLatency!, 0) / filteredResults.length,
      };
    }
  }

  console.log("\n=== Average Latency Results ===");
  console.table(avgResults);

  const csvHeader = "Bundler,Submission Latency (ms),On-Chain Latency (ms),Total Latency (ms),Tx Hash\n";
  const csvRows = allResults.map(r => `${r.bundler},${r.submissionLatency || 'Error'},${r.totalLatency && r.submissionLatency ? r.totalLatency - r.submissionLatency : 'Error'},${r.totalLatency || 'Error'},${r.txHash || 'N/A'}`).join("\n");
  fs.writeFileSync(OUTPUT_FILE, csvHeader + csvRows);

  const avgCsvHeader = "Bundler,Avg Submission Latency (ms),Avg On-Chain Latency (ms),Avg Total Latency (ms)\n";
  const avgCsvRows = Object.entries(avgResults).map(([bundler, data]: [any, any]) => `${bundler},${data.submissionLatency},${data.onChainLatency},${data.totalLatency}`).join("\n");
  fs.writeFileSync(AVG_OUTPUT_FILE, avgCsvHeader + avgCsvRows);

  console.log(`Results saved to ${OUTPUT_FILE}`);
  console.log(`Average results saved to ${AVG_OUTPUT_FILE}`);
}

main().catch(console.error);