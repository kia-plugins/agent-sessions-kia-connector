import { OVERSIZED } from '../files';
import { parseCodexHead, parseCodexSession } from '../codex/session';

const TID = '01a0cf15-e417-76d2-9ec2-824937247a6a';
const PID = '01a0cf14-f6a7-7282-8da4-61b7b0d85200';
async function* lines(recs: unknown[]): AsyncGenerator<string | typeof OVERSIZED> {
  for (const r of recs) yield r === OVERSIZED ? OVERSIZED : typeof r === 'string' ? r : JSON.stringify(r);
}
const meta = (p: object = {}) => ({
  timestamp: '2026-09-23T16:25:13.521Z', type: 'session_meta',
  payload: { id: TID, session_id: TID, timestamp: '2026-09-23T16:25:13.521Z', cwd: '/Users/e/work/a', cli_version: '0.155.1',
    git: { branch: 'dev' }, base_instructions: 'BASE-INSTRUCTIONS', ...p },
});
const ri = (payload: object) => ({ timestamp: '2026-09-23T16:26:00Z', type: 'response_item', payload });
const msg = (role: string, texts: string[], kind = role === 'assistant' ? 'output_text' : 'input_text') =>
  ri({ type: 'message', role, content: texts.map((text) => ({ type: kind, text })) });
const parse = (recs: unknown[]) => parseCodexSession(lines(recs), 'UTC');

it('head: main thread, nested subagent via parent_thread_id, fallback via source.subagent.thread_spawn', () => {
  expect(parseCodexHead(JSON.stringify(meta()))).toMatchObject({ id: TID, parentId: undefined, cwd: '/Users/e/work/a',
    gitBranch: 'dev', cliVersion: '0.155.1', startedAt: '2026-09-23T16:25:13.521Z', legacy: false });
  expect(parseCodexHead(JSON.stringify(meta({ parent_thread_id: PID, agent_nickname: 'Hegel' })))).toMatchObject({ parentId: PID, nickname: 'Hegel' });
  expect(parseCodexHead(JSON.stringify(meta({ source: { subagent: { thread_spawn: { parent_thread_id: PID, agent_nickname: 'Kant' } } } }))))
    .toMatchObject({ parentId: PID, nickname: 'Kant' });
  expect(parseCodexHead(null)).toEqual({ legacy: false });
});

it('codex.current.agent-message-is-assistant', async () => {
  const s = await parse([meta(), ri({ type: 'agent_message', author: '/root', recipient: '/root/x', content: [{ type: 'input_text', text: 'Review the parser' }] })]);
  expect(s.body).toBe('## Assistant — 16:26\nReview the parser');
});

it('codex.current.filters-injected-context (+ developer dropped, AGENTS.md dropped)', async () => {
  const s = await parse([
    meta(),
    msg('developer', ['<skills_instructions>DEV</skills_instructions>']),
    msg('user', ['# AGENTS.md instructions for /Users/e/work/a\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>',
      '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>', 'make the tests pass']),
    msg('user', ['<turn_aborted>aborted</turn_aborted>']),
  ]);
  expect(s.body).toBe('## User — 16:26\nmake the tests pass');
  expect(s.firstUser).toBe('make the tests pass');
});

it('tool calls become lines; outputs, reasoning, events and usage dropped; model from turn_context', async () => {
  const s = await parse([
    meta(),
    { timestamp: 't', type: 'turn_context', payload: { model: 'gpt-5.5-codex', cwd: '/x' } },
    msg('user', ['go']),
    ri({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'REASONING' }], encrypted_content: 'ENC' }),
    ri({ type: 'function_call', name: 'exec_command', namespace: 'x', arguments: '{"cmd":"npm test"}', call_id: 'c1' }),
    ri({ type: 'function_call_output', call_id: 'c1', output: 'FUNC-OUTPUT' }),
    ri({ type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: a.ts', call_id: 'c2' }),
    ri({ type: 'custom_tool_call_output', call_id: 'c2', output: 'PATCH-OUTPUT' }),
    { timestamp: 't', type: 'event_msg', payload: { type: 'token_count', info: {} } },
    { timestamp: 't', type: 'token_usage_record', usage: {} },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'BARE' }] }, // legacy-shaped line in a current file
    msg('assistant', ['All green']),
  ]);
  for (const x of ['REASONING', 'ENC', 'FUNC-OUTPUT', 'PATCH-OUTPUT', 'BASE-INSTRUCTIONS', 'BARE']) expect(s.body).not.toContain(x);
  expect(s.body).toBe('## User — 16:26\ngo\n\n## Assistant — 16:26\nAll green\n→ exec_command: npm test\n→ apply_patch: *** Begin Patch');
  expect(s.model).toBe('gpt-5.5-codex');
});

it('codex.legacy.renders-turns', async () => {
  const s = await parse([
    { id: '56f43c72-3946-4ba0-a508-e2bf9f8aec0f', timestamp: '2025-08-20T20:50:14.752Z', instructions: null,
      git: { commit_hash: 'bb7f', branch: 'main' } },
    { record_type: 'state' },
    { type: 'message', id: null, role: 'user', content: [{ type: 'input_text', text: '<environment_context>\ncwd\n</environment_context>' }] },
    { type: 'message', id: null, role: 'user', content: [{ type: 'input_text', text: 'hello legacy' }] },
    { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'THINK' }] },
    { type: 'message', id: null, role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c' },
  ]);
  expect(s.head).toMatchObject({ id: '56f43c72-3946-4ba0-a508-e2bf9f8aec0f', gitBranch: 'main', legacy: true,
    startedAt: '2025-08-20T20:50:14.752Z' });
  expect(s.body).toBe('## User\nhello legacy\n\n## Assistant\nhi\n→ shell: ls');
});

it('oversized record skipped silently', async () => {
  const s = await parse([meta(), msg('user', ['a']), OVERSIZED, msg('assistant', ['b'])]);
  expect(s.body).toBe('## User — 16:26\na\n\n## Assistant — 16:26\nb');
});

it('returns the shared SessionInfo shape (head fields flattened)', async () => {
  const s = await parse([meta(), msg('user', ['go'])]);
  expect(s).toMatchObject({ cwd: '/Users/e/work/a', gitBranch: 'dev', cliVersion: '0.155.1', startedAt: '2026-09-23T16:25:13.521Z',
    firstUser: 'go', head: { id: TID } });
});
