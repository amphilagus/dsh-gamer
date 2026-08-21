import type { InjectAgent } from './notices.ts'
import type { ProbeAckState } from './presence.ts'
import {
  advanceStallClock,
  deliverWake,
  initialWakeFailureState,
  recordModelOutput,
  recordWakeAttempt,
  routeWake,
  settleUnansweredWake,
  shouldRequestAgentLogout,
  shouldStall,
  type StallClock,
  type WakeFailureState,
} from './wakeup.ts'

export type BackgroundCheckResult = {
  freshKinds: string[]
  wakeMessages: unknown[]
  seatedLive: boolean
  yourTurn: boolean
  stallMessage?: unknown
}

export class BackgroundProbeCoordinator {
  private stallClock: StallClock = {}
  private wakeState: WakeFailureState = initialWakeFailureState()
  private check?: Promise<void>
  private readonly agent: () => InjectAgent | undefined
  private readonly checkSession: () => Promise<BackgroundCheckResult>
  private readonly log: (message: string) => void

  constructor(
    agent: () => InjectAgent | undefined,
    checkSession: () => Promise<BackgroundCheckResult>,
    log: (message: string) => void = () => undefined,
  ) {
    this.agent = agent
    this.checkSession = checkSession
    this.log = log
  }

  noteAgentStatus(status: 'idle' | 'running') {
    if (status === 'running') this.stallClock = {}
    if (status === 'idle') this.wakeState = settleUnansweredWake(this.wakeState, status)
  }

  noteModelOutput() {
    this.wakeState = recordModelOutput(this.wakeState)
  }

  onProbe(): ProbeAckState {
    const agent = this.agent()
    const status = agent?.status ?? 'idle'
    if (status === 'idle') this.wakeState = settleUnansweredWake(this.wakeState, status)
    if (shouldRequestAgentLogout(this.wakeState)) {
      return {
        agentStatus: 'idle',
        wakeFailures: this.wakeState.failures,
        logoutRequest: { reason: 'agent_unresponsive' },
      }
    }
    if (status === 'idle' && !this.check) {
      this.check = this.checkIdleSession().catch((error) => {
        this.log(`gamer background check failed: ${error instanceof Error ? error.message : String(error)}`)
      }).finally(() => {
        this.check = undefined
      })
    }
    return { agentStatus: status, wakeFailures: this.wakeState.failures }
  }

  private recordFollowup(agent: InjectAgent, messages: readonly unknown[]) {
    if (agent.status === 'idle' && agent.followup && messages.length > 0) {
      this.wakeState = recordWakeAttempt(this.wakeState)
    }
    return deliverWake(agent, messages)
  }

  private async checkIdleSession() {
    const agent = this.agent()
    if (!agent || agent.status !== 'idle') return
    if (!agent.inject && !agent.followup) return
    const result = await this.checkSession()
    if (agent.status !== 'idle') return
    const action = routeWake({
      status: agent.status,
      freshKinds: result.freshKinds,
    })
    let alreadyWoke = false
    if (action !== 'none' && agent.status === 'idle') {
      alreadyWoke = this.recordFollowup(agent, result.wakeMessages) === 'followup'
    }

    if (agent.status !== 'idle') return
    const now = Date.now()
    this.stallClock = advanceStallClock(this.stallClock, agent.status, result.seatedLive && result.yourTurn, now)
    if (shouldStall(this.stallClock, now, alreadyWoke) && agent.status === 'idle') {
      if (result.stallMessage !== undefined && this.recordFollowup(agent, [result.stallMessage]) === 'followup') {
        this.stallClock.lastStallAt = now
      }
    }
  }

  snapshot() {
    return { ...this.wakeState }
  }

  async whenCheckIdle() {
    await this.check
  }
}
