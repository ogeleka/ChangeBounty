import { beforeAll, describe, expect, test } from 'bun:test'

// Simulates two injected wallets (Rabby and MetaMask) announcing themselves via EIP-6963, the way a
// browser does. The config is imported only after the fake window exists, because wagmi reads
// window events when it is created.
type Announced = { info: { rdns: string; name: string; icon: string; uuid: string }; provider: object }

const rabby: Announced = {
  info: { rdns: 'io.rabby', name: 'Rabby Wallet', icon: 'data:,', uuid: 'rabby-uuid' },
  provider: { request: async () => [], on() {}, removeListener() {} },
}
const metamask: Announced = {
  info: { rdns: 'io.metamask', name: 'MetaMask', icon: 'data:,', uuid: 'mm-uuid' },
  provider: { request: async () => [], on() {}, removeListener() {} },
}

let config: typeof import('./config')['config']

beforeAll(async () => {
  const target = new EventTarget()
  target.addEventListener('eip6963:requestProvider', () => {
    for (const detail of [rabby, metamask]) {
      target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))
    }
  })
  ;(globalThis as { window?: unknown }).window = target
  ;({ config } = await import('./config'))
})

describe('wallet connectors', () => {
  test('no generic injected connector that routes to window.ethereum', () => {
    expect(config.connectors.map((c) => c.id)).not.toContain('injected')
  })

  test('each EIP-6963 wallet gets its own connector', () => {
    const ids = config.connectors.map((c) => c.id)
    expect(ids).toContain('io.rabby')
    expect(ids).toContain('io.metamask')
  })

  test('Arc mainnet (5042) is configured', () => {
    expect(config.chains.map((c) => c.id)).toContain(5042)
  })
})
