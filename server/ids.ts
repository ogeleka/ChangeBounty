import { encodeAbiParameters, keccak256, type Hex } from 'viem'

/** Discovery ids are deterministic and unique per (job, baseline, new content, prior payouts). */
export function discoveryIdFor(jobId: bigint, baselineHash: string, newHash: string, payouts: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
      [jobId, `0x${baselineHash}`, `0x${newHash}`, BigInt(payouts)],
    ),
  )
}
