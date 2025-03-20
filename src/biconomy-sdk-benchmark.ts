import fs from 'fs';
import path from 'path';
import { createWalletClient, createPublicClient, http } from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createSmartAccountClient } from '@biconomy/account';
import dotenv from 'dotenv';

dotenv.config();

const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
const BUNDLER_URL = 'https://bundler.biconomy.io/api/v2/8453/nJPK7B3ru.dd7f7861-190d-41bd-af80-6877f74b8f44';
const OUTPUT_DIR = 'output';
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'biconomy_sdk_latency_results.csv');
const AVG_OUTPUT_FILE = path.join(OUTPUT_DIR, 'biconomy_sdk_average_latency_results.csv');
const NUM_ITERATIONS = 100;

const pubClient = createPublicClient({
    chain: base,
    transport: http(RPC_URL)
  });

const biconomyBundlerClient = createBundlerClient({
  client: pubClient,
  transport: http('https://bundler.biconomy.io/api/v2/8453/nJPK7B3ru.dd7f7861-190d-41bd-af80-6877f74b8f44')
});

async function runBiconomySdkBenchmark() {
  console.log("\nStarting Biconomy SDK Latency Benchmark...");
  
  const account = privateKeyToAccount(PRIVATE_KEY);
  const client = createWalletClient({
    account,
    chain: base,
    transport: http(RPC_URL),
  });
  
  const smartAccount = await createSmartAccountClient({
    signer: client,
    bundlerUrl: BUNDLER_URL,
  });
  
  const saAddress = await smartAccount.getAccountAddress();  
  
  const results = [];
  const avgResults: any = {};
  
  for (let i = 0; i < NUM_ITERATIONS; i++) {
    console.log(`Submitting UserOp #${i + 1}`);
    
    const start = Date.now();
    let submissionEnd: number | null = null;
    let onChainTime: number | null = null;
    let txHash: `0x${string}` | null = null;
    let userOpHash: string;
    
    try {
      // 1. Send userOp
      const submissionStart = Date.now();
      const userOpResponse = await smartAccount.sendTransaction({
        to: saAddress,
        value: BigInt(Math.floor(Math.random() * 10_000)), 
      });
      submissionEnd = Date.now();
      const submissionLatency = submissionEnd - submissionStart;
      
      console.log(`UserOp submitted: ${userOpResponse.userOpHash} (Submission Latency: ${submissionLatency} ms)`);      
      userOpHash = userOpResponse.userOpHash;
      
      // 2. Wait on inclusion
      const receipt = await userOpResponse.wait(1);      
      txHash = receipt.receipt.transactionHash;
      const block = await pubClient.getBlock({ blockNumber: receipt.receipt.blockNumber });
      onChainTime = Number(block.timestamp) * 1000;
      
      const totalLatency = onChainTime - start;
      console.log(`UserOp included on-chain. Total Latency: ${totalLatency} ms (Submission: ${submissionLatency} ms, Inclusion: ${totalLatency - submissionLatency} ms, Tx Hash: ${txHash})`);
      
      results.push({
        userOpHash,
        submissionLatency,
        onChainTime,
        totalLatency,
        txHash
      });
    } catch (error) {
      console.error(`Error submitting UserOp #${i + 1}:`, error);
      results.push({
        error: error instanceof Error ? error.message : String(error),
      });
    }    
  }
  
  console.log("\n=== Biconomy SDK Latency Results ===");
  console.table(results.map(r => ({
    "UserOp Hash": r.userOpHash || 'Failed',
    "Submission Latency": r.submissionLatency ? `${r.submissionLatency} ms` : 'Error',    
    "On-Chain Latency": r.totalLatency && r.submissionLatency ? `${r.totalLatency - r.submissionLatency} ms` : 'Error',
    "Total Latency": r.totalLatency ? `${r.totalLatency} ms` : 'Error',
    "Tx Hash": r.txHash || 'N/A'
  })));

  const filteredResults = results.filter(r => r.totalLatency && r.submissionLatency);
    if (filteredResults.length > 0) {
      avgResults['biconomySDK'] = {
        submissionLatency: filteredResults.reduce((sum, r) => sum + r.submissionLatency!, 0) / filteredResults.length,
        onChainLatency: filteredResults.reduce((sum, r) => sum + (r.totalLatency! - r.submissionLatency!), 0) / filteredResults.length,
        totalLatency: filteredResults.reduce((sum, r) => sum + r.totalLatency!, 0) / filteredResults.length,
      };
    }
  
  const csvHeader = "UserOp Hash,Submission Latency (ms),On-Chain Latency (ms),Total Latency (ms),Tx Hash\n";
  const csvRows = results.map(r => `${r.userOpHash || 'Failed'},${r.submissionLatency || 'Error'},${r.totalLatency && r.submissionLatency ? r.totalLatency - r.submissionLatency : 'Error'},${r.totalLatency || 'Error'},${r.txHash || 'N/A'}`).join("\n");
  fs.writeFileSync(OUTPUT_FILE, csvHeader + csvRows);

  const avgCsvHeader = "Bundler,Avg Submission Latency (ms),Avg On-Chain Latency (ms),Avg Total Latency (ms)\n";
  // @ts-ignore
  const avgCsvRows = Object.entries(avgResults).map(([bundler, data]) => `${bundler},${data.submissionLatency},${data.onChainLatency},${data.totalLatency}`).join("\n");
  fs.writeFileSync(AVG_OUTPUT_FILE, avgCsvHeader + avgCsvRows);

  console.log(`Results saved to ${OUTPUT_FILE}`);
  console.log(`Average results saved to ${AVG_OUTPUT_FILE}`);
}

runBiconomySdkBenchmark().catch(console.error);