# Decisions

## ADR-0001: debugpy is the first debugger; the adapter process is the host

debugpy 1.8.21 via `python -m debugpy.adapter` on stdio. The adapter process
is the `HostHandle`, a launch is the `ContextHandle`, a thread is the
`SurfaceHandle`, exactly as `DAP_SPIKE.md` mapped them. The same eleven
bundles the browser adapter pins are pinned here, by digest, unchanged.

## ADR-0002: wire facts about DAP as debugpy speaks it (1.8.21, Python 3.14)

1. **`runInTerminal` precedes `initialized`.** With `console:
   integratedTerminal` the adapter asks the client to run the launcher
   before it reports initialized; nothing proceeds until the reverse request
   is answered. So `context_create` returns handles with
   `surface.lifecycle: creating` and finishes the launch in the background;
   the request is a host request behind a decision token. `creating` is a
   schema-legal lifecycle, not an escape hatch (gate 6).
2. **Breakpoints bind eagerly and relocate.** `setBreakpoints` answers
   `verified: true` for every line, moving an out-of-range line to the last
   line of the file. `verified: false` at set time was never observed, and
   `hitBreakpointIds` is not sent on `stopped`. The receipt records the
   relocation as a `divergence` deviation with `requested_line` vs `line`;
   the spike's "verified only the bound one" case stays defined but is not
   reachable on debugpy.
3. **`continued` arrives after the resume response.** Do not synthesize the
   running transition from the response; the event follows within a few
   milliseconds and moves the revision. Revision therefore moves twice per
   resume-and-stop (continued, stopped), as the spike's examples show.
4. **Debuggee stdout needs `redirectOutput: true`** in the launch request and
   is chunked: one `print` is several `output` events. Consumers join the
   stream by cursor.
5. **Thread exit precedes `exited`/`terminated`.** The surface terminates on
   the `thread exited` event; recovery treats the debuggee as gone on any of
   thread exit, `exited`, `terminated`, or adapter process exit.
6. `stopOnEntry` stops with `reason: entry` on the first statement of the
   module; `justMyCode` keeps frames to the program.

## ADR-0003: the spike's rule was proven on a live `variablesReference`

A `variable` target minted at revision *r* (a scope's `variablesReference`),
used after a `step_over` moved the thread, is refused with
`target_invalidated`, `host_invoked: false`; so is a `frame` target on
`evaluate`. Nothing reached the adapter. The same code path rejects a
mismatched surface. This is the check step 3 asked step 5 to make.

## ADR-0004: `outcome: unknown` is a first-class result here

`continue` on a program that never stops within its `deadline_ms` returns a
receipt with `attempted: true, accepted: true, executed: false, verified:
false, outcome: unknown` and a deviation telling the client to reconcile
from the next observation; that observation shows `stopped: false` with
`frames` omitted-not-lost. `pause` then completes with `reason: pause`. The
browser lane had this shape only for a timed-out navigation; on a debugger
it is the ordinary case for a running program.

## ADR-0005: three things folded back from the Delve adapter

1. A launch that fails never sends `initialized`; `createContext` races the
   launch response so a bad program is `host_failed`, not a hang (test added).
2. `allThreadsStopped` stamps every open surface with the event's reason
   and the stopping thread, not a synthetic `all_threads_stopped` reason.
3. `set_variable` earns `verified` by an independent `evaluate` read-back
   recorded in `effects[0].read_back`; a disagreeing read is a `divergence`.
