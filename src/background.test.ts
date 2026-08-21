import assert from 'node:assert/strict'
import test from 'node:test'
import { BackgroundProbeCoordinator } from './background.ts'

test('five reminders without activation produce agent_unresponsive logout request', async () => {
  let roomChecks = 0
  let followups = 0
  const agent = {
    id: `session-${Date.now()}`,
    status: 'idle' as 'idle' | 'running',
    followup: () => { followups++ },
    inject: () => undefined,
  }
  const coordinator = new BackgroundProbeCoordinator(
    () => agent,
    async () => {
      roomChecks++
      return {
        freshKinds: ['match_started'],
        wakeMessages: [`notice-${roomChecks}`],
        seatedLive: false,
        yourTurn: false,
      }
    },
  )

  for (let i = 0; i < 5; i++) {
    const ack = coordinator.onProbe()
    assert.equal(ack.wakeFailures, i)
    assert.equal(ack.logoutRequest, undefined)
    await coordinator.whenCheckIdle()
  }
  const logout = coordinator.onProbe()
  assert.deepEqual(logout, {
    agentStatus: 'idle',
    wakeFailures: 5,
    logoutRequest: { reason: 'agent_unresponsive' },
  })
  assert.equal(followups, 5)

  coordinator.noteModelOutput()
  agent.status = 'running'
  coordinator.noteAgentStatus('running')
  assert.deepEqual(coordinator.onProbe(), { agentStatus: 'running', wakeFailures: 0 })
  await coordinator.whenCheckIdle()
  assert.equal(roomChecks, 5, 'running probes do not perform reminder checks')
})
