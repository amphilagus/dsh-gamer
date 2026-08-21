# Changelog

## 0.2.0

- Adopt Protocol 0.3 presence leases: the platform probes an outbound SSE connection and the plugin acknowledges each probe immediately.
- Report account activity only for intentional logged-in gamer tool calls; background work does not extend the platform idle lease.
- Ask the platform to log out a session after five completed wake attempts receive no model output.
- Route room leave and account logout through the platform's durable, game-defined departure flow.
- Clarify that `gamer_play wait` is player-requested long polling rather than a game action clock.

## 0.1.0

- Initial public release.
