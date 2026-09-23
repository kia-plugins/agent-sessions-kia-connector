import { TranscriptBuilder, dayKey, hhmm, makeTitle, renderSession, toolLine, tildify, HALF, TURN_CAP } from '../transcript';

const TZ = 'Europe/Berlin';

it('toolLine picks the most descriptive field, else the raw first line, capped at 160', () => {
  expect(toolLine('Bash', { command: 'git status -sb', description: 'x' })).toBe('→ Bash: git status -sb');
  expect(toolLine('Edit', { file_path: '/a/b.ts', old_string: 'x' })).toBe('→ Edit: /a/b.ts');
  expect(toolLine('exec_command', '{"cmd":"ls -la"}')).toBe('→ exec_command: ls -la');
  expect(toolLine('exec', 'const r = await tools.exec({})\nmore')).toBe('→ exec: const r = await tools.exec({})');
  expect(toolLine('X', {})).toBe('→ X');
  expect(toolLine('shell', { command: ['bash', '-lc', 'ls'] })).toBe('→ shell: bash -lc ls');
  expect(toolLine('Bash', { command: 'y'.repeat(500) })).toHaveLength('→ Bash: '.length + 160);
});

it('dayKey/hhmm use the given zone', () => {
  const ms = Date.parse('2026-01-01T23:30:00Z');
  expect(dayKey(ms, 'UTC')).toBe('2026-01-01');
  expect(dayKey(ms, TZ)).toBe('2026-01-02');
  expect(hhmm(ms, TZ)).toBe('00:30');
});

it('merges consecutive assistant records into one turn with tool lines', () => {
  const b = new TranscriptBuilder('UTC');
  b.user(['hello'], '2026-01-01T10:00:00Z');
  b.assistant(['hi'], '2026-01-01T10:01:00Z');
  b.tool('Bash', { command: 'ls' }, '2026-01-01T10:01:05Z');
  b.assistant(['done'], '2026-01-01T10:02:00Z');
  expect(b.body()).toBe('## User — 10:00\nhello\n\n## Assistant — 10:01\nhi\n\ndone\n→ Bash: ls');
  expect(b.firstUserText).toBe('hello');
});

it('user() filters injected wrapper parts and keeps the rest', () => {
  const b = new TranscriptBuilder('UTC');
  b.user(['<system-reminder>noise</system-reminder>']);
  b.user(['<command-name>/review</command-name><command-args>42</command-args>', '<system-reminder>x</system-reminder>', 'please']);
  expect(b.body()).toBe('## User\n/review 42\n\nplease');
  expect(b.firstUserText).toBe('/review 42\n\nplease');
});

it('turn-cut-at-16k', () => {
  const b = new TranscriptBuilder('UTC');
  b.user(['a'.repeat(TURN_CAP * 2)]);
  const body = b.body();
  expect(body.endsWith('… (truncated)')).toBe(true);
  expect(Buffer.byteLength(body)).toBeLessThan(TURN_CAP + 100);
});

it('budget-head-tail-omission', () => {
  const b = new TranscriptBuilder('UTC');
  for (let i = 0; i < 200; i++) b.user([`turn-${i} ` + 'x'.repeat(8000)]);
  const body = b.body();
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(2 * HALF + 200);
  expect(body).toContain('turn-0 ');
  expect(body).toContain('turn-199 ');
  expect(body).toMatch(/_… \d+ turns omitted …_/);
});

it('renderSession header + makeTitle + tildify', () => {
  expect(tildify('/Users/eldar/work/a')).toBe('~/work/a');
  expect(makeTitle(undefined, '  \nFix the login bug\nmore', 'x')).toBe('Fix the login bug');
  expect(makeTitle(undefined, undefined, 'Session 3bd46c2a')).toBe('Session 3bd46c2a');
  const md = renderSession(
    { title: 'T', agentLabel: 'Claude Code', cliVersion: '2.1.267', cwd: '/Users/e/work/a', gitBranch: 'dev',
      startedAt: '2026-09-23T08:02:00Z', resume: 'claude --resume abc' },
    'BODY', 'UTC');
  expect(md).toBe('# T\nAgent: Claude Code 2.1.267 · Project: ~/work/a · Branch: dev\nStarted 2026-09-23 08:02 · Resume: `claude --resume abc`\n\nBODY');
});
