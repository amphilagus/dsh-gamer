# Contributing

This package is a DSH bundle plus a companion agent preset. Keep it thin: HTTP client, a few `defineTool` registrations, one runtime skill, and the 游戏玩家 composition. Wire changes belong in [dsh-gaming-protocol](../dsh-gaming-protocol).

- `prepare` must stay a self-contained tsdown build (git installs do not emit `lib/` otherwise). `@deepseek-ai/*` stays external; the host supplies `defineTool` at runtime.
- Skills go through `ctx.skills.register` (`src/skills.ts`), not a copied `skills/` directory.
- Host `cordis.patch.yml` keeps `enabled: false`. Only the preset remounts the plugin.
- Do not add a game engine here. Gomoku is [dsh-gomoku](../dsh-gomoku); Go is [dsh-go](../dsh-go). In-match act shapes, query names, and seat/role names belong in that game's `GET /v1/how-to-play`, not in these tools.
- Platform selection and login are the agent-side gates. Before selection, only `gamer_platform` and saved-account listing work; other operations return `platform_not_selected`. After selection but before login, protected operations return `not_logged_in` before `missing_room_id` / `no_ticket`. Platform `GET /v1/rooms` stays public for humans.
- Bash/pwsh may be on the preset; `tools.guard` rejects network/URL shell commands (curl, wget, open https://…). Not a sandbox — play still goes through gamer_*.
- Spectator URLs from the game must be returned to the model, never dropped.
- Inject platform start/end copy the DSH way: `createUserMessage` + `<system-reminder>`. Wake on `match_started` / `match_ended` only — a ticket is a credential, not a notice. Idle: at most one `followup`, later notices `inject`. Running: `inject` into the current turn. Stall `followup` only if idle 3s while `yourTurn` is true; waiting on an opponent is allowed. Do not proxy `POST /v1/ready` on the game.
