# pi-acp-stream

**ACP agent client for [pi](https://github.com/earendil-works/pi) with live streaming and tool-call forwarding.**

A fork of [`buihongduc132/pi-acp-agents`](https://github.com/buihongduc132/pi-acp-agents) that fixes two data-loss bugs in the upstream ACP event pipeline:

| | Upstream | This fork |
|---|---|---|
| **Streaming deltas** | Discarded. `handleSessionUpdate` accumulates text privately and returns it only when the prompt ends. | Forwarded to pi's `onUpdate` — visible in the TUI while the agent works. |
| **Tool calls** | Discarded for non-worker sessions. `onSessionUpdate` feeds only `heartbeatConsumer`, which returns early unless the session is a worker. | Merged per `toolCallId` and reported inline, so you see `Read x.txt` → `Write y.txt` instead of an opaque final answer. |

Verified against **Qoder CLI 1.1.80** over ACP, driving real file edits end to end.

---

## Why this fork exists

ACP streams session progress as `session/update` notifications. The upstream extension consumed that stream only for worker-session telemetry:

```ts
// heartbeat-parser.ts:81 — every non-worker session exits here
if (!workerName) return;
```

Everything else — `agent_message_chunk`, `tool_call`, `tool_call_update` — was received and thrown away. The `_onUpdate` parameter on the tool handlers was never used (note the underscore prefix), so pi had nothing to render until the agent finished.

This fork adds a parallel path that does not disturb the worker telemetry:

```
ACP stdout ──► AcpClient.handleSessionUpdate
                    │
                    ├─► onSessionUpdate ──► heartbeatConsumer   (worker metrics, unchanged)
                    │
                    └─► onStream ──► AcpSessionCollector ──► throttle 250ms ──► pi onUpdate
                                                        └──► formatToolCallsReport ──► tool result
```

---

## What you get

**Live progress in the TUI.** While a delegated task runs, pi shows the agent's message deltas and a running list of tool calls rather than a spinner.

**Tool calls in the transcript.** The final tool result carries a compact report:

```
工具调用 (4):
- ls -la /tmp/shipcheck (execute) — 完成
    命令: ls -la /tmp/shipcheck
- Read /tmp/shipcheck/in.txt (read) — 完成
    文件: /tmp/shipcheck/in.txt
- Write /tmp/shipcheck/out.txt (edit) — 完成
    文件: /tmp/shipcheck/out.txt
```

**Reasoning stays out of the answer.** Upstream concatenated `agent_thought_chunk` into the returned text, leaking entire chains of thought into the tool result. This fork accumulates message text separately and falls back to the full buffer only when the agent produced no message content at all.

**Renderer failures cannot break the protocol.** An exception thrown from `onUpdate` used to bubble into the ACP SDK, which answered the notification with a `-32603` error frame. Streaming is now wrapped at both the client and reporter layers.

---

## Install

```bash
pi install git:github.com/jlon/pi-acp-stream
```

Or pin a ref:

```bash
pi install git:github.com/jlon/pi-acp-stream@v0.6.0
```

Restart pi afterward, then confirm:

```bash
pi list
```

### Requirements

- pi ≥ 1.2 (tested on 1.4.0)
- Node ≥ 22
- An ACP-speaking agent on `PATH`

### Peer dependency note

`@agentclientprotocol/sdk` imports `zod/v4` without declaring it. If pi reports `Cannot find module 'zod/v4'`:

```bash
cd ~/.pi/agent/npm && npm install zod
```

---

## Configure an agent

Config lives at `~/.pi/acp-agents/config.json`:

```json
{
  "agent_servers": {
    "qoder": {
      "command": "/Users/you/.local/bin/qodercli",
      "args": ["--acp"],
      "default_mode": "acceptEdits"
    }
  },
  "defaultAgent": "qoder",
  "stallTimeoutMs": 3600000
}
```

`default_mode` is worth setting. Without it the session starts in `default` mode and the agent asks permission before every write — and the upstream permission callback returns a malformed response that the agent reads as a denial (see [Patches](#patches-beyond-the-two-features)).

Available modes depend on the agent. Qoder exposes `default`, `acceptEdits`, `auto`, `dontAsk`, `yolo`.

---

## Use

```
"Delegate this refactor to qoder with acp_spawn"
"Ask qoder to profile the build and report the hot paths"
"Run the same prompt through acp_fanout and compare"
```

```js
// synchronous — blocks and returns inline
acp_spawn({ agent: "qoder", prompt: "...", cwd: "/path", async: false })

// asynchronous — returns status:"prompting" immediately
acp_spawn({ agent: "qoder", prompt: "..." })

// message an existing session (prompt / steer / cancel)
acp_msg({ session_id: "...", message: "..." })

// inspect state
acp_status({})
```

Sessions are long-lived by default. `idleTtlMs: 0` makes a one-shot that disposes after replying.

---

## Patches beyond the two features

These are in this fork and not upstream:

**Permission responses follow the ACP spec.** Upstream replied `{ outcome: "approved" }`; the spec requires `{ outcome: { outcome: "selected", optionId } }`. Agents rejected every write. Fixed to pick an allow-class option from `params.options`, so you no longer need `default_mode: "acceptEdits"` to avoid permission prompts.

**`zod` resolution.** Not a code change; documented above.

**State cleanup.** `dispose()` now clears per-session collectors and accumulated text. Removed an unused `_isNew` parameter and an unreferenced `reset()`.

---

## Tool surface

Nine tools, registered by the extension:

| Tool | Purpose |
|---|---|
| `acp_spawn` | Create a session, optionally prompt immediately |
| `acp_msg` | Prompt / steer / cancel a session, or send to a mailbox |
| `acp_status` | Agents, sessions, circuit breaker |
| `acp_fanout` | Same prompt to N agents, for comparison |
| `acp_governance` | Plan approval and model policy |
| `acp_task` | Task records with status, assignee, dependencies |
| `acp_dag` | Wave-based topological DAG execution |
| `acp_hooks_policy_get` / `_set` | Hook failure policy |

---

## Known limitations

These are inherited from upstream and unchanged:

- **Tool calls are reported, not relayed.** The agent's internal tool calls are summarized in the result, but they do not appear as separate tool calls in pi's transcript with their own approval flow.
- **No context inheritance.** The delegated agent cannot see the pi conversation. Prompts must be self-contained.
- **No worktree isolation** unless you pass `worktree: true`.
- **One prompt at a time per adapter.** Concurrent prompts against the same session return `busy`.
- **Process-state caching.** Some agents (Qoder included) cache file state per path across sessions. Reusing a working directory across test runs can surface stale content that looks like a bug in the bridge. Use a fresh directory when validating.

If you need ACP the other direction — exposing pi *to* an ACP client like Zed — use [`svkozak/pi-acp`](https://github.com/svkozak/pi-acp) or [`regadas/pi-acp`](https://github.com/regadas/pi-acp) instead.

---

## Development

```bash
git clone https://github.com/jlon/pi-acp-stream
cd pi-acp-stream
npm install --legacy-peer-deps   # peer graph needs the flag
npx tsc --noEmit                 # 21 pre-existing errors from upstream; do not fix here
pi install ./                     # load as a local package
```

The 21 type errors are all in `safeExecute` union narrowing in `index.ts`. They predate this fork and are unrelated to the changes — compare against the upstream tag if you want to confirm.

To verify the streaming path in isolation:

```js
import { createJiti } from "@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
const jiti = createJiti(import.meta.url);
const { createAdapter } = await jiti.import("./src/adapter-factory.ts");
const { loadConfig } = await jiti.import("./src/config/config.ts");

const config = loadConfig();
const stats = { message: 0, thought: 0, tool: 0 };
const adapter = createAdapter("qoder", config.agent_servers.qoder, config, "/tmp/probe", {
  onStream: (_sid, ev) => {
    if (ev.type === "message_delta") stats.message++;
    else if (ev.type === "thought_delta") stats.thought++;
    else stats.tool++;
  },
});
await adapter.spawn();
await adapter.initialize();
await adapter.newSession("/tmp/probe");
await adapter.setMode("acceptEdits");
await adapter.prompt("read in.txt, write out.txt with a suffix");
console.log(stats); // { message: 53, thought: 92, tool: 6 }
adapter.dispose();
```

---

## Credits

Upstream by [**buihongduc132**](https://github.com/buihongduc132) — MIT. The multi-agent orchestration, DAG execution, worker pooling, alias resolution and circuit breaker are all theirs; this fork changes only the event pipeline and the permission response.

Full upstream documentation is preserved in [`docs/upstream-README.md`](docs/upstream-README.md).

## License

MIT — see [LICENSE](LICENSE).
