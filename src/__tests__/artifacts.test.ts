import { renderPlan, renderTasks } from '../claude/artifacts';
import { claudePromptRow, codexPromptRow, renderPromptDays } from '../prompts';
import { CLAUDE, CODEX, claudeProjectLabel, finalize, renderMemory, sessionDocument } from '../doc';
import { DOC_BUDGET } from '../transcript';

const SID = '3ecab6cc-0180-4a43-b16c-3596c0de2aab';

it('claude.tasks.checklist-order (numeric id) + parent for a session-shaped list id', () => {
  const t = (id: string, subject: string, status: string, description = '') =>
    JSON.stringify({ id, subject, description, status, blocks: [], blockedBy: [] });
  const d = renderTasks(SID, [t('10', 'ten', 'pending'), t('2', 'two', 'completed', 'done it'), t('1', 'one', 'in_progress')], 5, '~/.claude/tasks/x');
  expect(d.markdown).toBe('# Tasks — 3ecab6cc\n\n- [ ] one\n- [x] two — done it\n- [ ] ten');
  expect(d).toMatchObject({ externalId: `tasks:${SID}`, type: 'agent.tasks', title: 'Tasks — 3ecab6cc',
    parent: { externalId: `session:${SID}`, type: 'agent.session' }, createdAt: new Date(5).toISOString() });
  expect(renderTasks('team-x', [t('1', 'a', 'pending')], 5, 'p').parent).toBeUndefined();
});

it('plan title from first heading, else file name', () => {
  expect(renderPlan('spicy-wall.md', 'intro\n# Ship the thing\nbody', 7, 'p')).toMatchObject({
    externalId: 'plan:spicy-wall.md', type: 'agent.plan', title: 'Ship the thing', markdown: 'intro\n# Ship the thing\nbody' });
  expect(renderPlan('x.md', 'no heading', 7, 'p').title).toBe('x.md');
});

it('claude.memory.txt-and-md titles', () => {
  const rel = 'projects/-Users-e-work-alpha-cent/memory/notes.txt';
  const d = renderMemory('claude-code', rel, claudeProjectLabel('-Users-e-work-alpha-cent'), 'hello', 9, `~/.claude/${rel}`);
  expect(d).toMatchObject({ externalId: `memory:${rel}`, type: 'agent.memory', title: 'work-alpha-cent — notes.txt', markdown: 'hello' });
  expect(renderMemory('claude-code', 'CLAUDE.md', undefined, 'x', 9, '~/.claude/CLAUDE.md').title).toBe('CLAUDE.md');
});

it('claude.prompts.day-in-cursor-tz-ms + drops-pasted', () => {
  const ms = Date.parse('2026-01-01T23:30:00Z');
  const row = claudePromptRow({ display: 'deploy with TOKEN=abc123def456ghi789', pastedContents: { 1: 'PASTED' },
    timestamp: ms, project: '/Users/e/work/alpha-cent', sessionId: SID })!;
  const [utc] = renderPromptDays([row], 'UTC', 'claude-code', '~/.claude/history.jsonl');
  expect(utc).toMatchObject({ externalId: 'prompts:2026-01-01', type: 'agent.prompts', title: 'Prompts — 2026-01-01',
    createdAt: new Date(ms).toISOString() });
  expect(utc.markdown).toBe('# Prompts — 2026-01-01\n\n- 23:30 · alpha-cent · deploy with TOKEN=abc123def456ghi789 · session 3ecab6cc');
  expect(utc.markdown).not.toContain('PASTED');
  const [berlin] = renderPromptDays([row], 'Europe/Berlin', 'claude-code', 'p');
  expect(berlin.externalId).toBe('prompts:2026-01-02');
});

it('codex.prompts.day-in-cursor-tz-seconds', () => {
  const row = codexPromptRow({ session_id: 'c45386b3-bcb6-42ed-af4e-64edd763b00b', ts: 1756030813, text: 'check the git changes' })!;
  expect(row.atMs).toBe(1756030813000);
  const [d] = renderPromptDays([row], 'UTC', 'codex', '~/.codex/history.jsonl');
  expect(d.externalId).toBe('prompts:2025-08-24');
  expect(d.markdown).toContain('- 10:20 · check the git changes · session c45386b3');
});

