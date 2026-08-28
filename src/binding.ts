// The debugpy binding: process and protocol facts only. Semantics live in
// hostproto-dap-core (docs/PROMISE.md there).
import { fileURLToPath } from 'node:url';
import { DapClient, HostProtoError, type EngineBinding, type LaunchParams } from 'hostproto-dap-core';

export const DEFAULT_PYTHON = process.env.HOSTPROTO_PYTHON ?? fileURLToPath(new URL('../.venv/bin/python', import.meta.url));

export function debugpyBinding(python = DEFAULT_PYTHON): EngineBinding {
  const console_ = (p: LaunchParams) => String(p.console ?? 'internalConsole');
  return {
    kind: 'debugpy', variant: 'python', serverName: 'hostproto-dap-debugpy',
    launchDescription: 'console=integratedTerminal makes debugpy ask the client to run the debuggee (runInTerminal), surfaced as a host request with a decision token; handles return first.',
    launchSchema: { console: { enum: ['internalConsole', 'integratedTerminal'] } },
    validate(p) { if (!['internalConsole', 'integratedTerminal'].includes(console_(p))) throw new HostProtoError('capability_unsupported', 'console must be internalConsole or integratedTerminal', false, { console: p.console }); },
    async start(cwd) { return { client: DapClient.spawn(python, ['-m', 'debugpy.adapter'], cwd) }; },
    initializeArguments: () => ({ adapterID: 'debugpy', supportsRunInTerminalRequest: true }),
    // redirectOutput: debugpy forwards debuggee stdout as `output` events only when asked (ADR-0002 item 4).
    launchArguments: (p, program, cwd) => ({ type: 'python', request: 'launch', name: 'hostproto', program, args: p.args ?? [], cwd, console: console_(p), stopOnEntry: p.stop_on_entry ?? true, justMyCode: true, redirectOutput: true, python }),
    // runInTerminal precedes `initialized` (ADR-0002 item 1).
    handlesBeforeLaunch: p => console_(p) === 'integratedTerminal',
    identity: () => ({ dap: 'debugpy.adapter', python }),
    entryDeadlineMs: 20000,
  };
}
