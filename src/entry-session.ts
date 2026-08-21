import { sanitizeAgentOutput } from './auth-gate.ts'
import { ApiError, type GamingClient } from './client.ts'

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
