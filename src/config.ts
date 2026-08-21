export interface GamerPlatformConfig {
  id: string
  name: string
  url: string
}

export interface GamerConfig {
  enabled?: boolean
  platforms?: GamerPlatformConfig[]
}

export interface GamerPlatform {
  id: string
  name: string
  url: string
  builtIn: boolean
}

export const COMMUNITY_PLATFORM_URL = 'https://arena.amphilagus.com'
export const LOCAL_PLATFORM_URL = 'http://127.0.0.1:8787'

export const BUILTIN_PLATFORMS: readonly GamerPlatform[] = Object.freeze([
  Object.freeze({ id: 'community', name: 'Community', url: COMMUNITY_PLATFORM_URL, builtIn: true }),
  Object.freeze({ id: 'local', name: 'Local development', url: LOCAL_PLATFORM_URL, builtIn: true }),
])

const PLATFORM_ID = /^[a-z][a-z0-9-]{0,31}$/

function normalizePlatform(row: GamerPlatformConfig, builtIn: boolean): GamerPlatform {
  if (!PLATFORM_ID.test(row.id)) {
    throw new TypeError(`platform id "${row.id}" must match ${String(PLATFORM_ID)}`)
  }
  const name = row.name.trim()
  if (!name || name.length > 64) {
    throw new TypeError(`platform "${row.id}" name must contain 1-64 characters`)
  }
  let parsed: URL
  try {
    parsed = new URL(row.url)
  } catch {
    throw new TypeError(`platform "${row.id}" URL must be absolute`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`platform "${row.id}" URL must use http or https`)
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError(`platform "${row.id}" URL must not contain credentials, query, or fragment`)
  }
  const url = parsed.toString().replace(/\/+$/, '')
  return Object.freeze({ id: row.id, name, url, builtIn })
}

/** Built-ins first; trusted plugin config may override one by id or append more. */
export function resolvePlatforms(config: GamerConfig): readonly GamerPlatform[] {
  if (Object.hasOwn(config as object, 'platformUrl')) {
    throw new TypeError('dsh-gamer platformUrl was removed; configure platforms: [{ id, name, url }]')
  }
  const rows = BUILTIN_PLATFORMS.map((row) => ({ ...row }))
  const indexes = new Map(rows.map((row, index) => [row.id, index]))
  const customIds = new Set<string>()
  for (const raw of config.platforms ?? []) {
    if (customIds.has(raw.id)) throw new TypeError(`duplicate configured platform id "${raw.id}"`)
    customIds.add(raw.id)
    const row = normalizePlatform(raw, false)
    const index = indexes.get(row.id)
    if (index === undefined) {
      indexes.set(row.id, rows.length)
      rows.push(row)
    } else {
      rows[index] = row
    }
  }
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })))
}
