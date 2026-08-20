/**
 * Platform match notices become real DSH user messages, the same way
 * dsh-psyche inner voices and subagent settlement notices reach the model:
 * `createUserMessage` + `<system-reminder>`, then either `agent.inject()`
 * (tool still running) or `agent.followup()` (idle parked session).
 */

import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { GamingClient } from './client.ts'

export const PLUGIN_NAME = 'dsh-gamer'

export interface PlatformNotice {
  id: string
  text: string
  kind?: string
}

export interface InjectAgent {
  id: string
  status?: 'idle' | 'running'
  inject?: (message: UserMessage) => void
  followup?: (message: UserMessage) => void
}

const delivered = new Map<string, Set<string>>()

function sessionKey(id: string): string {
  return String(id)
}

function seen(sessionId: string): Set<string> {
  const key = sessionKey(sessionId)
  const existing = delivered.get(key)
  if (existing) return existing
  const created = new Set<string>()
  delivered.set(key, created)
  return created
}

export function parseNotices(raw: unknown): PlatformNotice[] {
  if (!Array.isArray(raw)) return []
  const out: PlatformNotice[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const rec = row as Record<string, unknown>
    const id = typeof rec.id === 'string' ? rec.id : ''
    const text = typeof rec.text === 'string' ? rec.text.trim() : ''
    if (!id || !text) continue
    out.push({
      id,
      text,
      kind: typeof rec.kind === 'string' ? rec.kind : undefined,
    })
  }
  return out
}

export function takeFresh(sessionId: string, notices: readonly PlatformNotice[]): PlatformNotice[] {
  const bag = seen(sessionId)
  const fresh: PlatformNotice[] = []
  for (const notice of notices) {
    if (bag.has(notice.id)) continue
    bag.add(notice.id)
    fresh.push(notice)
  }
  return fresh
}

export function noticeMessage(notice: PlatformNotice): UserMessage {
  const body = notice.text.trim()
  return reminderMessage(body)
}

export function stallMessage(): UserMessage {
  return reminderMessage(
    'It is your turn in a live match. Call gamer_play view, then gamer_act from current legalActions. Do not stay idle or leave.',
  )
}

function reminderMessage(body: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `<system-reminder>\n${body}\n</system-reminder>` }],
    source: {
      kind: 'plugin',
      plugin: PLUGIN_NAME,
      form: 'notice',
      summary: boundContextSummary(body),
    },
  })
}

export function mergeEnter(decision: PreStepDecision, extras: readonly UserMessage[]): PreStepDecision {
  if (extras.length === 0) return decision
  if (decision.kind !== 'enter') return decision
  return { kind: 'enter', messages: [...decision.messages, ...extras] }
}

export async function fetchNotices(client: GamingClient): Promise<PlatformNotice[]> {
  if (!client.matchId || !client.token) return []
  const row = await client.platform(`/v1/matches/${encodeURIComponent(client.matchId)}/notices`) as { notices?: unknown }
  return parseNotices(row.notices)
}

export async function pullNoticeMessages(client: GamingClient, sessionId: string): Promise<UserMessage[]> {
  return takeFresh(sessionId, await fetchNotices(client)).map(noticeMessage)
}

/** Queue fresh notices for the next pre-step without waking a new turn. */
export function injectNotices(agent: InjectAgent | undefined, notices: readonly PlatformNotice[]): void {
  if (!agent?.inject) return
  for (const notice of notices) {
    agent.inject(noticeMessage(notice))
  }
}
