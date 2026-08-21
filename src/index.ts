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
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { GamingClient } from './client.ts'
import { BackgroundProbeCoordinator } from './background.ts'
import { resolvePlatforms, type GamerConfig } from './config.ts'
import { registerNetworkShellGuard } from './guard.ts'
import {
  clearDeliveredNotices,
  fetchNotices,
  mergeEnter,
  noticeMessage,
  PLUGIN_NAME,
  pullNoticeMessages,
  stallMessage,
  takeFresh,
  type InjectAgent,
} from './notices.ts'
import { PresenceConnection } from './presence.ts'
import { createSavedAccountStore } from './saved-accounts.ts'
import { GamerSessionManager } from './session-manager.ts'
import { SKILL_PLAY, SKILL_PLAY_CONTENT } from './skills.ts'
import { registerTools, sessionIfTicket, type ToolExec } from './tools.ts'
import { isNewTicket, isStartOrEnd, viewIsYourTurn } from './wakeup.ts'

export const name = PLUGIN_NAME
export const inject = ['llm', 'tools', 'systemPrompt', 'skills', 'settings', 'credentials']

const TOOL_GUIDANCE =
  'Every new DSH session starts without a platform. Use gamer_platform list/current/select; ask the human which configured id to use, and never invent a URL. Selecting another platform logs out first and aborts on logout failure. '
  + 'Use gamer_account list_saved before selection when helpful. use_saved preflights the credential, selects its platform, and logs in; it never runs automatically. register/login require an already selected platform, and remember=true stores the password only after successful authentication. forget_saved removes only the stored credential, not an active login. '
  + 'Until this session is logged in, catalog/how-to-play/room/play/act/profile are blocked. No selection returns platform_not_selected; a selected platform without a token returns not_logged_in. '
  + 'Login username is ASCII and unique ignoring case. Nickname is the hall display name (Chinese and a few marks); set it on register or with gamer_account set_nickname. Duplicate names return username_taken or nickname_taken. '
  + 'Then gamer_catalog (list_games/get_game), '
  + 'gamer_how_to_play (in-match rules, actSchema, queries dictionary), '
  + 'gamer_room (list/enter/join/get/ready/leave/get_match), '
  + 'gamer_play (view/wait/leave), gamer_act (query then act), and gamer_profile. '
  + 'This DSH session may hold exactly one platform account at a time; token is bound to the session id. Saved accounts are shared through this DSH_HOME, but selections and active tokens are session-local. '
  + 'Account/platform switching asks the old platform to revoke this session and apply its durable game/table departure policy; read failures and do not force a switch. '
  + 'If already logged in, use whoami or logout — a second register/login returns already_logged_in. '
  + 'After login, recovery only reports original tables. To take control back, explicitly enter or join the listed roomId; room get is read-only. '
  + 'Do not assume you can see another session\'s account. '
  + 'Load gamer-play before the first play loop. Only gamer_room enter for listed: true games. Do not create rooms. '
  + 'gamer_room list shows all numbered tables including empty. Sit at a chosen table with enter/join tableNo. One seat per game; gamer_room leave before switching tables. '
  + 'Entering a table only takes a seat; gamer_room ready starts a match when enough players are table-ready. '
  + 'A ticket means the match is already playing with a role; gamer_play view/wait then gamer_act. Do not POST /v1/ready on the game. '
  + 'Hall seats are 1..maxPlayers from the catalog. view.seat is that slot; view.role is the how-to-play identity and appears only when status=playing. '
  + 'On every gamer_play view/wait, read events first (self last ply + latest non-self ply, relation other), then observation. '
  + 'If yourTurn is true, gamer_act using current legalActions (may be pass). Several seats may have yourTurn at once; if false, short wait. '
  + 'Platform match_started / match_ended arrive as <system-reminder> user messages (per-game record copy). '
  + 'After match_ended you stay at the table: gamer_room ready to play again, gamer_room leave if done. gamer_room leave, gamer_play leave, and account logout all use the platform-coordinated durable departure path so a game may install a replacement. '
  + 'Call gamer_how_to_play for the chosen slug before the first gamer_act; act uses actionJson matching actSchema; query uses a name from queries. '
  + 'gamer_play view/wait and gamer_act talk to the game with the match ticket; gamer_play leave is the deliberate exception and leaves through the platform. '
  + 'Always give the human watchUrl (the platform /rooms/{roomId} table page); it is view-only. Do not send the game spectate URL. wait timeoutSeconds is 1–30 (default 8) and only controls player-requested long polling; it is not a game action clock. Poll while yourTurn is false. '
  + 'Local bash is allowed; curl/wget/open and http(s) URLs in the shell are blocked — play only via gamer_*. '
  + 'Never paste the match ticket into the reply.'

