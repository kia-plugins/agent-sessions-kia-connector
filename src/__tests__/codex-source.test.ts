import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DocumentInput, Source } from '@kiagent/connector-sdk';
import { fakeSession } from '@kiagent/connector-sdk/testing';
import { fsFiles } from '../../test/support/fs-files';
import { codexSource } from '../codex/source';
import type { SyncCursor } from '../sync';

const P = '01a0cf14-f6a7-7282-8da4-61b7b0d85200';
const C = '01a0cf15-e417-76d2-9ec2-824937247a6a';
const G = '01a0cf16-0000-7000-8000-000000000001';
const L = '56f43c72-3946-4ba0-a508-e2bf9f8aec0f';
const DAY = 'sessions/2026/09/23';
let root: string;

async function put(rel: string, body: string) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), body);
}
const rollout = (id: string, parent: string | undefined, text: string, nickname?: string) =>
  [
    { timestamp: '2026-09-23T10:00:00Z', type: 'session_meta', payload: { id, timestamp: '2026-09-23T10:00:00Z', cwd: '/Users/e/work/a',
      cli_version: '0.155.1', git: { branch: 'dev' },
      ...(parent ? { parent_thread_id: parent, agent_nickname: nickname, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } : {}) } },
    { timestamp: '2026-09-23T10:00:05Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n';
const index = (id: string, name: string, at: string) => JSON.stringify({ id, thread_name: name, updated_at: at }) + '\n';

async function pull(src: Source<SyncCursor, DocumentInput>, cursor: SyncCursor | null, skip = false) {
  const docs: DocumentInput[] = [];
  let last = cursor;
  for await (const b of src.pull(fakeSession({ account: { config: { options: { skipSubagents: skip } } } }), cursor)) {
    docs.push(...b.items);
    last = b.cursor;
  }
  return { docs, cursor: last as SyncCursor, ids: docs.map((d) => d.externalId) };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'as-codex-'));
  // Same-second filenames: the child sorts BEFORE the parent by name.
  await put(`${DAY}/rollout-2026-09-23T10-00-00-${C}.jsonl`, rollout(C, P, 'child work', 'Hegel'));
  await put(`${DAY}/rollout-2026-09-23T10-00-00-${P}.jsonl`, rollout(P, undefined, 'parent work'));
  await put(`${DAY}/rollout-2026-09-23T10-00-00-${G}.jsonl`, rollout(G, C, 'grandchild work', 'Kant'));
  await put(`archived_sessions/rollout-2025-08-20T20-50-14-${L}.jsonl`,
    JSON.stringify({ id: L, timestamp: '2025-08-20T20:50:14.752Z', instructions: null, git: { branch: 'main' } }) + '\n' +
    JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'legacy hello' }] }) + '\n');
  await put('session_index.jsonl', index(P, 'Newer name', '2026-09-23T12:00:00Z') + index(P, 'Older name', '2026-09-23T11:00:00Z'));
  await put('history.jsonl', JSON.stringify({ session_id: P, ts: 1758621600, text: 'parent work' }) + '\n');
  await put('AGENTS.md', 'global agent rules');
  await put('memories/notes.md', 'remember this');
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

const files = () => fsFiles({ codex: root });
const source = (f = files(), maxDocs?: number) => codexSource(f, { tz: () => 'UTC', maxDocs });

it('codex.nested-subagent-links-parent (+ parent-before-child across batch boundary, batch size 1)', async () => {
  const { docs, ids } = await pull(source(files(), 1), null);
  const byId = new Map(docs.map((d) => [d.externalId, d]));
  expect(byId.get(`session:${C}`)).toMatchObject({ title: 'Hegel', parent: { externalId: `session:${P}`, type: 'agent.session' },
    metadata: expect.objectContaining({ agent: 'codex', role: 'subagent', parentSessionId: P }) });
  expect(byId.get(`session:${G}`)!.parent).toEqual({ externalId: `session:${C}`, type: 'agent.session' });
  expect(ids.indexOf(`session:${P}`)).toBeLessThan(ids.indexOf(`session:${C}`));
  expect(ids.indexOf(`session:${C}`)).toBeLessThan(ids.indexOf(`session:${G}`));
  expect(byId.get(`session:${P}`)!.markdown).toContain('Resume: `codex resume 01a0cf14-f6a7-7282-8da4-61b7b0d85200`');
});

