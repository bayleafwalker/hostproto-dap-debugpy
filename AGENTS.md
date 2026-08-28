# Agent guidance

- This repository is a binding. Semantics live in hostproto-dap-core (pinned by commit in `package.json`); process and protocol facts live in `src/binding.ts`. A semantic change goes to the core with a promise test first.
- Never hand-write a TypeScript interface for a HostProto type; validate against the bundle with `assertValid`.
- Every error leaving a tool is `error/v1` with an honest `host_invoked`.
- `fixtures/program.py` line numbers are load-bearing for the tests; keep the comments that say so.
- Tests are wire-level (`tests/adapter.test.ts`): real client, real stdio server, real debugpy, real Python. Keep them that way.
- Record every wire fact learned about DAP, debugpy or the SDK in `docs/DECISIONS.md` with the versions.
