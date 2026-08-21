/**
 * Agent-side login valve. Platform HTTP may still list rooms without a Bearer;
 * gamer tools refuse other gamer_* calls until this session has a token.
 */

import { ApiError } from './client.ts'

export const NOT_LOGGED_IN = {
  ok: false,
  error: 'not_logged_in',
  message: 'The selected platform has no active account. Call gamer_account action=register/login, or use_saved for a stored account. Then whoami. Do not call other gamer_* tools until logged in.',
} as const

/** DSH rejects `undefined`; this is also the final credential boundary for every tool output. */
export function asJson(value: unknown) {
  return JSON.parse(JSON.stringify(sanitizeAgentOutput(value)))
}

export function requireLogin(client: { token?: string }) {
  if (client.token) return undefined
  return asJson(NOT_LOGGED_IN)
}

/** Login first, then roomId. Unlogged ready must not look like missing_room_id. */
export function readyLocalError(
  client: { token?: string; roomId?: string },
  args: { roomId?: unknown } = {},
) {
  const gated = requireLogin(client)
  if (gated) return gated
  const roomId = (typeof args.roomId === 'string' && args.roomId.length > 0)
    ? args.roomId
    : client.roomId
  if (!roomId) return asJson({ ok: false, error: 'missing_room_id' })
  return undefined
}

function isSensitiveOutputKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return normalized.includes('password')
    || normalized.includes('token')
    || normalized.includes('ticket')
    || normalized === 'credentialref'
    || normalized === 'authorization'
}

export function sanitizeAgentOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAgentOutput)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveOutputKey(key)) continue
    out[key] = sanitizeAgentOutput(nested)
  }
  return out
}

export function mapToolError(error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
    return asJson({
      ok: false,
      error: 'not_logged_in',
      message: NOT_LOGGED_IN.message,
      status: 401,
      platform: sanitizeAgentOutput(error.body ?? null),
    })
  }
  if (error instanceof ApiError) {
    return asJson({ ok: false, status: error.status, error: sanitizeAgentOutput(error.body ?? null) })
  }
  return asJson({ ok: false, message: error instanceof Error ? error.message : String(error) })
}
