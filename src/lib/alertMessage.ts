/**
 * The exact text a job creator signs to manage ChangeBounty alerts. The app builds it for the wallet to
 * sign and the server rebuilds it from the same fields to check the signature, so both must use this file.
 */

export type AlertAction = 'link-telegram' | 'subscribe-email' | 'unsubscribe-telegram' | 'unsubscribe-email'

export interface AlertRequest {
  action: AlertAction
  address: string
  email?: string
  site: string
  chainId: number
  issuedAt: string
  nonce: string
}

const ACTION_TEXT: Record<AlertAction, string> = {
  'link-telegram': 'Send alerts for my jobs to Telegram.',
  'subscribe-email': 'Send alerts for my jobs to this email address.',
  'unsubscribe-telegram': 'Stop sending alerts for my jobs to Telegram.',
  'unsubscribe-email': 'Stop sending alerts for my jobs by email.',
}

export function alertMessage(r: AlertRequest): string {
  return [
    'ChangeBounty alerts',
    ACTION_TEXT[r.action],
    '',
    `Wallet: ${r.address}`,
    ...(r.email ? [`Email: ${r.email}`] : []),
    `Site: ${r.site}`,
    `Chain ID: ${r.chainId}`,
    `Issued at: ${r.issuedAt}`,
    `Nonce: ${r.nonce}`,
    '',
    'Signing is free. It sends no transaction and moves no funds.',
  ].join('\n')
}

/** Lowercased and trimmed. The app signs this form, so the server can require an exact match. */
export function normaliseEmail(input: string): string {
  return input.trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email)
}
