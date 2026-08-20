/**
 * dsh-gamer: DSH bundle so an agent can register, find games, and play on a
 * dsh-gaming-platform instance.
 *
 * Off by default; the 游戏玩家 preset remounts it with `enabled: true`.
 * Tools register on that preset standing layer. Runtime skill `gamer-play`
 * is registered with `ctx.skills.register`, not via a skills/ folder.
 * Login tokens are keyed by DSH session id (`exec.agent.id`); sessions
 * never share a GamingClient.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { GamingClient } from './client.ts'
import { resolvePlatformUrl, type GamerConfig } from './config.ts'
import { registerNetworkShellGuard } from './guard.ts'
import {
  fetchNotices,
  mergeEnter,
  noticeMessage,
  PLUGIN_NAME,
  pullNoticeMessages,
  stallMessage,
  takeFresh,
  type InjectAgent,
} from './notices.ts'
import { SKILL_PLAY, SKILL_PLAY_CONTENT } from './skills.ts'
import { registerTools, sessionIfTicket, type ToolExec } from './tools.ts'
import {
  advanceStallClock,
  deliverWake,
  isNewTicket,
  isStartOrEnd,
  routeWake,
  shouldStall,
  viewIsYourTurn,
  type StallClock,
} from './wakeup.ts'

export const name = PLUGIN_NAME
export const inject = ['tools', 'systemPrompt', 'skills']

const TOOL_GUIDANCE =
  'Use gamer_account (register/login/whoami) first. Until this session is logged in, no other gamer_* tool is allowed — they return not_logged_in, not missing_room_id. '
  + 'Login username is ASCII and unique ignoring case. Nickname is the hall display name (Chinese and a few marks); set it on register or with gamer_account set_nickname. Duplicate names return username_taken or nickname_taken. '
  + 'Then gamer_catalog (list_games/get_game), '
  + 'gamer_how_to_play (in-match rules, actSchema, queries dictionary), '
  + 'gamer_room (list/enter/join/get/ready/leave/get_match), '
  + 'gamer_play (view/wait/leave), gamer_act (query then act), and gamer_profile. '
  + 'This DSH session may hold exactly one platform account; token is bound to the session id. '
  + 'If already logged in, whoami only — a second register/login returns "You have already log". '
  + 'Do not assume you can see another session\'s account. '
  + 'Load gamer-play before the first play loop. Only gamer_room enter for listed: true games. Do not create rooms. '
  + 'gamer_room list shows all numbered tables including empty. Sit at a chosen table with enter/join tableNo. One seat per game; gamer_room leave before switching tables. '
  + 'Entering a table only takes a seat; gamer_room ready starts a match when enough players are table-ready. '
  + 'A ticket means the match is already playing with a role; gamer_play view/wait then gamer_act. Do not POST /v1/ready on the game. '
  + 'Hall seats are 1..maxPlayers from the catalog. view.seat is that slot; view.role is the how-to-play identity and appears only when status=playing. '
  + 'On every gamer_play view/wait, read events first (self last ply + latest non-self ply, relation other), then observation. '
  + 'If yourTurn is true, gamer_act using current legalActions (may be pass). Several seats may have yourTurn at once; if false, short wait. '
  + 'Platform match_started / match_ended arrive as <system-reminder> user messages (per-game record copy). '
  + 'After match_ended you stay at the table: gamer_room ready to play again, gamer_room leave if done. '
  + 'Call gamer_how_to_play for the chosen slug before the first gamer_act; act uses actionJson matching actSchema; query uses a name from queries. '
  + 'gamer_play view/wait and gamer_act talk to the game with the match ticket, not the platform. '
  + 'Always give the human watchUrl (the platform /rooms/{roomId} table page); it is view-only. Do not send the game spectate URL. wait timeoutSeconds is 1–30 (default 8); poll while yourTurn is false. '
  + 'Local bash is allowed; curl/wget/open and http(s) URLs in the shell are blocked — play only via gamer_*. '
  + 'Never paste the match ticket into the reply.'

export function apply(ctx: Context, config: GamerConfig = {}): void {
  if (config.enabled !== true) {
    ctx.logger?.(name).info('dsh-gamer disabled by config (enabled: false) — inert entry')
    return
  }

  const platformUrl = resolvePlatformUrl(config)
  const clients = new Map<string, GamingClient>()
  const agents = new Map<string, InjectAgent>()
  const stallClocks = new Map<string, StallClock>()

  const rememberAgent = (agent: InjectAgent | undefined) => {
    if (!agent?.id) return
    agents.set(String(agent.id), agent)
  }

  const clientFor = (exec: ToolExec): GamingClient | undefined => {
    const sessionId = exec.agent?.id
    if (!sessionId) return undefined
    rememberAgent(exec.agent)
    let client = clients.get(sessionId)
    if (!client) {
      client = new GamingClient(platformUrl)
      clients.set(sessionId, client)
    }
    return client
  }

  registerTools(ctx, clientFor)

  ctx.effect(() => registerNetworkShellGuard(ctx))

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    rememberAgent(agent)
    let extras: Awaited<ReturnType<typeof pullNoticeMessages>> = []
    const client = clientFor({ agent })
    if (client && !signal.aborted) {
      try {
        extras = await pullNoticeMessages(client, String(agent.id))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.(name).warn(`gamer notice inject failed: ${message}`)
      }
    }
    return mergeEnter(await next(), extras)
  })

  ctx.effect(() => {
    const timer = setInterval(() => {
      void (async () => {
        for (const [sessionId, agent] of agents) {
          const client = clients.get(sessionId)
          if (!client?.token || !client.roomId) continue
          if (!agent.inject && !agent.followup) continue
          try {
            const prevTicket = client.ticket
            const prevMatchId = client.matchId
            const row = await client.platform(`/v1/rooms/${encodeURIComponent(client.roomId)}`) as {
              ticket?: string
              matchId?: string
            }
            const newTicket = isNewTicket(prevTicket, row.ticket)
            if (newTicket) await sessionIfTicket(client, row, client.gameSlug)
            const matchId = (typeof row.matchId === 'string' && row.matchId.length > 0)
              ? row.matchId
              : prevMatchId
            if (matchId) client.matchId = matchId
            const liveMatch = typeof row.matchId === 'string' && row.matchId.length > 0
            const notices = matchId ? await fetchNotices(client) : []
            const fresh = takeFresh(sessionId, notices)
            const wakeMsgs = fresh.filter((notice) => isStartOrEnd(notice.kind)).map(noticeMessage)
            const action = routeWake({
              status: agent.status,
              freshKinds: fresh.map((notice) => notice.kind ?? ''),
            })
            let alreadyWoke = false
            if (action !== 'none') {
              alreadyWoke = deliverWake(agent, wakeMsgs) === 'followup'
            }
            const seatedLive = Boolean(client.ticket) && liveMatch
            let yourTurn = false
            if (agent.status === 'idle' && seatedLive && client.gameBaseUrl) {
              try {
                yourTurn = viewIsYourTurn(await client.game('/v1/view'))
              } catch {
                yourTurn = false
              }
            }
            const now = Date.now()
            const clock = advanceStallClock(
              stallClocks.get(sessionId) ?? {},
              agent.status,
              seatedLive && yourTurn,
              now,
            )
            if (shouldStall(clock, now, alreadyWoke)) {
              deliverWake(agent, [stallMessage()])
              clock.lastStallAt = now
            }
            stallClocks.set(sessionId, clock)
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger?.(name).warn(`gamer wakeup failed: ${message}`)
          }
        }
      })()
    }, 2000)
    return () => clearInterval(timer)
  })

  ctx.skills.register({
    name: SKILL_PLAY,
    description: 'Play on a DSH Gaming platform: register/login, list games, load how-to-play, gamer_room enter/ready, gamer_play view/wait, gamer_act query then act, rematch at the same table, and give the human watchUrl (platform table page).',
    source: 'runtime',
    content: SKILL_PLAY_CONTENT,
  })

  ctx.systemPrompt.section({
    name: 'tool:gamer',
    order: 104,
    text: TOOL_GUIDANCE,
  })
}

export { GamingClient, ApiError } from './client.ts'
export {
  DEFAULT_PLATFORM_URL,
  LOCAL_PLATFORM_URL,
  resolvePlatformUrl,
  type GamerConfig,
} from './config.ts'
export { SKILL_PLAY } from './skills.ts'
