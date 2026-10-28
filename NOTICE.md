# NOTICE

This project is a fork of
[`buihongduc132/pi-acp-agents`](https://github.com/buihongduc132/pi-acp-agents),
Copyright (c) 2026 walodayeet, licensed under the MIT License.

The upstream work supplies the multi-agent orchestration layer: session
management, DAG execution, worker pooling, alias resolution, the circuit breaker,
the task and mailbox stores, and the TUI panel. This fork modifies the ACP event
pipeline and the permission response, and adds the streaming and tool-call
reporting described in [CHANGELOG.md](CHANGELOG.md).

The original MIT license text is retained unmodified in [LICENSE](LICENSE), as
the license requires.

Upstream documentation is kept verbatim for reference:

- [`docs/upstream-README.md`](docs/upstream-README.md)
- [`docs/upstream-CHANGELOG.md`](docs/upstream-CHANGELOG.md)

Third-party dependencies retain their own licenses:

| Package | License |
|---|---|
| `@agentclientprotocol/sdk` | Apache-2.0 |
| `pi-acp-types` | MIT |
| `typebox` | MIT |
| `@earendil-works/pi-coding-agent` (peer) | MIT |
