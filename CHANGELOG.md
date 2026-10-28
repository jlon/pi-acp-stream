# Changelog

All notable changes to this project are documented here.

This project is a fork of
[`buihongduc132/pi-acp-agents`](https://github.com/buihongduc132/pi-acp-agents).
The upstream changelog is preserved in
[`docs/upstream-CHANGELOG.md`](docs/upstream-CHANGELOG.md).

## [0.6.0] - 2026-10-28

Fork point: upstream `@buihongduc132/pi-acp-agents` 0.5.1.

### Added

- **Streaming deltas.** ACP `agent_message_chunk` and `agent_thought_chunk`
  notifications are now forwarded to pi's `onUpdate`, throttled to 250 ms. The
  snapshot shows in-flight tool calls followed by the message text. Previously
  all of this was accumulated privately and released only when the prompt
  settled.
- **Tool-call forwarding.** `tool_call` and `tool_call_update` notifications are
  merged per `toolCallId` into a record carrying title, kind, status, affected
  paths, command and a clipped output, then rendered as a report appended to the
  tool result. Previously these events reached only `heartbeatConsumer`, which
  returns immediately for non-worker sessions.
- `src/core/session-collector.ts` — `AcpSessionCollector`, `mergeToolCall`,
  `formatToolCallLine`, `formatToolCallsReport`.
- `AcpStreamEvent` (`message_delta` | `thought_delta` | `tool_call`) in the
  adapter and client option types.
- `AcpAgentAdapter.setStreamHandler()` and `AcpClient.setStreamHandler()` so a
  reused connection can receive a handler for one prompt.
- Streaming on all three `acp_msg` paths: live session reuse, archived-session
  reopen, and fresh prompt.

### Fixed

- **`onUpdate` exceptions polluted the ACP protocol.** A throw from the renderer
  bubbled through `handleSessionUpdate` into the SDK, which answered the
  notification with `-32603 Internal error`. Routing now goes through
  `AcpClient.emitStream()` with a catch, and the reporter catches separately, so
  a failing renderer cannot affect agent execution.
- **Reasoning leaked into the answer.** Upstream appended `agent_thought_chunk`
  to the same buffer as message text, so the returned string contained the
  agent's full chain of thought. Message text is now accumulated separately, with
  a fallback to the combined buffer only when the agent emitted no message
  content.
- **Permission requests were malformed.** `requestPermission` returned
  `{ outcome: "approved" }`; ACP expects
  `{ outcome: { outcome: "selected", optionId } }`. Agents read the old shape as
  a denial and every file write failed. Now selects an allow-class option from
  the request's `options`.
- `dispose()` clears per-session collectors and accumulated text.

### Removed

- Unused `_isNew` parameter on `AcpSessionCollector.applyToolEvent()`.
- Unreferenced `AcpSessionCollector.reset()`.
- Unused `toolCallEventToRecord()` helper.

### Notes

- `npx tsc --noEmit` reports 21 errors, all in `safeExecute` union narrowing in
  `index.ts`. They exist at the fork point and are unrelated to these changes.
- Verified against Qoder CLI 1.1.80 over ACP.
