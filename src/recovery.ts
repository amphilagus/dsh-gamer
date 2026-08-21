import type { GamingClient } from './client.ts'

export type ResumableMatch = {
  matchId: string
  gameSlug: string
  roomId: string
  seat: string
  status: 'departure_pending' | 'bot_controlled'
  departureId: string
  spectatorUrl: string
}

export async function discoverResumableMatches(client: GamingClient) {
  const response = await client.platform('/v1/session/resumable-matches') as { matches: ResumableMatch[] }
  const matches = response.matches.map(({ spectatorUrl: _spectatorUrl, ...match }) => match)
  if (matches.length === 0) return { status: 'none' as const, matches }
  return {
    status: 'recovery_available' as const,
    matches,
    message: matches.length === 1
      ? 'Enter the original table with gamer_room action=join and this roomId to take control back.'
      : 'Choose an original table, then call gamer_room action=join with its roomId to take control back.',
  }
}
