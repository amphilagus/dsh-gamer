import { GamingClient } from './client.ts'
import type { GamerPlatform } from './config.ts'
import { logoutCurrentSession } from './logout.ts'

export interface SessionAccountIdentity {
  accountId: string
  playerId?: string
  username: string
  nickname?: string
}

export interface GamerSessionState {
  readonly sessionId: string
  platform?: GamerPlatform
  client?: GamingClient
  account?: SessionAccountIdentity
}

export interface SessionManagerHooks {
  onClientChanged?: (
    sessionId: string,
    previous: GamingClient | undefined,
    next: GamingClient | undefined,
  ) => void
  onTokenChanged?: (sessionId: string, client: GamingClient, token: string | undefined) => void
}

export class SessionManagerError extends Error {
  readonly code: 'unknown_platform'

  constructor(code: 'unknown_platform', message: string) {
    super(message)
    this.code = code
  }
}

export type SessionTransitionResult =
  | { ok: true; changed: boolean; alreadyCurrent?: boolean; state: GamerSessionState }
  | { ok: false; changed: false; state: GamerSessionState; logout: unknown }

export class GamerSessionManager {
  private readonly platforms: Map<string, GamerPlatform>
  private readonly sessions = new Map<string, GamerSessionState>()
  private readonly hooks: SessionManagerHooks

  constructor(platforms: readonly GamerPlatform[], hooks: SessionManagerHooks = {}) {
    this.platforms = new Map(platforms.map((row) => [row.id, row]))
    this.hooks = hooks
  }

  ensure(sessionId: string): GamerSessionState {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const state: GamerSessionState = { sessionId }
    this.sessions.set(sessionId, state)
    return state
  }

  getPlatform(platformId: string): GamerPlatform {
    const platform = this.platforms.get(platformId)
    if (!platform) throw new SessionManagerError('unknown_platform', `Unknown platform "${platformId}".`)
    return platform
  }

  listPlatforms(): readonly GamerPlatform[] {
    return [...this.platforms.values()]
  }

  private replaceClient(state: GamerSessionState, platform: GamerPlatform): void {
    const previous = state.client
    if (previous) {
      previous.clearSession()
      previous.onTokenChanged = undefined
    }
    const next = new GamingClient(platform.url)
    state.platform = platform
    state.client = next
    state.account = undefined
    next.onTokenChanged = (token) => {
      if (state.client !== next) return
      if (!token) state.account = undefined
      this.hooks.onTokenChanged?.(state.sessionId, next, token)
    }
    this.hooks.onClientChanged?.(state.sessionId, previous, next)
  }

  async selectPlatform(sessionId: string, platformId: string): Promise<SessionTransitionResult> {
    const state = this.ensure(sessionId)
    const target = this.getPlatform(platformId)
    if (state.platform?.id === target.id && state.client) {
      return { ok: true, changed: false, state }
    }
    if (state.client?.token) {
      const logout = await logoutCurrentSession(state.client)
      if (!logout.ok) return { ok: false, changed: false, state, logout }
    }
    this.replaceClient(state, target)
    return { ok: true, changed: true, state }
  }

  /** Preflight target selection and safely release any different active account. */
  async prepareLogin(
    sessionId: string,
    platformId: string,
    accountId: string,
  ): Promise<SessionTransitionResult> {
    const state = this.ensure(sessionId)
    const target = this.getPlatform(platformId)
    if (state.platform?.id === target.id && state.client?.token && state.account?.accountId === accountId) {
      return { ok: true, changed: false, alreadyCurrent: true, state }
    }
    if (state.client?.token) {
      const logout = await logoutCurrentSession(state.client)
      if (!logout.ok) return { ok: false, changed: false, state, logout }
    }
    // Saved-account login always gets a fresh client after the old session is
    // safely released. This also resets room/match/notices lifecycle state and
    // prevents a stopped presence stream from being reused for another account.
    this.replaceClient(state, target)
    return { ok: true, changed: true, state }
  }

  markAccount(state: GamerSessionState, identity: SessionAccountIdentity): void {
    if (!state.client?.token) throw new Error('cannot mark an account without an active platform token')
    state.account = { ...identity }
  }
}
