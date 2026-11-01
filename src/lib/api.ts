import { useQuery } from '@tanstack/react-query'
import type { AlertStatus, Announcement, Discovery, JobView, PublicConfig } from '../../server/types'

export type { AlertStatus, Announcement, Discovery, JobView, PublicConfig }

export class ApiError extends Error {}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    throw new ApiError('Could not reach the ChangeBounty service.')
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status}).`)
  return body
}

export const postJson = <T>(path: string, data: unknown, headers: Record<string, string> = {}) =>
  api<T>(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) })

export function useAppConfig() {
  return useQuery({ queryKey: ['config'], queryFn: () => api<PublicConfig>('/api/config'), staleTime: 60_000 })
}

export function useJobs(refetchMs = 5000) {
  return useQuery({ queryKey: ['jobs'], queryFn: () => api<JobView[]>('/api/jobs'), refetchInterval: refetchMs })
}

export function useJob(id: string | undefined, refetchMs = 3000) {
  return useQuery({
    queryKey: ['job', id],
    queryFn: () => api<JobView>(`/api/jobs/${id}`),
    enabled: Boolean(id),
    refetchInterval: refetchMs,
    retry: false,
  })
}

export type PaymentRow = Discovery

export function usePayments() {
  return useQuery({ queryKey: ['payments'], queryFn: () => api<PaymentRow[]>('/api/payments'), refetchInterval: 6000 })
}
