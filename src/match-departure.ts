import type { GamingClient } from './client.ts'

export async function leaveCurrentMatchThroughPlatform(client: GamingClient) {
  if (!client.roomId) throw new Error('missing_room_id')
  const row = await client.platform(`/v1/rooms/${encodeURIComponent(client.roomId)}/leave`, {
    method: 'POST',
    body: '{}',
  })
  client.clearMatchState()
  return row
}