it('codex.title-from-session-index-last-wins (by updated_at, not file order)', async () => {
  const { docs } = await pull(source(), null);
  expect(docs.find((d) => d.externalId === `session:${P}`)!.title).toBe('Newer name');
});

it('codex.rename-changes-fingerprint (only the renamed thread re-renders)', async () => {
  const first = await pull(source(), null);
  await fs.appendFile(path.join(root, 'session_index.jsonl'), index(P, 'Renamed', '2026-09-23T13:00:00Z'));
  const next = await pull(source(), first.cursor);
  expect(next.ids).toEqual([`session:${P}`]);
  expect(next.docs[0].title).toBe('Renamed');
});

it('legacy rollout, memory, prompts', async () => {
  const { docs, ids } = await pull(source(), null);
  expect(ids).toEqual(expect.arrayContaining([`session:${L}`, 'memory:AGENTS.md', 'memory:memories/notes.md', 'prompts:2025-09-23']));
  expect(docs.find((d) => d.externalId === `session:${L}`)!.markdown).toContain('legacy hello');
});

it('unchanged tick re-reads no rollout; an appended rollout is re-read in full once', async () => {
  const first = await pull(source(), null);
  const f = files();
  expect((await pull(source(f), first.cursor)).ids).toEqual([]);
  expect(f.reads.filter((r) => r.rel.includes('rollout-'))).toEqual([]);
  await fs.appendFile(path.join(root, `${DAY}/rollout-2026-09-23T10-00-00-${C}.jsonl`),
    JSON.stringify({ timestamp: '2026-09-23T10:05:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'more' }] } }) + '\n');
  const g = files();
  const next = await pull(source(g), first.cursor);
  expect(next.ids).toEqual([`session:${C}`]);
  expect(next.docs[0].parent).toEqual({ externalId: `session:${P}`, type: 'agent.session' });
  expect(new Set(g.reads.filter((r) => r.rel.includes('rollout-')).map((r) => r.rel))).toEqual(new Set([`${DAY}/rollout-2026-09-23T10-00-00-${C}.jsonl`]));
});

it('connect.missing-root-message (codex)', async () => {
  await expect(codexSource(fsFiles({})).connect({} as never)).rejects.toThrow(
    '~/.codex was not found or not permitted (it must resolve inside your home folder) — run Codex once, restart KIA, then add this source',
  );
});

it('codex.partial-first-line-not-cached (child caught mid-write still re-emits when its parent appears later)', async () => {
  const rel = `${DAY}/rollout-2026-09-23T10-00-00-${C}.jsonl`;
  const prel = `${DAY}/rollout-2026-09-23T10-00-00-${P}.jsonl`;
  await fs.rm(path.join(root, prel));
  await put(rel, '{"timestamp":"2026-09-23T10:00:00Z","type":"session_me');
  const first = await pull(source(), null);
  await put(rel, rollout(C, P, 'child work', 'Hegel'));
  const second = await pull(source(), first.cursor);
  expect(second.ids).toContain(`session:${C}`);
  await put(prel, rollout(P, undefined, 'parent work'));
  const third = await pull(source(), second.cursor);
  expect(third.ids).toEqual([`session:${P}`, `session:${C}`]);
});

it('skip on: threads with a parent (any depth) are not emitted; the parent is', async () => {
  const { ids } = await pull(source(), null, true);
  expect(ids).toContain(`session:${P}`);
  expect(ids).not.toContain(`session:${C}`);
  expect(ids).not.toContain(`session:${G}`);
});
