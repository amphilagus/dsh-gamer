import { ApiError, GamingClient, PROTOCOL_HEADER, PROTOCOL_VERSION } from './client.ts'

export type PresenceProbe = {
  leaseId: string
  sequence: number
  sentAt: string
}

export type ProbeAckState = {
  agentStatus: 'idle' | 'running'
  wakeFailures: number
  logoutRequest?: { reason: 'agent_unresponsive' }
}

type SseEvent = { event: string; data: string }

class PresenceEnded extends Error {}

export function reconnectBackoffMs(failures: number): number {
  return Math.min(30_000, 1000 * (2 ** Math.max(0, failures - 1)))
}

function parseFrame(frame: string): SseEvent | undefined {
  let event = 'message'
  const data: string[] = []
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    if (field === 'data') data.push(value)
  }
  return data.length > 0 ? { event, data: data.join('\n') } : undefined
}

export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => Promise<void>,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const event = parseFrame(frame)
        if (event) await onEvent(event)
      }
      if (done) break
    }
    const final = parseFrame(buffer)
    if (final) await onEvent(final)
  } catch (error) {
    try { await reader.cancel(error) } catch { /* stream already closed */ }
    throw error
  } finally {
    reader.releaseLock()
  }
}

async function responseBody(res: Response): Promise<unknown> {
  const text = await res.text()
  try { return text ? JSON.parse(text) : null } catch { return text }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export class PresenceConnection {
  private controller?: AbortController
  private loop?: Promise<void>
  private readonly client: GamingClient
  private readonly handleProbe: (probe: PresenceProbe) => Promise<ProbeAckState>
  private readonly log: (message: string) => void

  constructor(
    client: GamingClient,
    handleProbe: (probe: PresenceProbe) => Promise<ProbeAckState>,
    log: (message: string) => void = () => undefined,
  ) {
    this.client = client
    this.handleProbe = handleProbe
    this.log = log
  }

  start() {
    if (!this.client.token || this.loop) return
    const controller = new AbortController()
    this.controller = controller
    this.loop = this.run(controller.signal).finally(() => {
      if (this.controller === controller) this.controller = undefined
      this.loop = undefined
    })
  }

  stop() {
    this.controller?.abort()
  }

  private async run(signal: AbortSignal) {
    let failures = 0
    while (!signal.aborted && this.client.token) {
      try {
        const received = await this.connectOnce(signal)
        failures = received > 0 ? 0 : failures + 1
      } catch (error) {
        if (signal.aborted || !this.client.token) return
        failures++
        this.log(`presence reconnect: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (signal.aborted || !this.client.token) return
      await abortableDelay(reconnectBackoffMs(Math.max(1, failures)), signal)
    }
  }

  async connectOnce(signal: AbortSignal = new AbortController().signal): Promise<number> {
    const token = this.client.token
    if (!token) return 0
    let res: Response
    try {
      res = await fetch(`${this.client.platformUrl}/v1/presence/stream`, {
        headers: {
          [PROTOCOL_HEADER]: PROTOCOL_VERSION,
          accept: 'text/event-stream',
          authorization: `Bearer ${token}`,
          'cache-control': 'no-cache',
        },
        signal,
      })
    } catch (error) {
      if (signal.aborted) return 0
      throw error
    }
    if (!res.ok) {
      const body = await responseBody(res)
      if (res.status === 401) this.client.clearSession()
      throw new ApiError(res.status, body)
    }
    if (!res.body) throw new Error('presence_stream_missing_body')
    let received = 0
    try {
      await consumeSse(res.body, async (event) => {
        if (event.event === 'logout') {
          this.client.clearSession()
          throw new PresenceEnded()
        }
        if (event.event !== 'probe') return
        let probe: PresenceProbe
        try { probe = JSON.parse(event.data) as PresenceProbe } catch { throw new Error('invalid_presence_probe') }
        if (
          typeof probe.leaseId !== 'string'
          || !Number.isInteger(probe.sequence)
          || typeof probe.sentAt !== 'string'
        ) throw new Error('invalid_presence_probe')
        received++
        const state = await this.handleProbe(probe)
        const ack = await this.client.platform('/v1/presence/ack', {
          method: 'POST',
          body: JSON.stringify({
            leaseId: probe.leaseId,
            sequence: probe.sequence,
            agentStatus: state.agentStatus,
            wakeFailures: state.wakeFailures,
            ...(state.logoutRequest ? { logoutRequest: state.logoutRequest } : {}),
          }),
        }) as { logoutAccepted?: boolean }
        if (ack.logoutAccepted) {
          this.client.clearSession()
          throw new PresenceEnded()
        }
      })
    } catch (error) {
      if (error instanceof PresenceEnded || signal.aborted) return received
      if (error instanceof ApiError && error.status === 401) return received
      throw error
    }
    return received
  }
}
