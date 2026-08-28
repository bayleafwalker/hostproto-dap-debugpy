// Wire-level: a real MCP 2026-07-28 client over stdio to the real server
// process, driving a real debugpy adapter and a real Python debuggee.
// Nothing is mocked between the client and the interpreter.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { validator } from 'hostproto-dap-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let client: Client; let transport: StdioClientTransport;
const updated: string[] = [];
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { ...result, sc: result.structuredContent as Record<string, any> };
};
const intent = (surface: string, kind: string, extra: Record<string, unknown> = {}) => ({ schema_version: 'hostproto.intent/v1', action_id: `a-${Math.random().toString(36).slice(2, 8)}`, surface, kind, ...extra });
const sha = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

beforeAll(async () => {
  transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/stdio.ts'], cwd: ROOT, stderr: 'pipe' });
  client = new Client({ name: 'hostproto-conformance', version: '0.0.1' });
  client.setVersionNegotiation({ mode: { pin: '2026-07-28' } });
  client.setNotificationHandler('notifications/resources/updated', n => { updated.push(n.params.uri); });
  await client.connect(transport);
});
afterAll(async () => { await client?.close().catch(() => {}); });

describe('wire behaviour on 2026-07-28', () => {
  it('negotiates the pinned revision and publishes the bundles as tool schemas', async () => {
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(client.getServerVersion()?.name).toBe('hostproto-dap-debugpy');
    const act = (await client.listTools()).tools.find(t => t.name === 'hostproto_surface_act')!;
    expect(act.inputSchema.properties).toHaveProperty('kind');
    expect(JSON.stringify(act)).not.toMatch(/hostproto\.invalid/);
  });
});