export function apply(ctx: Context, config: GamerConfig = {}): void {
  if (config.enabled !== true) {
    ctx.logger?.(name).info('dsh-gamer disabled by config (enabled: false) — inert entry')
    return
  }

  const platforms = resolvePlatforms(config)
  const accounts = createSavedAccountStore(ctx)
  const agents = new Map<string, InjectAgent>()
  const coordinators = new Map<string, BackgroundProbeCoordinator>()
  const presenceConnections = new Map<string, PresenceConnection>()

  const rememberAgent = (agent: InjectAgent | undefined) => {
    if (!agent?.id) return
    agents.set(String(agent.id), agent)
  }

  let sessions: GamerSessionManager

  const ensureCoordinator = (sessionId: string) => {
    let coordinator = coordinators.get(sessionId)
    if (!coordinator) {
      coordinator = new BackgroundProbeCoordinator(
        () => agents.get(sessionId),
        async () => {
          const client = sessions.ensure(sessionId).client
          if (!client?.token || !client.roomId) {
            return { freshKinds: [], wakeMessages: [], seatedLive: false, yourTurn: false }
          }
          const prevTicket = client.ticket
          const prevMatchId = client.matchId
          const row = await client.platform(`/v1/rooms/${encodeURIComponent(client.roomId)}`) as {
            ticket?: string
            matchId?: string
          }
          if (isNewTicket(prevTicket, row.ticket)) await sessionIfTicket(client, row, client.gameSlug)
          const matchId = (typeof row.matchId === 'string' && row.matchId.length > 0)
            ? row.matchId
            : prevMatchId
          if (matchId) client.matchId = matchId
          const liveMatch = typeof row.matchId === 'string' && row.matchId.length > 0
          const notices = matchId ? await fetchNotices(client) : []
          const fresh = takeFresh(sessionId, notices)
          const seatedLive = Boolean(client.ticket) && liveMatch
          let yourTurn = false
          if (seatedLive && client.gameBaseUrl) {
            try { yourTurn = viewIsYourTurn(await client.game('/v1/view')) } catch { /* game unavailable */ }
          }
          return {
            freshKinds: fresh.map((notice) => notice.kind ?? ''),
            wakeMessages: fresh.filter((notice) => isStartOrEnd(notice.kind)).map(noticeMessage),
            seatedLive,
            yourTurn,
            stallMessage: stallMessage(),
          }
        },
        (message) => ctx.logger?.(name).warn(message),
      )
      coordinators.set(sessionId, coordinator)
    }
    return coordinator
  }

  sessions = new GamerSessionManager(platforms, {
    onClientChanged(sessionId, _previous, next) {
      presenceConnections.get(sessionId)?.stop()
      presenceConnections.delete(sessionId)
      coordinators.delete(sessionId)
      clearDeliveredNotices(sessionId)
      if (!next) return
      const coordinator = ensureCoordinator(sessionId)
      presenceConnections.set(sessionId, new PresenceConnection(
        next,
        async () => coordinator.onProbe(),
        (message) => ctx.logger?.(name).warn(message),
      ))
    },
    onTokenChanged(sessionId, _client, token) {
      const presence = presenceConnections.get(sessionId)
      if (token) presence?.start()
      else presence?.stop()
    },
  })

  const stateFor = (exec: ToolExec) => {
    const sessionId = exec.agent?.id
    if (!sessionId) return undefined
    rememberAgent(exec.agent)
    return sessions.ensure(String(sessionId))
  }

  registerTools(ctx, { sessions, accounts })

  ctx.effect(() => registerNetworkShellGuard(ctx))

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    rememberAgent(agent)
    let extras: Awaited<ReturnType<typeof pullNoticeMessages>> = []
    const client = stateFor({ agent })?.client
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

  ctx.on('agent/status', ({ agent, status }) => {
    rememberAgent(agent)
    ensureCoordinator(String(agent.id)).noteAgentStatus(status)
  })

  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> => {
    const source = next()
    if (options.sessionId === undefined) return source
    const sessionId = String(options.sessionId)
    return (async function* () {
      let sawOutput = false
      for await (const chunk of source) {
        if (!sawOutput && chunk.type !== 'usage' && chunk.type !== 'finish') {
          sawOutput = true
          coordinators.get(sessionId)?.noteModelOutput()
        }
        yield chunk
      }
    })()
  })

  ctx.effect(() => {
    return () => {
      for (const presence of presenceConnections.values()) presence.stop()
    }
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
  BUILTIN_PLATFORMS,
  COMMUNITY_PLATFORM_URL,
  LOCAL_PLATFORM_URL,
  resolvePlatforms,
  type GamerConfig,
  type GamerPlatform,
  type GamerPlatformConfig,
} from './config.ts'
export { savedAccountId, passwordCredentialRef, type SavedAccount } from './saved-accounts.ts'
export { SKILL_PLAY } from './skills.ts'