it('prompt rows: multi-line display flattened; days sorted; malformed rows rejected', () => {
  expect(claudePromptRow({ display: 'a\n\nb', timestamp: 1 })!.text).toBe('a b');
  expect(claudePromptRow({ display: 'x' })).toBeNull();
  expect(codexPromptRow({ text: 'x', ts: 'soon' })).toBeNull();
  const docs = renderPromptDays(
    [{ atMs: Date.parse('2026-01-02T01:00:00Z'), text: 'b' }, { atMs: Date.parse('2026-01-01T01:00:00Z'), text: 'a' }],
    'UTC', 'codex', 'p');
  expect(docs.map((d) => d.externalId)).toEqual(['prompts:2026-01-01', 'prompts:2026-01-02']);
});

it('redact.applied-to-metadata|titles (finalize)', () => {
  const d = finalize({ externalId: 'e', type: 't', title: 'key sk-ant-api03-AbCdEfGhIjKlMnOp1234', markdown: null,
    metadata: { cwd: '/x/ghp_ABCDEFGHIJKLMNOPQRSTuvwx1234', empty: '', none: undefined, n: 3 }, createdAt: null });
  expect(d.title).toBe('key [redacted]');
  expect(d.metadata).toEqual({ cwd: '/x/[redacted]', n: 3 });
});

it('finalize caps markdown at the document budget', () => {
  const d = finalize({ externalId: 'e', type: 't', title: 't', markdown: 'x'.repeat(DOC_BUDGET * 2), metadata: {}, createdAt: null });
  expect(Buffer.byteLength(d.markdown as string)).toBeLessThanOrEqual(DOC_BUDGET + 4096 + 20);
  expect(d.markdown).toMatch(/… \(truncated\)$/);
});

it('sessionDocument: one assembler for both agents (main, subagent)', () => {
  const info = { cwd: '/Users/e/work/a', gitBranch: 'dev', cliVersion: '2.1.267', model: 'm', startedAt: '2026-09-23T08:02:00Z',
    body: 'BODY' };
  const main = sessionDocument(CLAUDE, { sessionId: SID, title: 'T', info, sourcePath: '~/.claude/p', tz: 'UTC' });
  expect(main).toEqual({
    externalId: `session:${SID}`, type: 'agent.session', title: 'T', createdAt: '2026-09-23T08:02:00Z',
    markdown: `# T\nAgent: Claude Code 2.1.267 · Project: ~/work/a · Branch: dev\nStarted 2026-09-23 08:02 · Resume: \`claude --resume ${SID}\`\n\nBODY`,
    metadata: { agent: 'claude-code', role: 'main', cwd: '/Users/e/work/a', gitBranch: 'dev', sessionId: SID, parentSessionId: undefined,
      model: 'm', cliVersion: '2.1.267', sourcePath: '~/.claude/p' },
  });
  const sub = sessionDocument(CLAUDE, { key: `${SID}/a1`, sessionId: 'a1', parentSessionId: SID, resumeId: SID, title: 'S', info, sourcePath: 'p', tz: 'UTC' });
  expect(sub).toMatchObject({ externalId: `session:${SID}/a1`, parent: { externalId: `session:${SID}`, type: 'agent.session' },
    metadata: { role: 'subagent', sessionId: 'a1', parentSessionId: SID } });
  expect(sub.markdown).toContain(`claude --resume ${SID}`);
  const cx = sessionDocument(CODEX, { sessionId: 'c1', parentSessionId: 'c0', title: 'C', info: { body: '' }, sourcePath: 'p', tz: 'UTC' });
  expect(cx).toMatchObject({ externalId: 'session:c1', parent: { externalId: 'session:c0' }, createdAt: null, metadata: { agent: 'codex' } });
  expect(cx.markdown).toContain('Resume: `codex resume c1`');
});
