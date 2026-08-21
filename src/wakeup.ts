export type AgentStatus = 'idle' | 'running' | undefined

export const STALL_IDLE_MS = 3_000
export const STALL_REPEAT_MS = 3_000
export const MAX_WAKE_FAILURES = 5

export type StallClock = {
  idleSince?: number
  lastStallAt?: number
}

export type WakeFailureState = {
  failures: number
  pendingWithoutOutput: boolean
}

export function initialWakeFailureState(): WakeFailureState {
  return { failures: 0, pendingWithoutOutput: false }
}

export function recordWakeAttempt(state: WakeFailureState): WakeFailureState {
  return { ...state, pendingWithoutOutput: true }
}

export function recordModelOutput(_state: WakeFailureState): WakeFailureState {
  return initialWakeFailureState()
}

export function settleUnansweredWake(state: WakeFailureState, status: AgentStatus): WakeFailureState {
  if (status !== 'idle' || !state.pendingWithoutOutput) return state
  return {
    failures: Math.min(MAX_WAKE_FAILURES, state.failures + 1),
    pendingWithoutOutput: false,
  }
}

export function shouldRequestAgentLogout(state: WakeFailureState): boolean {
  return state.failures >= MAX_WAKE_FAILURES
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
  if (clock.lastStallAt !== undefined && now - clock.lastStallAt < STALL_REPEAT_MS) return false
  return true
}
