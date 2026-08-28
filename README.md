# hostproto-dap-debugpy

The HostProto DAP adapter (hostproto-semantics plan, step 5): a **debugpy**
session exposed through **MCP 2026-07-28**, pinned. Semantics come from
[hostproto-semantics](https://github.com/bayleafwalker/hostproto-semantics),
the same eleven bundles the browser adapter pins; this repository owns only
the DAP client, the thread/target registry, validation, and its own tests.
It is the runtime the step-3 spike (`docs/DAP_SPIKE.md`) asked for. Since
hostproto-semantics ADR-0012 it is a **binding**: `src/binding.ts` supplies
how debugpy is started and what its `launch` says;
[hostproto-dap-core](https://github.com/bayleafwalker/hostproto-dap-core)
(pinned by commit) computes every HostProto semantic and serves MCP.

## What it does

| MCP surface | HostProto object |
| --- | --- |
| `hostproto_context_create` (launch a Python program, stops on entry) | `handles/v1` — host = adapter process, context = launch, surface = thread; `lifecycle: creating` until the first thread exists |
| `hostproto_surface_observe` | `observation/v1` — revision moves on every stopped↔running transition of that thread; the cursor is host-assigned over normalized events, DAP `seq` is raw provenance. Projections: `state`, `frames`, `scopes`, `variables`, `output`, `breakpoints`, `host_requests` |
| `hostproto_surface_act` (input **is** the `intent/v1` bundle) | `receipt/v1` — `set_breakpoints`, `step_over/in/out`, `continue`, `pause`, `evaluate`, `set_variable`, `host_request.resolve`; a resume whose deadline elapses is `outcome: unknown, executed: false` |
| `hostproto_surface_await` | host-side wait: `stopped`, `lifecycle`, `revision`, `event_kind`, `host_request` |
| `hostproto_context_recovery` | `recovery/v1` — `unrecoverable / host_terminated` once the debuggee is gone, with the raw DAP message log as content-addressed evidence (`application/x-ndjson`) |
| `hostproto_capabilities` | `capability-profile/v1` for `dap/v1` — availability from the adapter's `initialize` response, `runtime` only for what this process executed |
| `hostproto://surface/{id}/state`, `hostproto://context/{id}/dap-messages` | subscribable state; the evidence log |

Frames, scopes and variables are `target-ref/v1` scoped to the revision they
were observed at. A `variablesReference` from before a resume is refused as
`target_invalidated` with `host_invoked: false` **before anything is sent**
— the rule step 3 asked step 5 to prove on a real debugger. Frames while
running are *omitted, not lost*: `bounded.omitted` counts them, `lossy`
stays false, a deviation says why.

A `runInTerminal` reverse request is a host request behind a decision token,
the same shape as a browser script dialog: handles come back first
(`creating`), the client observes `host_requests`, resolves with
`allow | deny`, and the entry stop follows.

## Run

```sh
npm ci
python3 -m venv .venv && .venv/bin/pip install debugpy==1.8.21   # or HOSTPROTO_PYTHON=/path/to/python with debugpy
npm test          # real client ↔ real server over stdio ↔ real debugpy ↔ real Python
npm start         # stdio server
```
