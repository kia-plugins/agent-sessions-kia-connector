import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DocumentInput, Source } from '@kiagent/connector-sdk';
import { fakeSession } from '@kiagent/connector-sdk/testing';
import { fsFiles } from '../../test/support/fs-files';
import { claudeSource } from '../claude/source';
import type { SyncCursor } from '../sync';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const PROJ = 'projects/-Users-e-work-alpha-cent';
let root: string;

const rec = (type: 'user' | 'assistant', text: string, extra: object = {}) =>
  JSON.stringify({
    type, timestamp: '2026-09-23T10:02:00Z', cwd: '/Users/e/work/alpha-cent', gitBranch: 'dev', version: '2.1.267',
    message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', model: 'm', content: [{ type: 'text', text }] },
    ...extra,
  }) + '\n';
async function put(rel: string, body: string) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), body);
}
async function pull(src: Source<SyncCursor, DocumentInput>, cursor: SyncCursor | null, stopAfter?: number) {
  const docs: DocumentInput[] = [];
  let last: SyncCursor | null = cursor;
  let n = 0;
  for await (const b of src.pull(fakeSession(), cursor)) {
    docs.push(...b.items);
    last = b.cursor;
    if (stopAfter && ++n >= stopAfter) break;
  }
  return { docs, cursor: last as SyncCursor, ids: docs.map((d) => d.externalId) };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'as-claude-'));
  await put(`${PROJ}/${S1}.jsonl`, rec('user', 'fix login') + rec('assistant', 'done') + JSON.stringify({ type: 'ai-title', aiTitle: 'Login fix' }) + '\n');
  await put(`${PROJ}/${S1}/subagents/agent-a1.jsonl`, rec('user', 'review it', { isSidechain: true }) + rec('assistant', 'LGTM', { isSidechain: true }));
  await put(`${PROJ}/${S1}/subagents/agent-a1.meta.json`, JSON.stringify({ agentType: 'general-purpose', description: 'Review task 7' }));
  await put(`${PROJ}/${S2}/subagents/agent-a2.jsonl`, rec('user', 'orphan work', { isSidechain: true }));
  await put(`${PROJ}/memory/MEMORY.md`, '- index');
  await put(`${PROJ}/memory/notes.txt`, 'notes');
  await put(`${PROJ}/memory/img.png`, 'png');
  await put(`tasks/${S1}/1.json`, JSON.stringify({ id: '1', subject: 'write spec', status: 'completed' }));
  await put(`tasks/${S1}/.lock`, '');
  await put('tasks/lockonly/.lock', '');
  await put('tasks/lockonly/.highwatermark', '3');
  await put('plans/spicy-wall.md', '# Ship it\nbody');
  await put('CLAUDE.md', 'global rules');
  await put('history.jsonl', JSON.stringify({ display: 'fix login', timestamp: Date.parse('2026-09-23T10:02:00Z'), project: '/Users/e/work/alpha-cent', sessionId: S1 }) + '\n');
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

const source = (tz = 'UTC', maxDocs?: number) => claudeSource(fsFiles({ claude: root }), { tz: () => tz, maxDocs });

it('emits every Claude document type into one stream with parent links', async () => {
  const { docs, ids } = await pull(source(), null);
  expect(ids.sort()).toEqual([
    `memory:${PROJ}/memory/MEMORY.md`, `memory:${PROJ}/memory/notes.txt`, 'memory:CLAUDE.md',
    'plan:spicy-wall.md', 'prompts:2026-09-23',
    `session:${S1}`, `session:${S1}/a1`, `session:${S2}/a2`, `tasks:${S1}`,
  ].sort());
  const byId = new Map(docs.map((d) => [d.externalId, d]));
  expect(byId.get(`session:${S1}`)).toMatchObject({ type: 'agent.session', title: 'Login fix',
    metadata: expect.objectContaining({ agent: 'claude-code', role: 'main', sessionId: S1, cwd: '/Users/e/work/alpha-cent' }) });
  expect(byId.get(`session:${S1}`)!.markdown).toContain('Resume: `claude --resume 11111111-1111-4111-8111-111111111111`');
  expect(byId.get(`session:${S1}/a1`)).toMatchObject({ title: 'Review task 7', parent: { externalId: `session:${S1}`, type: 'agent.session' },
    metadata: expect.objectContaining({ role: 'subagent', parentSessionId: S1 }) });
  expect(byId.get(`tasks:${S1}`)!.parent).toEqual({ externalId: `session:${S1}`, type: 'agent.session' });
  expect(ids.indexOf(`session:${S1}`)).toBeLessThan(ids.indexOf(`session:${S1}/a1`));
});

it('claude.orphan-subagent-renders (parent .jsonl removed by cleanup)', async () => {
  const { docs } = await pull(source(), null);
  const orphan = docs.find((d) => d.externalId === `session:${S2}/a2`)!;
  expect(orphan.markdown).toContain('orphan work');
  expect(orphan.parent).toEqual({ externalId: `session:${S2}`, type: 'agent.session' });
});

