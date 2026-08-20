export type AgentStatus = 'idle' | 'running' | undefined

export const STALL_IDLE_MS = 15_000

export type StallClock = {
  idleSince?: number
  lastStallAt?: number
}

export function isNewTicket(prev: string | undefined, next: string | undefined): boolean {
  return Boolean(next) && next !== prev
}

export function isStartOrEnd(kind: string | undefined): boolean {
  return kind === 'match_started' || kind === 'match_ended'
}

export function routeWake(input: {
  status: AgentStatus
  freshKinds: readonly string[]
}): 'inject' | 'followup' | 'none' {
  const startOrEnd = input.freshKinds.some((kind) => isStartOrEnd(kind))
  if (!startOrEnd) return 'none'
  if (input.status === 'idle') return 'followup'
  return 'inject'
}

export function deliverWake<T>(
  agent: {
    status?: AgentStatus
    inject?: (message: T) => void
    followup?: (message: T) => void
  },
  messages: readonly T[],
): 'followup' | 'inject' | 'none' {
  if (messages.length === 0) return 'none'
  if (agent.status === 'idle' && agent.followup) {
    agent.followup(messages[0])
    for (const message of messages.slice(1)) agent.inject?.(message)
    return 'followup'
  }
  if (!agent.inject) return 'none'
  for (const message of messages) agent.inject(message)
  return 'inject'
}

export function viewIsYourTurn(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const rec = body as Record<string, unknown>
  return rec.yourTurn === true && rec.status === 'playing'
}

export function advanceStallClock(
  clock: StallClock,
  status: AgentStatus,
  eligible: boolean,
  now: number,
): StallClock {
  if (status === 'running' || status !== 'idle' || !eligible) return {}
  return { idleSince: clock.idleSince ?? now, lastStallAt: clock.lastStallAt }
}

export function shouldStall(clock: StallClock, now: number, alreadyWoke: boolean): boolean {
  if (alreadyWoke) return false
  if (clock.idleSince === undefined) return false
  if (now - clock.idleSince < STALL_IDLE_MS) return false
  if (clock.lastStallAt !== undefined && clock.lastStallAt >= clock.idleSince) return false
  return true
}
