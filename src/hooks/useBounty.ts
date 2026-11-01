import { useCallback } from 'react'
import { erc20Abi, parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem'
import { useAccount, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from 'wagmi'
import { changeBountyAbi } from '@/contracts/changeBounty'
import { useAppConfig } from '@/lib/api'

type AppChainId = 5042 | 5042002

export interface TxResult {
  hash: Hex
  receipt: TransactionReceipt
}

/** Human readable message for a wallet or RPC error. User rejection is reported as a calm cancellation. */
export function describeError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string; code?: number; cause?: { code?: number; shortMessage?: string } }
  const msg = (e?.shortMessage ?? e?.message ?? '').toString()
  if (e?.code === 4001 || e?.cause?.code === 4001 || /user rejected|user denied/i.test(msg)) return 'Cancelled in your wallet.'
  if (/insufficient funds|exceeds balance|transfer amount exceeds/i.test(msg)) return 'Insufficient USDC balance for this amount plus gas.'
  if (/InvalidUrlLength/.test(msg)) return 'The website address must be between 1 and 512 characters.'
  if (/JobNotActive/.test(msg)) return 'That job is no longer active.'
  if (/NotJobCreator/.test(msg)) return 'Only the job creator can do that.'
  if (/NothingToWithdraw/.test(msg)) return 'There is no unused USDC left to withdraw.'
  return msg.split('\n')[0].slice(0, 220) || 'Something went wrong. Please try again.'
}

/** Reads and writes against the ChangeBounty contract on the network the server is configured for. */
export function useBounty() {
  const { data: cfg } = useAppConfig()
  const { address, chainId: walletChain } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const chainId = cfg?.chainId as AppChainId | undefined
  const publicClient = usePublicClient({ chainId })
  const contract = cfg?.contract as Address | undefined
  const usdcAddress = cfg?.usdc as Address | undefined

  const balance = useReadContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: Boolean(address && usdcAddress && chainId), refetchInterval: 8000 },
  })

  const wrongChain = Boolean(address && chainId && walletChain !== chainId)

  const ensureChain = useCallback(async () => {
    if (chainId && walletChain !== chainId) await switchChainAsync({ chainId })
  }, [chainId, walletChain, switchChainAsync])

  const run = useCallback(
    async (write: () => Promise<Hex>): Promise<TxResult> => {
      if (!publicClient) throw new Error('Network client is not ready.')
      await ensureChain()
      const hash = await write()
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('The transaction reverted onchain.')
      return { hash, receipt }
    },
    [publicClient, ensureChain],
  )

  const need = () => {
    if (!contract || !usdcAddress || !chainId || !address) throw new Error('Connect a wallet and make sure the contract is configured.')
    return { contract, usdcAddress, chainId, address }
  }

  const allowance = useCallback(async (): Promise<bigint> => {
    const { contract: spender, usdcAddress: token, address: owner } = need()
    return publicClient!.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, contract, usdcAddress, address, chainId])

  const approve = (amount: bigint) =>
    run(() => {
      const n = need()
      return writeContractAsync({ address: n.usdcAddress, abi: erc20Abi, functionName: 'approve', args: [n.contract, amount], chainId: n.chainId })
    })

  const createJob = (url: string, agent: Address, reward: bigint, funding: bigint) =>
    run(() => {
      const n = need()
      return writeContractAsync({ address: n.contract, abi: changeBountyAbi, functionName: 'createJob', args: [url, agent, reward, funding], chainId: n.chainId })
    })

  const fundJob = (jobId: bigint, amount: bigint) =>
    run(() => {
      const n = need()
      return writeContractAsync({ address: n.contract, abi: changeBountyAbi, functionName: 'fundJob', args: [jobId, amount], chainId: n.chainId })
    })

  const cancelAndWithdraw = (jobId: bigint) =>
    run(() => {
      const n = need()
      return writeContractAsync({ address: n.contract, abi: changeBountyAbi, functionName: 'cancelAndWithdraw', args: [jobId], chainId: n.chainId })
    })

  const cancelJob = (jobId: bigint) =>
    run(() => {
      const n = need()
      return writeContractAsync({ address: n.contract, abi: changeBountyAbi, functionName: 'cancelJob', args: [jobId], chainId: n.chainId })
    })

  const withdrawUnused = (jobId: bigint) =>
    run(() => {
      const n = need()
      return writeContractAsync({ address: n.contract, abi: changeBountyAbi, functionName: 'withdrawUnused', args: [jobId], chainId: n.chainId })
    })

  return {
    cfg,
    address,
    chainId,
    wrongChain,
    walletBalance: balance.data,
    refetchBalance: balance.refetch,
    switchToApp: ensureChain,
    allowance,
    approve,
    createJob,
    fundJob,
    cancelJob,
    cancelAndWithdraw,
    withdrawUnused,
  }
}

export function jobIdFromReceipt(receipt: TransactionReceipt): bigint | undefined {
  const logs = parseEventLogs({ abi: changeBountyAbi, eventName: 'JobCreated', logs: receipt.logs })
  return logs[0]?.args.jobId
}
