import { ApiError, type GamingClient } from './client.ts'

export interface LogoutCleanup {
  room: 'none' | 'left'
  game: 'none' | 'queued' | 'completed'
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
  const cleanup: LogoutCleanup = { room: 'none', game: 'none' }
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

  let response: { cleanup?: LogoutCleanup }
  try {
    response = await client.platform('/v1/auth/logout', { method: 'POST' }) as { cleanup?: LogoutCleanup }
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
    cleanup: response.cleanup ?? cleanup,
  }
}
