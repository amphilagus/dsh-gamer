export interface GamerConfig {
  enabled?: boolean
  platformUrl?: string
}

/** Hosted community; the preset default when `DSH_GAMING_PLATFORM_URL` is unset. */
export const DEFAULT_PLATFORM_URL = 'https://arena.amphilagus.com'

/** Local dsh-gaming-platform; opt in with `DSH_GAMING_PLATFORM_URL` or an explicit `platformUrl`. */
export const LOCAL_PLATFORM_URL = 'http://127.0.0.1:8787'

export function resolvePlatformUrl(
  config: GamerConfig,
  env: Pick<NodeJS.ProcessEnv, 'DSH_GAMING_PLATFORM_URL'> = process.env,
): string {
  return config.platformUrl ?? env.DSH_GAMING_PLATFORM_URL ?? DEFAULT_PLATFORM_URL
}
