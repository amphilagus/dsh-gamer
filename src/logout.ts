import { ApiError, type GamingClient } from './client.ts'

export type LogoutCleanupStatus = 'not_applicable' | 'left' | 'failed'

export interface LogoutCleanupStep {
  status: LogoutCleanupStatus
  httpStatus?: number
  error?: string
  message?: string
}

export interface LogoutCleanup {
  game: LogoutCleanupStep
  room: LogoutCleanupStep
}

type LogoutResult =
  | {
      ok: true
      loggedOut: boolean
      alreadyLoggedOut?: true
      serverSession?: 'revoked' | 'already_invalid'
      cleanup: LogoutCleanup
      message?: string
    }
  | {
      ok: false
      loggedOut: false
      error: 'logout_unsupported' | 'logout_failed'
      status?: number
      message: string
      cleanup: LogoutCleanup
    }

function skipped(): LogoutCleanupStep {
  return { status: 'not_applicable' }
}

function failed(error: unknown): LogoutCleanupStep {
  if (error instanceof ApiError) {
    const body = error.body as { error?: { code?: unknown; message?: unknown } } | undefined
    return {
      status: 'failed',
      httpStatus: error.status,
      error: typeof body?.error?.code === 'string' ? body.error.code : 'http_error',
      message: typeof body?.error?.message === 'string' ? body.error.message : error.message,
    }
  }
  return {
    status: 'failed',
    error: 'request_failed',
    message: error instanceof Error ? error.message : String(error),
  }
}

function logoutFailure(error: unknown, cleanup: LogoutCleanup): LogoutResult {
  if (error instanceof ApiError) {
    const unsupported = error.status === 404 || error.status === 405
    return {
      ok: false,
      loggedOut: false,
      error: unsupported ? 'logout_unsupported' : 'logout_failed',
      status: error.status,
      message: unsupported
        ? 'This platform does not support POST /v1/auth/logout. Upgrade the platform; the local login token was kept.'
        : `Platform logout failed with HTTP ${error.status}; the local login token was kept.`,
      cleanup,
    }
  }
  return {
    ok: false,
    loggedOut: false,
    error: 'logout_failed',
    message: `Platform logout failed; the local login token was kept. ${error instanceof Error ? error.message : String(error)}`,
    cleanup,
  }
}

export async function logoutCurrentSession(client: GamingClient): Promise<LogoutResult> {
  const cleanup: LogoutCleanup = { game: skipped(), room: skipped() }
  if (!client.token) {
    client.clearSession()
    return {
      ok: true,
      loggedOut: false,
      alreadyLoggedOut: true,
      cleanup,
      message: 'This DSH session is already logged out.',
    }
  }

  if (client.ticket && client.gameBaseUrl) {
    try {
      await client.game('/v1/leave', {
        method: 'POST',
        body: JSON.stringify({ reason: 'logout' }),
      })
      client.ticket = undefined
      cleanup.game = { status: 'left' }
    } catch (error) {
      cleanup.game = failed(error)
    }
  }

  if (client.roomId) {
    try {
      await client.platform(`/v1/rooms/${encodeURIComponent(client.roomId)}/leave`, {
        method: 'POST',
        body: '{}',
      })
      client.clearMatchState()
      cleanup.room = { status: 'left' }
    } catch (error) {
      cleanup.room = failed(error)
    }
  }

  try {
    await client.platform('/v1/auth/logout', { method: 'POST' })
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      client.clearSession()
      return {
        ok: true,
        loggedOut: true,
        serverSession: 'already_invalid',
        cleanup,
        message: 'The platform token was already invalid; local session state was cleared.',
      }
    }
    return logoutFailure(error, cleanup)
  }

  client.clearSession()
  return {
    ok: true,
    loggedOut: true,
    serverSession: 'revoked',
    cleanup,
  }
}
