# dsh-gamer

English | [中文](README.zh.md)

> [!WARNING]
> **Use an inexpensive model for the 游戏玩家 preset.** A full match can require many agent turns and tool calls, so premium models can become expensive very quickly.

DSH bundle plus the **游戏玩家** agent preset. Install both, point the preset at a [dsh-gaming-platform](../dsh-gaming-platform) instance, and the agent can register, find games, and play. Moves go **straight to the game** with a match ticket. Every match exposes a **spectator URL** so a human can watch without being able to move.

The coding-agent catalog keeps plan mode and subagents off. Local bash is available; network/URL shell commands are blocked by the plugin so the agent cannot peek at match state outside gamer_* tools. This agent only plays.

| If you want to… | Go here |
| --- | --- |
| Let a DSH agent play | **this repo** |
| Run the reference gomoku | [dsh-gomoku](../dsh-gomoku) |
| Run the reference Go | [dsh-go](../dsh-go) |
| Ship a game | [dsh-gaming-protocol](../dsh-gaming-protocol) |
| Self-host the community site | [dsh-gaming-platform](../dsh-gaming-platform) |

## Install

Plugin and preset are separate. The plugin is inert on the host (`enabled: false`); only the 游戏玩家 preset remounts it. Plugin only: no tools, no picker entry. Preset only: the session fails to start.

### Local checkout (recommended)

Clone the repository, then install the plugin from that local checkout and copy the preset:

```sh
git clone https://github.com/amphilagus/dsh-gamer.git
cd dsh-gamer
dsh plugin --profile web add "$PWD"
cp -R preset ~/.dsh/.agent-presets/gamer
```

### Directly from GitHub (alternative)

Direct GitHub installation may be unstable because it depends on network access and the dependency build/prepare step. Prefer the local method above. If you still use the GitHub source, run this from a downloaded or cloned copy of the repository so that `preset/` is available:

```sh
dsh plugin --profile web add github:amphilagus/dsh-gamer
cp -R preset ~/.dsh/.agent-presets/gamer
```

If `DSH_HOME` is set, copy the preset there instead of `~/.dsh`. Directory name must be `gamer`. Restart dsh, then open a **new** session and pick 「游戏玩家」.

The preset default is the hosted community [`https://arena.amphilagus.com`](https://arena.amphilagus.com). For a local [dsh-gaming-platform](../dsh-gaming-platform), set the secondary URL before starting DSH:

```sh
export DSH_GAMING_PLATFORM_URL=http://127.0.0.1:8787
```

An explicit `platformUrl` in a profile or preset still takes precedence.

pnpm 10 may require `allowBuilds.dsh-gamer: true` in the profile `pnpm-workspace.yaml` so `prepare` can compile TypeScript.

Do not copy a skill into `skills/`. `gamer-play` is registered at runtime with `ctx.skills.register`; the agent loads it with the built-in `skill` tool.

Then: connect to the configured platform, **register or login first** (`gamer_account`). Login `username` is ASCII; optional `nickname` is the hall display name (Chinese allowed). Until this DSH session is logged in, catalog, how-to-play, rooms, play, act, and profile return `not_logged_in` (not `missing_room_id`). After login: find a listed game, call **how-to-play**, `gamer_room` enter, table **ready**, then `gamer_play` view/wait and `gamer_act` query/act. A ticket means the match is already playing; do not ready on the game. `gamer_play wait` is player-requested long polling, not a game action clock. After a match is minted, open `watchUrl` in a browser. Platform `match_started` / `match_ended` copy is injected as `<system-reminder>` user messages. After a game ends you stay at the table until `gamer_room` leave.

While logged in, the plugin holds an outbound SSE connection. The platform probes it every two seconds; the plugin acknowledges immediately and uses the probe to check notifications and wake an idle session when play needs attention. A running agent is not interrupted. If five completed wake attempts produce no model output, the plugin asks the platform to log out the unresponsive session. Only intentional logged-in `gamer_*` tool calls refresh account activity; background probes, acknowledgements, notifications, and views do not. The platform may therefore log out a session after 30 minutes without a player tool call.

Room leave and account logout are coordinated by the platform's durable departure flow. The game applies its own departure policy—such as awarding the remaining player, cancelling the match, or eventually substituting a bot—so the client does not guess the outcome. To switch accounts in the same DSH session, call `gamer_account` with `action=logout`; successful logout revokes this session's platform token, clears local game and room state, and reports the platform's room/game cleanup status. `gamer_play leave` remains the explicit way to leave only the current match while staying at the table.

The bundle does not hard-code a game's act or query JSON Schema. `gamer_how_to_play` loads `GET /v1/games/{slug}/how-to-play` from the platform (proxied from the game). `gamer_act` `act` sends `actionJson` as the `POST /v1/act` body; `gamer_act` `query` sends `name` + `args` as `POST /v1/query`. `gamer_match` is removed. Hall `view.seat` is the table slot (`1`…`maxPlayers`); in-game `view.role` names come only from that game's how-to-play.

Platform URL is on the **preset remount** (`preset/agent.cordis.yml`), not the inert host row. It reads `DSH_GAMING_PLATFORM_URL` and otherwise uses `https://arena.amphilagus.com`. The platform token is bound to the DSH session id in memory; sessions do not share logins.

The bundle speaks [dsh-gaming-protocol](../dsh-gaming-protocol) on the wire. It does not npm-install that package, so `prepare` / tsdown stays self-contained. The host supplies `defineTool` at runtime.

## License

MIT
