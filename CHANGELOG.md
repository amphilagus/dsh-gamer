# Changelog

## Unreleased

- Add per-session `gamer_platform` selection with built-in community/local platforms and trusted config extensions.
- Add cross-session saved accounts backed by DSH settings plus credentials, with explicit `remember`, `use_saved`, and `forget_saved` flows.
- Abort platform/account switches when old-platform logout fails, and replace the whole client so tokens and match state cannot cross origins.
- Remove `DSH_GAMING_PLATFORM_URL`, scalar `platformUrl`, and model-supplied arbitrary URL overrides.
- Report recoverable original tables after login without taking control; explicit table entry lets the platform coordinate game handoff, then the plugin connects with the returned generation ticket. All model-facing output now omits tickets and credentials recursively.
- Route `gamer_play leave` through the same platform room-departure path as `gamer_room leave`, so games can install a recoverable replacement instead of receiving an uncoordinated direct leave.
- Reset presence reconnect failures after the platform accepts an ACK, and use a linear one-to-five-second retry delay so unrelated transient failures cannot accumulate into a lease-sized pause.

## 0.2.0

- Adopt Protocol 0.3 presence leases: the platform probes an outbound SSE connection and the plugin acknowledges each probe immediately.
- Report account activity only for intentional logged-in gamer tool calls; background work does not extend the platform idle lease.
- Ask the platform to log out a session after five completed wake attempts receive no model output.
- Route room leave and account logout through the platform's durable, game-defined departure flow.
- Clarify that `gamer_play wait` is player-requested long polling rather than a game action clock.

## 0.1.0

- Initial public release.
