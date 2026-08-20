/**
 * Block bash/pwsh commands that look like network fetches or opening URLs,
 * so the gamer agent cannot peek at match state outside gamer_* tools.
 */

import type { Context } from '@deepseek-ai/cordis'
import { looksLikeNetworkOrUrlCommand } from './shell-net.ts'

const SHELL_TOOLS = new Set(['bash', 'pwsh'])

function shellCommandOf(execution: { arguments: unknown }): string | undefined {
  const args = execution.arguments
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const command = (args as Record<string, unknown>).command
  return typeof command === 'string' ? command : undefined
}

const DENY =
  '游戏玩家预设禁止用 shell 拉取或打开 URL（防偷看局面）。本地命令可以用；对局请用 gamer_play / gamer_act，不要 curl/wget/open 观战页或游戏 API。'

export function registerNetworkShellGuard(ctx: Context): () => void {
  return ctx.tools.guard((execution) => {
    if (!SHELL_TOOLS.has(execution.name)) return undefined
    const command = shellCommandOf(execution)
    if (command === undefined || !looksLikeNetworkOrUrlCommand(command)) return undefined
    return DENY
  })
}
