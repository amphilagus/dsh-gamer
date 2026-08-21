import { sanitizeAgentOutput } from './auth-gate.ts'
import { ApiError, type GamingClient } from './client.ts'

type RoomSnapshot = {
  roomId?: string
  gameSlug?: string
  matchId?: string | null
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Parse the actual GET /v1/rooms/:id envelope (`{ room: { matchId } }`). */
export function readRoomSnapshot(row: unknown): RoomSnapshot {
  const obj = asRecord(row)
  const nested = asRecord(obj?.room)
  const source = nested ?? obj
  if (!source) return {}
  return {
    roomId: typeof source.roomId === 'string' ? source.roomId : undefined,
    gameSlug: typeof source.gameSlug === 'string' ? source.gameSlug : undefined,
    matchId: typeof source.matchId === 'string' || source.matchId === null
      ? source.matchId
      : undefined,
  }
}

function rememberEntry(client: GamingClient, row: unknown, fallbackSlug?: unknown) {
  const obj = (row && typeof row === 'object' && !Array.isArray(row)) ? row as Record<string, unknown> : {}
  const room = (obj.room && typeof obj.room === 'object' && !Array.isArray(obj.room))
    ? obj.room as Record<string, unknown>
    : {}
  const ticket = typeof obj.ticket === 'string' ? obj.ticket : undefined
  const roomId = (typeof obj.roomId === 'string' ? obj.roomId : undefined)
    ?? (typeof room.roomId === 'string' ? room.roomId : undefined)
  client.rememberMatch({
    ticket,
    roomId,
    gameSlug: (typeof obj.gameSlug === 'string' ? obj.gameSlug : undefined)
      ?? (typeof room.gameSlug === 'string' ? room.gameSlug : undefined)
      ?? (typeof fallbackSlug === 'string' ? fallbackSlug : undefined),
    matchId: typeof obj.matchId === 'string' ? obj.matchId : undefined,
    seat: typeof obj.seat === 'string' ? obj.seat : undefined,
    role: typeof obj.role === 'string' ? obj.role : undefined,
    status: typeof obj.status === 'string' ? obj.status : undefined,
    spectatorUrl: typeof obj.spectatorUrl === 'string' ? obj.spectatorUrl : undefined,
    gameBaseUrl: typeof obj.gameBaseUrl === 'string' ? obj.gameBaseUrl : undefined,
  }, { clearTicket: Boolean(roomId) && !ticket })
}

export async function connectEntrySession(client: GamingClient, row: unknown, fallbackSlug?: unknown) {
  rememberEntry(client, row, fallbackSlug)
  const ticket = (row && typeof row === 'object' && !Array.isArray(row))
    ? (row as { ticket?: string }).ticket
    : undefined
  if (!ticket || !client.ticket || !client.gameBaseUrl) return sanitizeAgentOutput(row)
  try {
    const session = await client.game('/v1/session', {
      method: 'POST',
      body: JSON.stringify({ ticket: client.ticket }),
    })
    if (session && typeof session === 'object' && !Array.isArray(session)) {
      client.rememberMatch(session as Parameters<GamingClient['rememberMatch']>[0])
    }
    return { room: sanitizeAgentOutput(row), session: sanitizeAgentOutput(session) }
  } catch (error) {
    return {
      ok: false,
      error: 'game_session_failed',
      retryable: true,
      room: sanitizeAgentOutput(row),
      diagnostic: error instanceof ApiError
        ? { status: error.status, body: sanitizeAgentOutput(error.body ?? null) }
        : (error instanceof Error ? error.message : String(error)),
    }
  }
}

/**
 * Bring a waiting room's newly observed live match into this Gamer session.
 * The room snapshot is read-only and contains no ticket, so fetch the
 * authenticated match card and connect its player ticket to the game.
 */
export async function synchronizeLiveRoomSession(
  client: GamingClient,
  roomResponse: unknown,
): Promise<{ liveMatchId?: string; connected: boolean }> {
  const room = readRoomSnapshot(roomResponse)
  if (room.roomId) client.roomId = room.roomId
  if (room.gameSlug) client.gameSlug = room.gameSlug
  if (!room.matchId) return { connected: false }

  const liveMatchId = room.matchId
  const alreadyConnected = client.matchId === liveMatchId && Boolean(client.ticket && client.gameBaseUrl)
  if (alreadyConnected) return { liveMatchId, connected: true }

  // A newly observed match supersedes any cached transport from the previous
  // game. Clear it before fetching so an old ticket can never reach a new URL.
  client.ticket = undefined
  client.gameBaseUrl = undefined
  client.spectatorUrl = undefined
  client.seat = undefined
  client.role = undefined
  client.matchId = liveMatchId

  const match = await client.platform(`/v1/matches/${encodeURIComponent(liveMatchId)}`)
  const connection = await connectEntrySession(client, match, room.gameSlug ?? client.gameSlug)
  const failed = asRecord(connection)?.error === 'game_session_failed'
  if (failed) {
    // Keep the observed match/room identity for notices, but force the next
    // probe to retry ticket acquisition and game-session connection.
    client.ticket = undefined
    client.gameBaseUrl = undefined
  }
  return {
    liveMatchId,
    connected: !failed
      && client.matchId === liveMatchId
      && Boolean(client.ticket && client.gameBaseUrl),
  }
}
