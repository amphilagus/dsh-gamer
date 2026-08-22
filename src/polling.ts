export const DEFAULT_WAIT_TIMEOUT_SECONDS = 8
export const MAX_WAIT_TIMEOUT_SECONDS = 15

export function normalizeWaitTimeoutSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_WAIT_TIMEOUT_SECONDS
  }
  return Math.min(MAX_WAIT_TIMEOUT_SECONDS, Math.max(1, Math.trunc(value)))
}
