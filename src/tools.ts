/**
 * Model-facing gamer tools. Parameters use DSH ParameterSchemaSpec (per-field
 * `required: true`), not a JSON Schema `{ type: 'object', properties }` wrapper.
 * `defineTool` is provided by the host at runtime.
 *
 * Each tool call must go through `clientFor(exec)` so token/ticket stay bound
 * to `exec.agent.id`. There is no process-wide client.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { asJson, mapToolError, readyLocalError, requireLogin } from './auth-gate.ts'
import { ApiError, type GamingClient } from './client.ts'
import { logoutCurrentSession } from './logout.ts'
import { fetchNotices, injectNotices, takeFresh, type InjectAgent } from './notices.ts'

export interface ToolExec {
  agent?: InjectAgent
}

export type ClientFor = (exec: ToolExec) => GamingClient | undefined

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true } as const
const ALREADY_LOG = {
  ok: false,
  error: 'already_logged_in',
  message: 'This DSH session is already logged in. Call gamer_account action=logout before switching accounts.',
} as const
const NO_SESSION = { ok: false, message: 'no session' } as const

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

function fail(error: unknown) {
  return mapToolError(error)
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
  remember(client, row, fallbackSlug)
  const ticket = (row && typeof row === 'object' && !Array.isArray(row))
    ? (row as { ticket?: string }).ticket
    : undefined
  if (ticket && client.ticket && client.gameBaseUrl) {
    const seated = await client.game('/v1/session', { method: 'POST', body: JSON.stringify({ ticket: client.ticket }) })
    remember(client, seated, fallbackSlug)
    return { room: row, session: seated }
  }
  return row
}

function publicAccount(body: { playerId?: string; username?: string; nickname?: string }) {
  return asJson({
    ok: true,
    playerId: body.playerId ?? null,
    username: body.username ?? null,
    nickname: body.nickname ?? body.username ?? null,
  })
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

export function registerTools(ctx: Context, clientFor: ClientFor): void {
  ctx.tools.register(defineTool({
    name: 'gamer_account',
    description: 'Register, login, logout, whoami, or set_nickname for THIS DSH session only. The only gamer_* tool allowed before login (set_nickname needs login). Login username is ASCII and unique (case-insensitive). Nickname is the hall display name (Chinese and ._ - ~ · ☆ ★ ♡ allowed, globally unique). One account at a time; logout automatically attempts to leave the current match and table, revokes this token, and clears local state. Token is never returned.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['register', 'login', 'logout', 'whoami', 'set_nickname'],
        description: 'register and login need username + password. Optional nickname on register. whoami, set_nickname, and logout use this session\'s token. Logout needs no username/password and is idempotent when already logged out.',
      },
      username: { type: 'string', description: 'Required for register and login. ASCII login handle, not the display name.' },
      password: { type: 'string', description: 'Required for register and login.' },
      nickname: { type: 'string', description: 'Display name. Optional on register (defaults to username). Required for set_nickname. Chinese and ._ - ~ · ☆ ★ ♡ allowed.' },
      platformUrl: { type: 'string', description: 'Override platform base URL for this call only if the user named a different host.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const client = clientFor(exec)
      if (!client) return asJson(NO_SESSION)
      try {
        if (typeof args.platformUrl === 'string' && args.platformUrl.length > 0) {
          client.platformUrl = args.platformUrl.replace(/\/$/, '')
        }
        if (args.action === 'logout') {
          return asJson(await logoutCurrentSession(client))
        }
        if (args.action === 'whoami') {
          const gated = requireLogin(client)
          if (gated) return gated
          return publicAccount(await client.platform('/v1/me') as { playerId?: string; username?: string; nickname?: string })
        }
        if (args.action === 'set_nickname') {
          const gated = requireLogin(client)
          if (gated) return gated
          if (typeof args.nickname !== 'string' || args.nickname.length === 0) {
            return asJson({ ok: false, error: 'missing_nickname', message: 'set_nickname requires nickname.' })
          }
          return publicAccount(await client.platform('/v1/me', {
            method: 'PATCH',
            body: JSON.stringify({ nickname: args.nickname }),
          }) as { playerId?: string; username?: string; nickname?: string })
        }
        if (client.token) return asJson(ALREADY_LOG)
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
        client.token = session.token
        return publicAccount(session)
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
      const client = clientFor(exec)
      if (!client) return asJson(NO_SESSION)
      const gated = requireLogin(client)
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
      const client = clientFor(exec)
      if (!client) return asJson(NO_SESSION)
      const gated = requireLogin(client)
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
          usage: 'Follow markdown. gamer_act action=act: actionJson matching actSchema. gamer_act action=query: name from queries (argsJson optional). Do not use this document for tables or login.',
          ...(doc as object),
        })
      } catch (error) {
        return fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gamer_room',
    description: 'Hall tables on the platform. Requires this session to be logged in. Each listed game has a fixed numbered pool (default 100). list returns every table including empty ones. enter (gameSlug, optional tableNo) sits at that table; omit tableNo to auto-sit (occupied unfull else lowest empty). join a table by roomId or by gameSlug+tableNo. get, ready (opens a match when enough seated players are table-ready, then issues a ticket), leave, get_match. Do not create rooms. One seat per game; leave before switching tables. There is no close. After match_ended you stay at the table until leave. Table ready is the only start gate — do not POST /v1/ready on the game.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'enter', 'join', 'get', 'ready', 'leave', 'get_match'],
        description: 'list/enter/join/get/ready/leave/get_match hit the platform. ready mints a ticket when enough players are table-ready. join does not start a match.',
      },
      gameSlug: { type: 'string', description: 'For enter, list filter, or join by tableNo. e.g. gomoku.' },
      tableNo: { type: 'string', description: 'Hall table number (1–100). For enter or join: sit at that numbered table. Omit to auto-sit on enter.' },
      roomId: { type: 'string', description: 'For join, get, ready, leave. Defaults to this session\'s table. join may use gameSlug+tableNo instead.' },
      matchId: { type: 'string', description: 'For get_match; defaults to the current match.' },
      ready: {
        type: 'string',
        enum: ['true', 'false'],
        description: 'For action=ready on the table. Default true. false un-readies.',
      },
      reason: { type: 'string', description: 'optional leave reason.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    timeoutMs: 35_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const client = clientFor(exec)
      if (!client) return asJson(NO_SESSION)
      const gated = requireLogin(client)
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
          if ((row as { ticket?: string }).ticket && (row as { gameBaseUrl?: string }).gameBaseUrl) {
            await client.game('/v1/session', { method: 'POST', body: JSON.stringify({ ticket: client.ticket }) }).catch(() => undefined)
          }
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
          if (client.ticket && client.gameBaseUrl) {
            try {
              await client.game('/v1/leave', {
                method: 'POST',
                body: JSON.stringify({ reason: args.reason }),
              })
            } catch { /* match already ended or no live session */ }
          }
          const row = await client.platform(`/v1/rooms/${roomId}/leave`, { method: 'POST', body: '{}' })
          remember(client, row, args.gameSlug)
          client.ticket = undefined
          return await out(row)
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
    description: 'In-match loop with the match ticket: view, wait, leave this game (you stay at the table). Requires this session to be logged in. Not table enter/ready. Not judgment or moves — those are gamer_act. Read events on every view/wait (self last ply plus the latest non-self ply, relation other) before the board. A ticket means status is already playing with a role. watchUrl is the platform table page for the human (view-only). wait is short (1–30s, default 8). view.seat is the hall slot (1..maxPlayers); view.role is the in-game identity from how-to-play. yourTurn true means follow current legalActions (may be pass/skip); several seats may be true at once.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['view', 'wait', 'leave'],
        description: 'view/wait/leave hit the game. leave forfeits this match only. Ready is gamer_room on the table, not this tool.',
      },
      timeoutSeconds: { type: 'integer', description: 'wait timeout, 1-30, default 8.' },
      reason: { type: 'string', description: 'optional leave reason.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    timeoutMs: 35_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const client = clientFor(exec)
      if (!client) return asJson(NO_SESSION)
      const gated = requireLogin(client)
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
            body: JSON.stringify({ timeoutSeconds: args.timeoutSeconds ?? 8 }),
          })
          remember(client, view, client.gameSlug)
          return await out(view)
        }
        if (args.action === 'leave') {
          return await out(await client.game('/v1/leave', {
            method: 'POST',
            body: JSON.stringify({ reason: args.reason }),
          }))
        }
        return asJson({ ok: false, error: 'unknown_action' })
      } catch (error) {
        return fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gamer_act',
    description: 'In-match judgment and decision. Requires this session to be logged in. action=query is a named how-to-play query (no turn, no board change). action=act submits actionJson as POST /v1/act when yourTurn is true — send an object from the current legalActions (may be pass/skip, not a placement). Several seats may have yourTurn at once. Load gamer_how_to_play first. Do not invent query names. Do not use this for view/wait/table.',
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
      const client = clientFor(exec)
      if (!client) return asJson(NO_SESSION)
      const gated = requireLogin(client)
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
      const client = clientFor(exec)
      if (!client) return asJson(NO_SESSION)
      const gated = requireLogin(client)
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