it('claude.lock-only-tasks-dir-no-unit (and no failure entry)', async () => {
  const { ids, cursor } = await pull(source(), null);
  expect(ids).not.toContain('tasks:lockonly');
  expect(Object.values(cursor.fps).filter((v) => v.startsWith('!'))).toEqual([]);
});

it('orphan subagent re-emits when its parent session appears (parent link)', async () => {
  const first = await pull(source(), null);
  await put(`${PROJ}/${S2}.jsonl`, rec('user', 'parent arrives'));
  expect((await pull(source(), first.cursor)).ids).toEqual([`session:${S2}`, `session:${S2}/a2`]);
});

it('unchanged tick emits nothing; an append re-emits only that session', async () => {
  const first = await pull(source(), null);
  expect((await pull(source(), first.cursor)).ids).toEqual([]);
  await fs.appendFile(path.join(root, `${PROJ}/${S1}.jsonl`), rec('user', 'one more'));
  expect((await pull(source(), first.cursor)).ids).toEqual([`session:${S1}`]);
});

it('sync.task-edit-after-session-cleanup-keeps-parent-ref', async () => {
  const first = await pull(source(), null);
  await fs.rm(path.join(root, `${PROJ}/${S1}.jsonl`));
  await put(`tasks/${S1}/1.json`, JSON.stringify({ id: '1', subject: 'write spec v2', status: 'completed' }));
  const next = await pull(source(), first.cursor);
  const t = next.docs.find((d) => d.externalId === `tasks:${S1}`)!;
  expect(t.parent).toEqual({ externalId: `session:${S1}`, type: 'agent.session' });
});

it('sync.readd-source-keeps-cursor-tz and system-tz-change-does-not-regroup', async () => {
  await put('history.jsonl', JSON.stringify({ display: 'late', timestamp: Date.parse('2026-01-01T23:30:00Z') }) + '\n');
  const first = await pull(source('UTC'), null);
  expect(first.cursor.tz).toBe('UTC');
  expect(first.ids).toContain('prompts:2026-01-01');
  await fs.appendFile(path.join(root, 'history.jsonl'), JSON.stringify({ display: 'later', timestamp: Date.parse('2026-01-01T23:40:00Z') }) + '\n');
  const next = await pull(source('Europe/Berlin'), first.cursor); // OS zone changed / source re-added
  expect(next.ids).toEqual(['prompts:2026-01-01']);
  expect(next.cursor.tz).toBe('UTC');
});

it('sync.intermediate-batch-crash-then-zone-change-keeps-tz', async () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    JSON.stringify({ display: `p${i}`, timestamp: Date.parse(`2026-03-${String(i + 1).padStart(2, '0')}T23:30:00Z`) })).join('\n');
  await put('history.jsonl', rows + '\n');
  const crashed = await pull(source('UTC', 5), null, 1);
  expect(crashed.cursor.pass).toBe('initial');
  const resumed = await pull(source('Asia/Tokyo'), crashed.cursor);
  expect(resumed.cursor.tz).toBe('UTC');
  const all = new Set([...crashed.ids, ...resumed.ids].filter((i) => i.startsWith('prompts:')));
  expect(all).toEqual(new Set(Array.from({ length: 30 }, (_, i) => `prompts:2026-03-${String(i + 1).padStart(2, '0')}`)));
});

it('connect.missing-root-message (claude)', async () => {
  await expect(claudeSource(fsFiles({})).connect({} as never)).rejects.toThrow(
    '~/.claude was not found or not permitted (it must resolve inside your home folder) — run Claude Code once, restart KIA, then add this source',
  );
  await expect(source().connect({} as never)).resolves.toEqual({ identifier: '~/.claude', config: {} });
});

it('descriptor', () => {
  expect(source().descriptor).toEqual({
    id: 'claude-code', name: 'Claude Code', auth: 'none', cadence: { every: '15m' },
    documentTypes: ['agent.session', 'agent.plan', 'agent.tasks', 'agent.memory', 'agent.prompts'],
  });
});

it('source.finalizes-every-item (redaction happens once, in the shell)', async () => {
  await put(`${PROJ}/${S1}.jsonl`, rec('user', 'my key sk-ant-api03-AbCdEfGhIjKlMnOp1234'));
  await put('plans/leak.md', '# Leak\nGITHUB_TOKEN=abc123def456ghi789');
  const { docs } = await pull(source(), null);
  const all = JSON.stringify(docs);
  expect(all).not.toContain('sk-ant-api03-AbCd');
  expect(all).not.toContain('abc123def456ghi789');
  expect(docs.find((d) => d.externalId === `session:${S1}`)!.title).toBe('my key [redacted]');
});
