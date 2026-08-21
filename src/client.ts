export const PROTOCOL_VERSION = '0.3'
export const PROTOCOL_HEADER = 'Dsh-Gaming-Protocol'

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.status = status
    this.body = body
  }
}

export class GamingClient {
  platformUrl: string
  private sessionToken?: string
  onTokenChanged?: (token: string | undefined) => void
  ticket?: string
  gameBaseUrl?: string
  spectatorUrl?: string
  matchId?: string
  /** Hall slot from the ticket / room. Never overwrite this with view.role. */
  seat?: string
  /** In-game identity from how-to-play, only after status=playing. */
  role?: string
  gameSlug?: string
  roomId?: string

  constructor(platformUrl: string) {
    this.platformUrl = platformUrl.replace(/\/$/, '')
  }

  get token() {
    return this.sessionToken
  }

  set token(value: string | undefined) {
    if (value === this.sessionToken) return
    this.sessionToken = value
    this.onTokenChanged?.(value)
  }

  clearMatchState() {
    this.ticket = undefined
    this.gameBaseUrl = undefined
    this.spectatorUrl = undefined
    this.matchId = undefined
    this.seat = undefined
    this.role = undefined
    this.gameSlug = undefined
    this.roomId = undefined
  }

  clearSession() {
    this.token = undefined
    this.clearMatchState()
  }

  private async req(url: string, init: RequestInit = {}, token?: string) {
    const res = await fetch(url, {
      ...init,
      headers: {
        [PROTOCOL_HEADER]: PROTOCOL_VERSION,
        accept: 'application/json',
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    })
    const text = await res.text()
    let body: unknown = text
    try { body = text ? JSON.parse(text) : null } catch { /* raw */ }
    if (!res.ok) throw new ApiError(res.status, body)
    return body
  }

  platform(path: string, init?: RequestInit) {
    return this.req(`${this.platformUrl}${path}`, init, this.token).catch((error) => {
      if (error instanceof ApiError && error.status === 401) this.clearSession()
      throw error
    })
  }

  async reportActivity(): Promise<boolean> {
    try {
      await this.platform('/v1/presence/activity', {
        method: 'POST',
        body: JSON.stringify({ kind: 'gamer_tool' }),
      })
      return true
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw error
      return false
    }
  }

  game(path: string, init?: RequestInit) {
    if (!this.gameBaseUrl) throw new Error('no_game_session')
    if (!this.ticket) throw new Error('no_ticket')
    return this.req(`${this.gameBaseUrl.replace(/\/$/, '')}${path}`, init, this.ticket)
  }

  rememberMatch(
    row: {
      ticket?: string
      gameBaseUrl?: string
      spectatorUrl?: string
      matchId?: string
      seat?: string
      role?: string
      status?: string
      gameSlug?: string
      roomId?: string
    },
    opts?: { clearTicket?: boolean },
  ) {
    if (row.ticket) this.ticket = row.ticket
    else if (opts?.clearTicket) this.ticket = undefined
    if (row.gameBaseUrl) this.gameBaseUrl = row.gameBaseUrl
    if (row.spectatorUrl) this.spectatorUrl = row.spectatorUrl
    if (row.matchId) this.matchId = row.matchId
    if (row.seat) this.seat = row.seat
    if (row.status === 'waiting') this.role = undefined
    else if (typeof row.role === 'string' && row.role.length > 0) this.role = row.role
    if (row.gameSlug) this.gameSlug = row.gameSlug
    if (row.roomId) this.roomId = row.roomId
  }
}
