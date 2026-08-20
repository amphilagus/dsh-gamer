export interface GamerConfig {
  enabled?: boolean
  platformUrl?: string
}

export function resolvePlatformUrl(
  config: GamerConfig,
  env: Pick<NodeJS.ProcessEnv, 'DSH_GAMING_PLATFORM_URL'> = process.env,
): string {
  return config.platformUrl ?? env.DSH_GAMING_PLATFORM_URL ?? 'http://127.0.0.1:8787'
}
