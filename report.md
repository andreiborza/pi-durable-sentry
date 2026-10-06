# pi-durable instrumentation (#24993): `runs.owners` keeps full traces alive

Found in a review of PR #24993 at `e779efc5f1`, and reproduced with this test app.

## Problem

`tools.ts:234` stores the `execute_tool` span when a tool call creates a task-owned conversation. The entry is removed only when that conversation starts its first run (`runs.ts`, `startRun`). If the child never runs, the entry stays.

A stored span keeps its full trace in memory. The child span has a reference to its root (`_sentryRootSpan`), and the root has a `Set` of all its children. So each entry holds the full trace, including the `chat` spans and their `gen_ai.*` message attributes.

How a child can be left without a run:
- The tool throws or is aborted after `createConversation` / `forkConversation`.
- The tool creates or forks a conversation but never submits an input to it.

`harness.close()` does not clear `owners` (`index.ts:88` ends only the active runs). The only limit is `MAX_TRACKED_PI_RUNS` (1000 entries for each Harness).

## Reproduction

Test app: this repository (it uses the local PR build, the offline `faux` provider, and a no-op transport). See the README for setup.

```
node --expose-gc --import ./instrument-leak.mjs leak.mjs orphan 1200
node --expose-gc --import ./instrument-leak.mjs leak.mjs control 1200
```

Each iteration is one run in a new conversation. The model calls a `spawn` tool that throws:
- `orphan`: the tool calls `tx.createConversation({ ownership: { kind: 'task', taskId } })` before it throws.
- `control`: the tool throws without creating a conversation.

The script counts the root `invoke_agent` spans that are still alive after `Sentry.flush()` and a forced GC.

| Mode | Traces alive | `owners` size | Heap |
|---|---|---|---|
| control | 0 / 1200 | 0 | 93.7 MB |
| orphan | 1000 / 1200 | 1000 | 111.0 MB |

- Traces alive is equal to the `owners` size. It grows 300, 600, 900, then stops at 1000 (the cap).
- After `harness.close()`, the 1000 traces are still alive.
- Each trace in this test has two `chat` spans with about 20 KB of system instructions, so 1000 traces cost about 17 MB. Real prompts and message history make this larger.
- pi-durable keeps a closed Harness alive (also in control mode). Thus in practice, the leaked traces stay for the lifetime of the process.
- `runs.active` and `runs.toolCalls` stayed at 0 in this flow.

## Suggested fix

- Clear `runs.owners` and `runs.toolCalls` in the `subscribeClose` listener (`index.ts:88`).
- Remove the `owners` entry when the tool call that owns it fails.
- Consider a lower cap for `owners`, because each entry can hold a full trace, not one span.
