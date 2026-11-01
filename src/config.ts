/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arc, arcTestnet } from 'viem/chains'
import { requireChain } from './onchain-facts'
import { registerChain } from './tracing'

// RPC URLs come from the generated registry, never typed by hand.
const ARC_RPC = requireChain(arc.id).rpcUrls[0]
const ARC_TESTNET_RPC = requireChain(arcTestnet.id).rpcUrls[0]

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(arcTestnet.id, ARC_TESTNET_RPC)
registerChain(arc.id, ARC_RPC)

export const config = createConfig({
  chains: [arcTestnet, arc, mainnet], // mainnet (Ethereum) needed for ENS resolution
  // No generic injected() connector: it always uses window.ethereum, which is ambiguous when several
  // wallets are installed. wagmi discovers each wallet via EIP-6963 (multiInjectedProviderDiscovery,
  // on by default) and gives every one its own connector bound to that wallet's provider.
  connectors: [],
  transports: {
    [arcTestnet.id]: http(ARC_TESTNET_RPC),
    [arc.id]: http(ARC_RPC),
    [mainnet.id]: http(), // ENS resolution uses mainnet
  },
})