describe('HostProto semantics on a real debugger', () => {
  let surface: string; let context: string; let frames: any[]; let variables: any[]; let scopeTarget: any; let revisionAtVariables: number;

  it('launches, stops on entry, mints handles', async () => {
    const { sc, isError } = await call('hostproto_context_create', { program: 'fixtures/program.py', cwd: ROOT, client: { id: 'conformance' } });
    expect(isError).toBe(false);
    expect(validator('handles')(sc)).toBe(true);
    expect(sc.adapter_profile).toBe('dap/v1');
    surface = sc.surface.id; context = sc.context.id;
    const state = (await call('hostproto_surface_observe', { surface, projections: ['state'] })).sc;
    expect(state.data.state.stopped).toBe(true);
    expect(state.data.state.reason).toBe('entry');
    expect(state.data.state.source).toBe('fixtures/program.py');
  });

  it('sets breakpoints: debugpy binds eagerly and relocates an out-of-range line; the receipt records the move', async () => {
    const { sc } = await call('hostproto_surface_act', intent(surface, 'set_breakpoints', { params: { source: 'fixtures/program.py', lines: [16, 999] }, declared_effects: ['breakpoints_replaced_for_source'] }));
    expect(validator('receipt')(sc)).toBe(true);
    expect(sc.outcome).toBe('completed'); expect(sc.verified).toBe(true);
    expect(sc.revision_after).toBe(sc.revision_before);
    const bps = sc.effects[0].breakpoints;
    expect(bps.find((b: any) => b.requested_line === 16)).toMatchObject({ line: 16, verified: true });
    const moved = bps.find((b: any) => b.requested_line === 999);
    expect(moved.verified).toBe(true); expect(moved.line).not.toBe(999);
    expect(sc.deviations.find((d: any) => /relocated/.test(d.reason)).data.moved[0]).toEqual({ requested_line: 999, line: moved.line });
    // replace the set for the source with the one that matters
    const again = await call('hostproto_surface_act', intent(surface, 'set_breakpoints', { params: { source: 'fixtures/program.py', lines: [16] } }));
    expect(again.sc.effects[0].breakpoints).toHaveLength(1); expect(again.sc.deviations).toEqual([]);
  });

  it('continue: the revision advances, the stop carries the breakpoint, and the subscribed state resource notified', async () => {
    const listening = await client.listen({ resourceSubscriptions: [`hostproto://surface/${surface}/state`] });
    const { sc } = await call('hostproto_surface_act', intent(surface, 'continue', { preconditions: { schema_version: 'hostproto.precondition/v1', surface, assertions: [{ field: 'stopped', equals: true }] }, declared_effects: ['revision_advance', 'stopped:breakpoint'] }));
    expect(sc.outcome).toBe('completed'); expect(sc.verified).toBe(true);
    expect(sc.revision_after).toBeGreaterThan(sc.revision_before);
    expect(sc.effects.map((e: any) => e.kind)).toEqual(['continued', 'stopped']);
    expect(sc.effects[1]).toMatchObject({ reason: 'breakpoint', line: 16 });
    expect(sc.caused_events.length).toBeGreaterThanOrEqual(2);
    await new Promise(r => setTimeout(r, 100));
    expect(updated).toContain(`hostproto://surface/${surface}/state`);
    await listening.close();
  });

  it('observes frames, scopes and variables as revision-scoped targets; output rode the cursor', async () => {
    const f = (await call('hostproto_surface_observe', { surface, projections: ['state', 'frames', 'output'] })).sc;
    expect(validator('observation')(f)).toBe(true);
    frames = f.data.frames; expect(frames[0].role).toBe('frame'); expect(frames[0].name).toMatch(/^main  fixtures\/program\.py:16/);
    expect(f.data.output.map((e: any) => e.payload.output).join('')).toContain('ledger: 17 capabilities'); // debugpy chunks one print into several output events
    const s = (await call('hostproto_surface_observe', { surface, projections: ['scopes'], target: frames[0] })).sc;
    scopeTarget = s.data.scopes.find((t: any) => t.name === 'Locals'); expect(scopeTarget.actions).toContain('expand');
    const v = (await call('hostproto_surface_observe', { surface, projections: ['variables'], target: scopeTarget })).sc;
    variables = v.data.variables; revisionAtVariables = v.revision;
    expect(variables.find((t: any) => t.name.startsWith('count = 17'))).toBeDefined();
    expect(variables.find((t: any) => t.name.startsWith('ledger')).actions).toContain('expand');
  });

  it('evaluates in a frame and sets a variable', async () => {
    const ev = await call('hostproto_surface_act', intent(surface, 'evaluate', { target: frames[0], params: { expression: 'len(ledger)', context: 'watch' } }));
    expect(ev.sc.effects[0]).toMatchObject({ kind: 'evaluated', result: '2' });
    const count = variables.find((t: any) => t.name.startsWith('count'));
    const set = await call('hostproto_surface_act', intent(surface, 'set_variable', { target: count, params: { value: '5' } }));
    expect(set.sc.effects[0]).toMatchObject({ kind: 'variable.set', name: 'count', value: '5', read_back: '5' });
    expect(set.sc.verified).toBe(true);
    expect(set.sc.revision_after).toBe(set.sc.revision_before);
  });

  it('step_over is pre-empted by a breakpoint inside the call: effects differ from declared, outcome stays completed', async () => {
    await call('hostproto_surface_act', intent(surface, 'set_breakpoints', { params: { source: 'fixtures/program.py', lines: [8] } }));
    const { sc } = await call('hostproto_surface_act', intent(surface, 'step_over', { declared_effects: ['revision_advance', 'stopped:step'] }));
    expect(sc.outcome).toBe('completed'); expect(sc.executed).toBe(true);
    expect(sc.effects[1]).toMatchObject({ kind: 'stopped', reason: 'breakpoint', line: 8, source: 'fixtures/program.py' });
    expect(sc.deviations.some((d: any) => d.kind === 'divergence' && /pre-empted/.test(d.reason))).toBe(true);
  });

  it('refuses a variablesReference from before the resume, before anything is sent', async () => {
    const stale = variables.find((t: any) => t.name.startsWith('ledger'));
    const obs = await call('hostproto_surface_observe', { surface, projections: ['variables'], target: stale });
    expect(obs.isError).toBe(true);
    expect(obs.sc.code).toBe('target_invalidated'); expect(obs.sc.host_invoked).toBe(false);
    expect(obs.sc.data.target_revision).toBe(revisionAtVariables);
    const act = await call('hostproto_surface_act', intent(surface, 'evaluate', { target: frames[0], params: { expression: '1' } }));
    expect(act.sc.code).toBe('target_invalidated'); expect(act.sc.host_invoked).toBe(false);
  });

  it('rejects a failed precondition before touching the host', async () => {
    const { sc, isError } = await call('hostproto_surface_act', intent(surface, 'step_in', { preconditions: { schema_version: 'hostproto.precondition/v1', surface, assertions: [{ field: 'stopped', equals: false }] } }));
    expect(isError).toBe(true); expect(sc.code).toBe('precondition_failed'); expect(sc.host_invoked).toBe(false);
  });

  it('frames while running are omitted, not lost; lossy when bounded', async () => {
    const bounded = (await call('hostproto_surface_observe', { surface, projections: ['state', 'output', 'frames'], max_bytes: 512 })).sc;
    expect(bounded.bounded.lossy).toBe(true); expect(bounded.bounded.raw_ref).toMatch(/^sha256:/);
  });

  it('runs to exit: the surface terminates, handles expire, recovery names host_terminated with the message log as evidence', async () => {
    await call('hostproto_surface_act', intent(surface, 'set_breakpoints', { params: { source: 'fixtures/program.py', lines: [] } }));
    const { sc } = await call('hostproto_surface_act', intent(surface, 'continue', { params: { deadline_ms: 15000 } }));
    expect(sc.outcome).toBe('completed');
    expect(sc.effects.map((e: any) => e.kind)).toEqual(['continued', 'terminated']);
    await call('hostproto_surface_await', { surface, conditions: [{ kind: 'lifecycle', equals: 'terminated' }], deadline_ms: 5000 });
    // `exited` is the last thing the adapter says about the process; output and the thread record precede it.
    await call('hostproto_surface_await', { surface, conditions: [{ kind: 'event_kind', equals: 'process.exited' }], deadline_ms: 5000 });
    const state = (await call('hostproto_surface_observe', { surface, projections: ['state', 'output'] })).sc;
    expect(state.data.state.lifecycle).toBe('terminated');
    expect(state.data.output.map((e: any) => e.payload.output).join('')).toContain('result: 10'); // count was set to 5 → helper(5) = 10
    const expired = await call('hostproto_surface_act', intent(surface, 'continue'));
    expect(expired.sc.code).toBe('handle_expired'); expect(expired.sc.host_invoked).toBe(false);
    const rec = await call('hostproto_context_recovery', { context });
    expect(validator('recovery')(rec.sc)).toBe(true);
    expect(rec.sc).toMatchObject({ outcome: 'unrecoverable', cause: 'host_terminated' });
    const evidence = rec.sc.evidence[0]; expect(evidence.media_type).toBe('application/x-ndjson');
    const link = rec.content.find(c => c.type === 'resource_link') as { uri: string };
    const read = await client.readResource({ uri: link.uri });
    const text = (read.contents[0] as { text: string }).text;
    expect(sha(text)).toBe(evidence.ref);
    const messages = text.split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(messages.some((m: any) => m.direction === 'out' && m.message.command === 'launch')).toBe(true);
    expect(messages.some((m: any) => m.message.type === 'event' && (m.message.event === 'exited' || m.message.event === 'terminated' || (m.message.event === 'thread' && m.message.body.reason === 'exited')))).toBe(true);
    await call('hostproto_context_close', { context });
  });
});

