import { OVERSIZED } from '../files';
import { parseClaudeSession } from '../claude/session';

async function* lines(recs: unknown[]): AsyncGenerator<string | typeof OVERSIZED> {
  for (const r of recs) yield r === OVERSIZED ? OVERSIZED : typeof r === 'string' ? r : JSON.stringify(r);
}
const u = (content: unknown, extra: object = {}) => ({
  type: 'user', timestamp: '2026-09-23T10:02:00Z', cwd: '/Users/e/work/a', gitBranch: 'dev', version: '2.1.267',
  isSidechain: false, sessionId: 's', message: { role: 'user', content }, ...extra,
});
const a = (content: unknown[], extra: object = {}) => ({
  type: 'assistant', timestamp: '2026-09-23T10:03:00Z', isSidechain: false,
  message: { role: 'assistant', model: 'claude-opus-5-5', content }, ...extra,
});
const parse = (recs: unknown[]) => parseClaudeSession(lines(recs), 'UTC');

it('claude.session.turns-and-tool-lines (+ metadata)', async () => {
  const s = await parse([
    { type: 'permission-mode', permissionMode: 'default', sessionId: 's' },
    u('fix the login bug'),
    a([{ type: 'text', text: 'On it' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status -sb' } }]),
  ]);
  expect(s.body).toBe('## User — 10:02\nfix the login bug\n\n## Assistant — 10:03\nOn it\n→ Bash: git status -sb');
  expect(s).toMatchObject({ cwd: '/Users/e/work/a', gitBranch: 'dev', cliVersion: '2.1.267', model: 'claude-opus-5-5',
    startedAt: '2026-09-23T10:02:00Z', firstUser: 'fix the login bug' });
});

it('claude.session.drops-tool-results', async () => {
  const s = await parse([u('go'), u([{ type: 'tool_result', tool_use_id: 't1', content: 'TOOL-OUTPUT' }])]);
  expect(s.body).not.toContain('TOOL-OUTPUT');
  expect(s.body).toBe('## User — 10:02\ngo');
});

it('claude.session.drops-thinking-and-attachments', async () => {
  const s = await parse([
    u('go'),
    { type: 'attachment', timestamp: '2026-09-23T10:02:30Z', attachment: { content: 'ATTACHED' } },
    { type: 'system', subtype: 'x', content: 'SYSTEM', isMeta: false },
    a([{ type: 'thinking', thinking: 'HIDDEN' }, { type: 'redacted_thinking', data: 'ENC' }, { type: 'text', text: 'ok' }]),
  ]);
  for (const s2 of ['ATTACHED', 'SYSTEM', 'HIDDEN', 'ENC']) expect(s.body).not.toContain(s2);
  expect(s.body).toContain('ok');
});

it('claude.session.drops-compact-summary and drops-array-form-isMeta', async () => {
  const s = await parse([
    u('This session is being continued… COMPACT-TEXT', { isCompactSummary: true }),
    u([{ type: 'text', text: 'META-TEXT' }], { isMeta: true }),
    u('real'),
  ]);
  expect(s.body).toBe('## User — 10:02\nreal');
});

it('claude.session.renders-slash-command and renders-bash-input', async () => {
  const s = await parse([
    u('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'),
    u('<local-command-stdout>Set model to opus</local-command-stdout>'),
    u('<bash-input>ls</bash-input>'),
    u('<bash-stdout>a b</bash-stdout><bash-stderr></bash-stderr>'),
  ]);
  expect(s.body).toBe('## User — 10:02\n/model opus\n\n## User — 10:02\n! ls');
});

it('array content: each text part filtered on its own', async () => {
  const s = await parse([u([{ type: 'text', text: '<system-reminder>CLAUDE.md dump</system-reminder>' }, { type: 'text', text: 'fix it' }])]);
  expect(s.body).toBe('## User — 10:02\nfix it');
});

it('claude.session.title-last-ai-title', async () => {
  const s = await parse([
    { type: 'ai-title', aiTitle: 'First guess', sessionId: 's' }, u('x'),
    { type: 'ai-title', aiTitle: 'Final title', sessionId: 's' },
  ]);
  expect(s.title).toBe('Final title');
});

it('claude.session.subagent-not-emptied-by-sidechain', async () => {
  const s = await parse([u('Review task 7', { isSidechain: true }), a([{ type: 'text', text: 'LGTM' }], { isSidechain: true })]);
  expect(s.body).toContain('Review task 7');
  expect(s.body).toContain('LGTM');
});

it('oversized, unparsable and interrupted lines skipped silently', async () => {
  const s = await parse([u('a'), OVERSIZED, '{"type":"us', u('[Request interrupted by user]'), a([{ type: 'text', text: 'b' }])]);
  expect(s.body).toBe('## User — 10:02\na\n\n## Assistant — 10:03\nb');
});
