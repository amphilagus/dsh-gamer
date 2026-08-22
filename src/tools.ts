/**
 * Model-facing gamer tools. Parameters use DSH ParameterSchemaSpec (per-field
 * `required: true`), not a JSON Schema `{ type: 'object', properties }` wrapper.
 * `defineTool` is provided by the host at runtime.
 *
 * Each tool call must go through the session manager so platform, token,
 * account, and match state stay bound to `exec.agent.id`.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { asJson, mapToolError, readyLocalError, requireLogin } from './auth-gate.ts'
import { ApiError, type GamingClient } from './client.ts'
import { connectEntrySession } from './entry-session.ts'
import { leaveCurrentMatchThroughPlatform } from './match-departure.ts'
import { logoutCurrentSession } from './logout.ts'
import { fetchNotices, injectNotices, takeFresh, type InjectAgent } from './notices.ts'
import { MAX_WAIT_TIMEOUT_SECONDS, normalizeWaitTimeoutSeconds } from './polling.ts'
import { SavedAccountError, type SavedAccountStore, savedAccountId } from './saved-accounts.ts'
import {
  GamerSessionManager,
  SessionManagerError,
  type GamerSessionState,
} from './session-manager.ts'
import { discoverResumableMatches } from './recovery.ts'

export interface ToolExec {
  agent?: InjectAgent
}

export interface GamerToolServices {
  sessions: GamerSessionManager
  accounts: SavedAccountStore
}

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true } as const
const ALREADY_LOG = {
  ok: false,
  error: 'already_logged_in',
  message: 'This DSH session is already logged in. Call gamer_account action=logout before switching accounts.',
} as const
const NO_SESSION = { ok: false, message: 'no session' } as const
const PLATFORM_NOT_SELECTED = {
  ok: false,
  error: 'platform_not_selected',
  message: 'Select a configured platform with gamer_platform action=select before logging in or using gamer tools.',
} as const

function stateFor(services: GamerToolServices, exec: ToolExec): GamerSessionState | undefined {
  const sessionId = exec.agent?.id
  return sessionId ? services.sessions.ensure(String(sessionId)) : undefined
}

function selectedClient(state: GamerSessionState | undefined) {
  if (!state) return { error: asJson(NO_SESSION) }
  if (!state.client || !state.platform) return { error: asJson(PLATFORM_NOT_SELECTED) }
  return { state, client: state.client }
}

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

function fail(error: unknown) {
  if (error instanceof SavedAccountError || error instanceof SessionManagerError) {
    return asJson({ ok: false, error: error.code, message: error.message })
  }
  return mapToolError(error)
}

function savedAccountFailure(error: unknown) {
  if (error instanceof SavedAccountError) return fail(error)
  return asJson({
    ok: false,
    error: 'saved_account_storage_error',
    message: 'Saved account storage is unavailable. No credential details were returned.',
  })
}

async function requireActiveLogin(client: GamingClient) {
  const gated = requireLogin(client)
  if (gated) return gated
  try {
    await client.reportActivity()
    return undefined
  } catch (error) {
    return fail(error)
  }
}

function omitSpectatorUrl(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(omitSpectatorUrl)
  const out: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'spectatorUrl') continue
    out[key] = omitSpectatorUrl(nested)
  }
  return out
}

function withSpectator(body: unknown, client: GamingClient): Record<string, unknown> {
  const row = (body && typeof body === 'object' && !Array.isArray(body))
    ? body as Record<string, unknown>
    : { result: body }
  const nestedRoom = (row.room && typeof row.room === 'object' && !Array.isArray(row.room))
    ? row.room as Record<string, unknown>
    : {}
  const roomId =
    (typeof row.roomId === 'string' ? row.roomId : undefined)
    ?? (typeof nestedRoom.roomId === 'string' ? nestedRoom.roomId : undefined)
    ?? client.roomId
  const watchUrl = roomId ? `${client.platformUrl}/rooms/${roomId}` : null
  return omitSpectatorUrl({
    ok: true,
    watchUrl,
    humanWatch: watchUrl === null
      ? 'No table watchUrl yet — sit at a room first. After a match starts, open that platform table page.'
      : 'Open watchUrl in a browser. It is the platform table page (view-only). Moves require a match ticket. Do not send the game spectate URL to the human.',
    ...row,
  }) as Record<string, unknown>
}

function pickMatchId(row: Record<string, unknown>, client: GamingClient): string | null {
  const room = (row.room && typeof row.room === 'object' && !Array.isArray(row.room))
    ? row.room as Record<string, unknown>
    : {}
  const session = (row.session && typeof row.session === 'object' && !Array.isArray(row.session))
    ? row.session as Record<string, unknown>
    : {}
  for (const value of [row.matchId, room.matchId, session.matchId, client.matchId]) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

async function withMatchExtras(body: unknown, client: GamingClient, agent?: InjectAgent) {
  const base = withSpectator(body, client)
  const matchId = pickMatchId(base, client)
  if (matchId) client.matchId = matchId
  if (!matchId || !client.token) {
    return asJson({
      ...base,
      systemNotices: [],
      systemNoticesNote: !client.token
        ? 'Not logged in; platform notices are unavailable.'
        : 'No matchId yet — start/end notices appear after players ready on the room and a match is minted.',
    })
  }
  try {
    const notices = await fetchNotices(client)
    if (agent?.id) injectNotices(agent, takeFresh(String(agent.id), notices))
    return asJson({ ...base, matchId, systemNotices: notices })
  } catch (error) {
    return asJson({
      ...base,
      matchId,
      systemNotices: [],
      systemNoticesError: error instanceof ApiError
        ? { status: error.status, body: error.body ?? null }
        : (error instanceof Error ? error.message : String(error)),
    })
  }
}

function remember(client: GamingClient, row: unknown, fallbackSlug?: unknown) {
  const obj = (row && typeof row === 'object' && !Array.isArray(row)) ? row as Record<string, unknown> : {}
  const room = (obj.room && typeof obj.room === 'object' && !Array.isArray(obj.room))
    ? obj.room as Record<string, unknown>
    : {}
  const gameSlug = (typeof obj.gameSlug === 'string' ? obj.gameSlug : undefined)
    ?? (typeof room.gameSlug === 'string' ? room.gameSlug : undefined)
    ?? (typeof fallbackSlug === 'string' ? fallbackSlug : undefined)
  const roomId = (typeof obj.roomId === 'string' ? obj.roomId : undefined)
    ?? (typeof room.roomId === 'string' ? room.roomId : undefined)
  const ticket = typeof obj.ticket === 'string' ? obj.ticket : undefined
  const matchId = typeof obj.matchId === 'string' ? obj.matchId : undefined
  const seat = typeof obj.seat === 'string' ? obj.seat : undefined
  const role = typeof obj.role === 'string' ? obj.role : undefined
  const status = typeof obj.status === 'string' ? obj.status : undefined
  client.rememberMatch(
    {
      gameSlug,
      roomId,
      ticket,
      matchId,
      seat,
      role,
      status,
      spectatorUrl: typeof obj.spectatorUrl === 'string' ? obj.spectatorUrl : undefined,
      gameBaseUrl: typeof obj.gameBaseUrl === 'string' ? obj.gameBaseUrl : undefined,
    },
    { clearTicket: Boolean(roomId) && !ticket },
  )
}

function requireRoomId(args: { roomId?: unknown }, client: GamingClient) {
  if (typeof args.roomId === 'string' && args.roomId.length > 0) return args.roomId
  if (client.roomId) return client.roomId
  return undefined
}

function tableNoFrom(args: { tableNo?: unknown }): number | string | undefined {
  if (args.tableNo == null || args.tableNo === '') return undefined
  if (typeof args.tableNo === 'number') return args.tableNo
  const raw = String(args.tableNo).trim()
  const n = Number(raw)
  return Number.isFinite(n) ? n : raw
}

export async function sessionIfTicket(client: GamingClient, row: unknown, fallbackSlug?: unknown) {
  return connectEntrySession(client, row, fallbackSlug)
}

function publicAccount(
  body: { playerId?: string; username?: string; nickname?: string },
  recovery?: unknown,
  extras: Record<string, unknown> = {},
) {
  return asJson({
    ok: true,
    playerId: body.playerId ?? null,
    username: body.username ?? null,
    nickname: body.nickname ?? body.username ?? null,
    ...(recovery ? { recovery } : {}),
    ...extras,
  })
}

async function recoveryAfterLogin(client: GamingClient): Promise<unknown> {
  try {
    return await discoverResumableMatches(client)
  } catch (error) {
    return {
      status: 'discovery_failed',
      retryable: true,
      diagnostic: error instanceof ApiError
        ? { status: error.status }
        : (error instanceof Error ? error.message : String(error)),
    }
  }
}

function parseObjectJson(raw: unknown, field: string): { ok: true, value: Record<string, unknown> } | { ok: false, error: ReturnType<typeof asJson> } {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim().length === 0)) {
    return { ok: true, value: {} }
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: asJson({ ok: false, error: `invalid_${field}`, message: `${field} must be a JSON object string.` }) }
  }
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return { ok: false, error: asJson({ ok: false, error: `invalid_${field}`, message: `${field} must be a JSON object string.` }) }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: asJson({ ok: false, error: `${field}_must_be_object`, message: `${field} must parse to a JSON object.` }) }
  }
  return { ok: true, value: payload as Record<string, unknown> }
}

export function registerTools(ctx: Context, services: GamerToolServices): void {
  ctx.tools.register(defineTool({
    name: 'gamer_platform',
    description: 'List, inspect, or select one trusted configured DSH Gaming platform for THIS session. Every new session starts unselected. Selecting a different platform logs out the active account first; a failed logout aborts the switch without losing current state. Platforms cannot be added by the agent.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'current', 'select'],
        description: 'list returns configured platforms; current returns this session selection; select requires platformId.',
      },
      platformId: { type: 'string', description: 'Configured platform id for select, e.g. community or local.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const state = stateFor(services, exec)
      if (!state) return asJson(NO_SESSION)
      try {
        if (args.action === 'list') {
          return asJson({
            ok: true,
            selectedPlatformId: state.platform?.id ?? null,
            platforms: services.sessions.listPlatforms(),
          })
        }
        if (args.action === 'current') {
          return asJson({
            ok: true,
            status: !state.platform ? 'platform_not_selected' : (state.client?.token ? 'logged_in' : 'not_logged_in'),
            platform: state.platform ?? null,
            loggedIn: Boolean(state.client?.token),
            account: state.account ?? null,
          })
        }
        if (args.action === 'select') {
          if (typeof args.platformId !== 'string' || args.platformId.length === 0) {
            return asJson({ ok: false, error: 'missing_platform_id', message: 'select requires platformId.' })
          }
          const transition = await services.sessions.selectPlatform(state.sessionId, args.platformId)
          if (!transition.ok) {
            return asJson({
              ...(transition.logout as object),
              switchAborted: true,
              selectedPlatformId: transition.state.platform?.id ?? null,
            })
          }
          return asJson({
            ok: true,
            changed: transition.changed,
            status: transition.state.client?.token ? 'logged_in' : 'not_logged_in',
            platform: transition.state.platform,
            loggedIn: Boolean(transition.state.client?.token),
          })
        }
        return asJson({ ok: false, error: 'unknown_action' })
      } catch (error) {
        return fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gamer_account',
    description: 'Register, login, logout, inspect, or use saved accounts for THIS DSH session. Select a platform first for register/login. remember=true stores the password only after successful authentication. use_saved safely logs out any different current account, selects the saved platform, and logs in. Login/register also discovers bot-controlled matches. Tokens, passwords, and credential refs are never returned.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['register', 'login', 'logout', 'whoami', 'set_nickname', 'list_saved', 'use_saved', 'forget_saved'],
        description: 'register/login need username + password and an already selected platform. Set remember=true to save. list_saved and forget_saved do not require platform selection or login. use_saved takes accountId.',
      },
      username: { type: 'string', description: 'Required for register and login. ASCII login handle, not the display name.' },
      password: { type: 'string', description: 'Required for register and login.' },
      nickname: { type: 'string', description: 'Display name. Optional on register (defaults to username). Required for set_nickname. Chinese and ._ - ~ · ☆ ★ ♡ allowed.' },
      remember: { type: 'boolean', description: 'For successful register/login only. true saves this platform username and password in DSH credentials. Default false.' },
      accountId: { type: 'string', description: 'Stable saved id from list_saved, e.g. community/alice. Required for use_saved and forget_saved.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const state = stateFor(services, exec)
      if (!state) return asJson(NO_SESSION)
      try {
        if (args.action === 'list_saved') {
          try {
            return asJson({ ok: true, accounts: await services.accounts.list() })
          } catch (error) {
            return savedAccountFailure(error)
          }
        }
        if (args.action === 'forget_saved') {
          if (typeof args.accountId !== 'string' || args.accountId.length === 0) {
            return asJson({ ok: false, error: 'missing_account_id', message: 'forget_saved requires accountId.' })
          }
          try {
            return asJson({ ok: true, accountId: args.accountId, forgotten: await services.accounts.forget(args.accountId) })
          } catch (error) {
            return savedAccountFailure(error)
          }
        }
        if (args.action === 'use_saved') {
          if (typeof args.accountId !== 'string' || args.accountId.length === 0) {
            return asJson({ ok: false, error: 'missing_account_id', message: 'use_saved requires accountId.' })
          }
          let saved: Awaited<ReturnType<SavedAccountStore['resolve']>>
          try {
            saved = await services.accounts.resolve(args.accountId)
          } catch (error) {
            return savedAccountFailure(error)
          }
          services.sessions.getPlatform(saved.account.platformId)
          const transition = await services.sessions.prepareLogin(
            state.sessionId,
            saved.account.platformId,
            saved.account.accountId,
          )
          if (!transition.ok) {
            return asJson({
              ...(transition.logout as object),
              switchAborted: true,
              selectedPlatformId: transition.state.platform?.id ?? null,
            })
          }
          const targetClient = transition.state.client!
          if (transition.alreadyCurrent) {
            const gated = await requireActiveLogin(targetClient)
            if (gated) return gated
            const me = await targetClient.platform('/v1/me') as { playerId?: string; username?: string; nickname?: string }
            return publicAccount(me, undefined, {
              accountId: saved.account.accountId,
              platformId: saved.account.platformId,
              saved: true,
              alreadyCurrent: true,
            })
          }
          const session = await targetClient.platform('/v1/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username: saved.account.username, password: saved.password }),
          }) as { token: string; playerId?: string; username?: string; nickname?: string }
          targetClient.clearMatchState()
          targetClient.token = session.token
          services.sessions.markAccount(transition.state, {
            accountId: saved.account.accountId,
            playerId: session.playerId,
            username: session.username ?? saved.account.username,
            nickname: session.nickname,
          })
          return publicAccount(session, await recoveryAfterLogin(targetClient), {
            accountId: saved.account.accountId,
            platformId: saved.account.platformId,
            saved: true,
          })
        }
        const selected = selectedClient(state)
        if ('error' in selected) return selected.error
        const client = selected.client
        if (args.action === 'logout') {
          if (client.token) await client.reportActivity().catch(() => false)
          return asJson(await logoutCurrentSession(client))
        }
        if (args.action === 'whoami') {
          const gated = await requireActiveLogin(client)
          if (gated) return gated
          const me = await client.platform('/v1/me') as { playerId?: string; username?: string; nickname?: string }
          const accountId = savedAccountId(state.platform!.id, me.username ?? state.account?.username ?? '')
          services.sessions.markAccount(state, {
            accountId,
            playerId: me.playerId,
            username: me.username ?? state.account?.username ?? '',
            nickname: me.nickname,
          })
          return publicAccount(me, undefined, { platformId: state.platform!.id, accountId })
        }
        if (args.action === 'set_nickname') {
          const gated = await requireActiveLogin(client)
          if (gated) return gated
          if (typeof args.nickname !== 'string' || args.nickname.length === 0) {
            return asJson({ ok: false, error: 'missing_nickname', message: 'set_nickname requires nickname.' })
          }
          const me = await client.platform('/v1/me', {
            method: 'PATCH',
            body: JSON.stringify({ nickname: args.nickname }),
          }) as { playerId?: string; username?: string; nickname?: string }
          if (state.account) services.sessions.markAccount(state, { ...state.account, nickname: me.nickname })
          return publicAccount(me, undefined, {
            platformId: state.platform!.id,
            accountId: state.account?.accountId ?? null,
          })
        }
        if (client.token) {
          const gated = await requireActiveLogin(client)
          if (gated) return gated
          return asJson(ALREADY_LOG)
        }
        if (args.action !== 'register' && args.action !== 'login') {
          return asJson({ ok: false, error: 'unknown_action' })
        }
        if (typeof args.username !== 'string' || args.username.length === 0) {
          return asJson({ ok: false, error: 'missing_username', message: `${args.action} requires username.` })
        }
        if (typeof args.password !== 'string' || args.password.length === 0) {
          return asJson({ ok: false, error: 'missing_password', message: `${args.action} requires password.` })
        }
        const session = await client.platform(
          args.action === 'register' ? '/v1/auth/register' : '/v1/auth/login',
          {
            method: 'POST',
            body: JSON.stringify({
              username: args.username,
              password: args.password,
              ...(args.action === 'register' && typeof args.nickname === 'string' && args.nickname.length > 0
                ? { nickname: args.nickname }
                : {}),
            }),
          },
        ) as { token: string; playerId?: string; username?: string; nickname?: string }
        client.clearMatchState()
        client.token = session.token
        const username = session.username ?? args.username
        const accountId = savedAccountId(state.platform!.id, username)
        services.sessions.markAccount(state, {
          accountId,
          playerId: session.playerId,
          username,
          nickname: session.nickname,
        })
        let saved = false
        let saveError: { code: string; message: string } | undefined
        if (args.remember === true) {
          try {
            await services.accounts.save(state.platform!.id, username, args.password)
            saved = true
          } catch {
            saveError = { code: 'credential_save_failed', message: 'Login succeeded, but the saved credential could not be persisted.' }
          }
        }
        return publicAccount(session, await recoveryAfterLogin(client), {
          platformId: state.platform!.id,
          accountId,
          loggedIn: true,
          saved,
          ...(saveError ? { saveError } : {}),
        })
      } catch (error) {
        return fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gamer_catalog',
    description: 'List listed games or fetch one catalog row. Requires this session to be logged in. Only spectator-healthy games with how-to-play are listed. Does not list tables — use gamer_room action=list.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list_games', 'get_game'],
        description: 'list_games returns the catalog. get_game takes gameSlug.',
      },
      gameSlug: { type: 'string', description: 'For get_game, e.g. gomoku or go.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const selected = selectedClient(stateFor(services, exec))
      if ('error' in selected) return selected.error
      const client = selected.client
      const gated = await requireActiveLogin(client)
      if (gated) return gated
      try {
        if (args.action === 'list_games') {
          return asJson({ ok: true, ...(await client.platform('/v1/games') as object) })
        }
        const all = await client.platform('/v1/games') as { games: Array<{ slug: string }> }
        const game = all.games.find((row) => row.slug === args.gameSlug)
        return asJson(game ? { ok: true, ...game } : { ok: false, error: 'not_found' })
      } catch (error) {
        return fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gamer_how_to_play',
    description: 'Fetch in-match how-to-play: markdown, actSchema, and optional queries dictionary. Requires this session to be logged in. Not lobby or login. Call before the first gamer_act. For gamer_act action=act use actionJson matching actSchema. For gamer_act action=query use a name from queries.',
    parameters: {
      gameSlug: {
        type: 'string',
        description: 'Catalog slug, e.g. gomoku. Optional if this session already sat at a table for that game.',
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const selected = selectedClient(stateFor(services, exec))
      if ('error' in selected) return selected.error
      const client = selected.client
      const gated = await requireActiveLogin(client)
      if (gated) return gated
      const slug = (typeof args.gameSlug === 'string' && args.gameSlug.length > 0)
        ? args.gameSlug
        : client.gameSlug
      if (!slug) {
        return asJson({ ok: false, error: 'missing_game_slug', message: 'Pass gameSlug or sit at a table first.' })
      }
      try {
        const doc = await client.platform(`/v1/games/${encodeURIComponent(slug)}/how-to-play`)
        client.gameSlug = slug
        return asJson({
          ok: true,
          usage: 'Use markdown for game rules, roles, queries, and action semantics; Gamer system and skill instructions control the session lifecycle. gamer_act action=act: actionJson matching actSchema. gamer_act action=query: name from queries (argsJson optional). When yourTurn is false, finish the current agent task; the background reminder will reactivate play. Do not use this document for tables or login.',
          ...(doc as object),
        })
      } catch (error) {
        return fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gamer_room',
    description: 'Hall tables and match recovery on the platform. Requires login. list returns the numbered table pool. enter/join sits at a table; entering an original bot-controlled table asks the game to return that seat before issuing a new ticket. ready starts when enough players are table-ready. leave uses the platform departure policy. Do not create rooms.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'enter', 'join', 'get', 'ready', 'leave', 'get_match'],
        description: 'list/enter/join/get/ready/leave/get_match hit the platform. join of the original room coordinates bot-seat recovery. get is read-only. ready mints a ticket when enough players are table-ready.',
      },
      gameSlug: { type: 'string', description: 'For enter, list filter, or join by tableNo. e.g. gomoku.' },
      tableNo: { type: 'string', description: 'Hall table number (1–100). For enter or join: sit at that numbered table. Omit to auto-sit on enter.' },
      roomId: { type: 'string', description: 'For join, get, ready, leave. Defaults to this session\'s table. join may use gameSlug+tableNo instead.' },
      matchId: { type: 'string', description: 'For get_match, defaults to the current match.' },
      ready: {
        type: 'string',
        enum: ['true', 'false'],
        description: 'For action=ready on the table. Default true. false un-readies.',
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    timeoutMs: 35_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const selected = selectedClient(stateFor(services, exec))
      if ('error' in selected) return selected.error
      const client = selected.client
      const gated = await requireActiveLogin(client)
      if (gated) return gated
      const out = (value: unknown) => withMatchExtras(value, client, exec.agent)
      try {
        if (args.action === 'list') {
          const q = args.gameSlug ? `?gameSlug=${encodeURIComponent(String(args.gameSlug))}` : ''
          return asJson({ ok: true, ...(await client.platform(`/v1/rooms${q}`) as object) })
        }
        if (args.action === 'enter') {
          const tableNo = tableNoFrom(args)
          const row = await client.platform('/v1/rooms', {
            method: 'POST',
            body: JSON.stringify({ gameSlug: args.gameSlug, ...(tableNo != null ? { tableNo } : {}) }),
          })
          return await out(await sessionIfTicket(client, row, args.gameSlug))
        }
        if (args.action === 'join') {
          const tableNo = tableNoFrom(args)
          if (tableNo != null) {
            const slug = typeof args.gameSlug === 'string' && args.gameSlug
              ? args.gameSlug
              : client.gameSlug
            if (!slug) return asJson({ ok: false, error: 'missing_game_slug' })
            const row = await client.platform('/v1/rooms', {
              method: 'POST',
              body: JSON.stringify({ gameSlug: slug, tableNo }),
            })
            return await out(await sessionIfTicket(client, row, slug))
          }
          const local = readyLocalError(client, args)
          if (local) return local
          const roomId = requireRoomId(args, client)!
          const row = await client.platform(`/v1/rooms/${roomId}/join`, { method: 'POST', body: '{}' })
          return await out(await sessionIfTicket(client, row, args.gameSlug))
        }
        if (args.action === 'get') {
          const local = readyLocalError(client, args)
          if (local) return local
          const roomId = requireRoomId(args, client)!
          const row = await client.platform(`/v1/rooms/${roomId}`)
          remember(client, row, args.gameSlug)
          return await out(row)
        }
        if (args.action === 'ready') {
          const local = readyLocalError(client, args)
          if (local) return local
          const roomId = requireRoomId(args, client)!
          const row = await client.platform(`/v1/rooms/${roomId}/ready`, {
            method: 'POST',
            body: JSON.stringify({ ready: args.ready !== 'false' }),
          })
          return await out(await sessionIfTicket(client, row, args.gameSlug))
        }
        if (args.action === 'leave') {
          const local = readyLocalError(client, args)
          if (local) return local
          const roomId = requireRoomId(args, client)!
          const row = await client.platform(`/v1/rooms/${roomId}/leave`, { method: 'POST', body: '{}' })
          client.clearMatchState()
          return asJson(withSpectator(row, client))
        }
        if (args.action === 'get_match') {
          const id = args.matchId ?? client.matchId
          const row = await client.platform(`/v1/matches/${id}`)
          remember(client, row, args.gameSlug)
          return await out(row)
        }
        return asJson({ ok: false, error: 'unknown_action' })
      } catch (error) {
        return fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gamer_play',
    description: 'Read the current in-match view or leave through the platform so a replacement can continue. Requires this session to be logged in. Not table enter/ready. Not judgment or moves — those are gamer_act. Read events on every view (self last ply plus the latest non-self ply, relation other) before the board. A ticket means status is already playing with a role. watchUrl is the platform table page for the human (view-only). view.seat is the hall slot (1..maxPlayers); view.role is the in-game identity from how-to-play. yourTurn true means follow current legalActions (may be pass/skip); several seats may be true at once.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['view', 'wait', 'leave'],
        description: 'view reads the game. leave exits the platform table, creates a durable departure, and lets the game install a replacement. Ready is gamer_room on the table, not this tool.',
      },
      timeoutSeconds: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_WAIT_TIMEOUT_SECONDS,
        description: 'Optional compatibility timeout in seconds; default 8.',
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    timeoutMs: 35_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const selected = selectedClient(stateFor(services, exec))
      if ('error' in selected) return selected.error
      const client = selected.client
      const gated = await requireActiveLogin(client)
      if (gated) return gated
      const out = (value: unknown) => withMatchExtras(value, client, exec.agent)
      try {
        if (args.action === 'view') {
          const view = await client.game('/v1/view')
          remember(client, view, client.gameSlug)
          return await out(view)
        }
        if (args.action === 'wait') {
          const view = await client.game('/v1/wait', {
            method: 'POST',
            body: JSON.stringify({ timeoutSeconds: normalizeWaitTimeoutSeconds(args.timeoutSeconds) }),
          })
          remember(client, view, client.gameSlug)
          return await out(view)
        }
        if (args.action === 'leave') {
          return asJson(await leaveCurrentMatchThroughPlatform(client))
        }
        return asJson({ ok: false, error: 'unknown_action' })
      } catch (error) {
        return fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gamer_act',
    description: 'In-match judgment and decision. Requires this session to be logged in. action=query is a named how-to-play query (no turn, no board change). action=act submits actionJson as POST /v1/act when yourTurn is true — send an object from the current legalActions (may be pass/skip, not a placement). Several seats may have yourTurn at once. Load gamer_how_to_play first. Do not invent query names. Do not use this for view or table operations.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['act', 'query'],
        description: 'query: POST /v1/query with name from how-to-play.queries. act: POST /v1/act with actionJson matching actSchema.',
      },
      actionJson: {
        type: 'string',
        description: 'For act: JSON object string for POST /v1/act. Shape from gamer_how_to_play actSchema or view.legalActions.',
      },
      name: {
        type: 'string',
        description: 'For query: key in how-to-play.queries, e.g. estimate_score or threats.',
      },
      argsJson: {
        type: 'string',
        description: 'For query: JSON object string of args. Default {}.',
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const selected = selectedClient(stateFor(services, exec))
      if ('error' in selected) return selected.error
      const client = selected.client
      const gated = await requireActiveLogin(client)
      if (gated) return gated
      const out = (value: unknown) => withMatchExtras(value, client, exec.agent)
      try {
        if (args.action === 'query') {
          if (typeof args.name !== 'string' || args.name.length === 0) {
            return asJson({
              ok: false,
              error: 'missing_query_name',
              message: 'query requires name from gamer_how_to_play queries. Do not invent names.',
            })
          }
          const parsed = parseObjectJson(args.argsJson, 'argsJson')
          if (!parsed.ok) return parsed.error
          return await out(await client.game('/v1/query', {
            method: 'POST',
            body: JSON.stringify({ name: args.name, args: parsed.value }),
          }))
        }
        const raw = args.actionJson
        if (typeof raw !== 'string' || raw.trim().length === 0) {
          return asJson({
            ok: false,
            error: 'missing_action_json',
            message: 'act requires actionJson. Call gamer_how_to_play and follow actSchema.',
          })
        }
        const parsed = parseObjectJson(raw, 'actionJson')
        if (!parsed.ok) return parsed.error
        return await out(await client.game('/v1/act', { method: 'POST', body: JSON.stringify(parsed.value) }))
      } catch (error) {
        return fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gamer_profile',
    description: 'Player profiles, match history, and leaderboards (verified match reports only). Requires this session to be logged in.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['me', 'player', 'leaderboard', 'history'],
        description: 'me is the logged-in player for THIS session. player/history take playerId. leaderboard requires gameSlug.',
      },
      playerId: { type: 'string', description: 'For player and history; history defaults to this session\'s player.' },
      gameSlug: { type: 'string', description: 'Required for leaderboard. Stats follow that game\'s scoring schema (W-L-D or points).' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const selected = selectedClient(stateFor(services, exec))
      if ('error' in selected) return selected.error
      const client = selected.client
      const gated = await requireActiveLogin(client)
      if (gated) return gated
      try {
        if (args.action === 'me') return publicAccount(await client.platform('/v1/me') as { playerId?: string; username?: string; nickname?: string })
        if (args.action === 'player') return asJson({ ok: true, ...(await client.platform(`/v1/players/${args.playerId}`) as object) })
        if (args.action === 'history') {
          const id = args.playerId ?? (await client.platform('/v1/me') as { playerId: string }).playerId
          return asJson({ ok: true, ...(await client.platform(`/v1/players/${id}/matches`) as object) })
        }
        if (args.action === 'leaderboard') {
          if (!args.gameSlug) {
            return asJson({ ok: false, error: 'missing_game_slug', message: 'leaderboard requires gameSlug.' })
          }
          return asJson({ ok: true, ...(await client.platform(`/v1/leaderboard?gameSlug=${encodeURIComponent(String(args.gameSlug))}`) as object) })
        }
        return asJson({ ok: false, error: 'unknown_action' })
      } catch (error) {
        return fail(error)
      }
    },
  }))
}