describe('unknown outcomes and host requests', () => {
  it('continue that never stops within its deadline is outcome=unknown; pause reconciles it', async () => {
    const { sc: h } = await call('hostproto_context_create', { program: 'fixtures/spin.py', cwd: ROOT });
    const s = h.surface.id;
    const { sc } = await call('hostproto_surface_act', intent(s, 'continue', { params: { deadline_ms: 300 } }));
    expect(validator('receipt')(sc)).toBe(true);
    expect(sc).toMatchObject({ outcome: 'unknown', executed: false, verified: false, attempted: true, accepted: true });
    const running = (await call('hostproto_surface_observe', { surface: s, projections: ['state', 'frames'] })).sc;
    expect(running.data.state.stopped).toBe(false);
    expect(running.bounded.omitted).toEqual({ frames: 1 }); expect(running.bounded.lossy).toBe(false);
    expect(running.deviations[0].kind).toBe('divergence');
    const paused = await call('hostproto_surface_act', intent(s, 'pause'));
    expect(paused.sc.outcome).toBe('completed'); expect(paused.sc.effects[0]).toMatchObject({ kind: 'stopped', reason: 'pause' });
    await call('hostproto_context_close', { context: h.context.id });
  });

  it('runInTerminal is a host request behind a decision token: handles first, then the decision, then the entry stop', async () => {
    const { sc: h } = await call('hostproto_context_create', { program: 'fixtures/program.py', cwd: ROOT, console: 'integratedTerminal' });
    expect(h.surface.lifecycle).toBe('creating');
    const s = h.surface.id;
    await call('hostproto_surface_await', { surface: s, conditions: [{ kind: 'host_request', equals: true }], deadline_ms: 10000 });
    const req = (await call('hostproto_surface_observe', { surface: s, projections: ['host_requests'] })).sc.data.host_requests[0];
    expect(req).toMatchObject({ command: 'runInTerminal', status: 'pending', default: 'deny' });
    const { sc } = await call('hostproto_surface_act', intent(s, 'host_request.resolve', { decision_token: req.token, params: { decision: 'allow' } }));
    expect(sc.provider).toBe('host'); expect(sc.effects[0]).toMatchObject({ kind: 'host_request.decision', decision: 'allow' });
    const dup = await call('hostproto_surface_act', intent(s, 'host_request.resolve', { decision_token: req.token, params: { decision: 'deny' } }));
    expect(dup.sc.code).toBe('precondition_failed');
    await call('hostproto_surface_await', { surface: s, conditions: [{ kind: 'stopped', equals: true }], deadline_ms: 20000 });
    const state = (await call('hostproto_surface_observe', { surface: s, projections: ['state'] })).sc.data.state;
    expect(state.lifecycle).toBe('open'); expect(state.reason).toBe('entry');
    await call('hostproto_context_close', { context: h.context.id });
  });

  it('a program that does not exist fails the launch honestly instead of hanging', async () => {
    const { sc, isError } = await call('hostproto_context_create', { program: 'fixtures/missing.py', cwd: ROOT });
    expect(isError).toBe(true); expect(sc.code).toBe('host_failed'); expect(sc.host_invoked).toBe(true);
  });

  it('earns runtime verification only for what ran', async () => {
    const { sc } = await call('hostproto_capabilities');
    expect(validator('capability-profile')(sc)).toBe(true);
    expect(sc.capabilities['act.continue'].verification).toBe('runtime');
    expect(sc.capabilities['act.host_request.resolve'].verification).toBe('runtime');
    expect(sc.capabilities['act.step_out'].verification).toBe('source-audit');
    expect(sc.capabilities['act.step_back'].availability).toBe('unsupported');
  });
});
