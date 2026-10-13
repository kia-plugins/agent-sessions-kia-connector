import { CODEX, displayPath, parseJson, sessionDocument, str } from '../doc';
import { firstLine, listDir, streamLines, type FileStat, type Files } from '../files';
import { codexPromptRow } from '../prompts';
import { historyUnit, makeSource, memoryUnit, walkText, type SourceOpts } from '../source';
import { h, type SyncCursor, type Unit } from '../sync';
import { makeTitle } from '../transcript';
import { parseCodexHead, parseCodexSession } from './session';

const R = CODEX.root;
const ROLLOUT = /^rollout-.*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

async function walkRollouts(files: Files, rel: string, out: Map<string, FileStat>): Promise<void> {
  for (const e of await listDir(files, R, rel)) {
    if (e.kind === 'directory') await walkRollouts(files, e.rel, out);
    const m = e.kind === 'file' ? ROLLOUT.exec(e.name) : null;
    if (!m) continue;
    const prev = out.get(m[1]);
    if (!prev || e.mtimeMs > prev.mtimeMs) out.set(m[1], e); // archived copy vs live copy: newest wins
  }
}

/** Last row per id by `updated_at` (file order is not trusted). */
async function readIndex(files: Files, f: FileStat | undefined): Promise<Map<string, string>> {
  const best = new Map<string, { name: string; at: string }>();
  if (!f) return new Map();
  for await (const line of streamLines(files, R, f.rel, f.size)) {
    const r = typeof line === 'string' ? parseJson(line) : null;
    const id = str(r?.id);
    const name = str(r?.thread_name);
    const at = str(r?.updated_at) ?? '';
    if (!id || !name) continue;
    const prev = best.get(id);
    if (!prev || at >= prev.at) best.set(id, { name, at });
  }
  return new Map([...best].map(([id, v]) => [id, v.name]));
}

/** A rollout's parent comes from its first record, which Codex never rewrites
 *  (spec §4.6): read it once, cache it in `cursor.parents` — but only when a
 *  real header parsed, so a file caught mid-write is read again next tick. */
async function parentOf(files: Files, cursor: SyncCursor, key: string, f: FileStat): Promise<{ parentH?: string; cache: boolean }> {
  const known = cursor.parents[h(key)];
  if (known !== undefined) return { parentH: known || undefined, cache: true };
  const head = parseCodexHead(await firstLine(files, R, f.rel, f.size));
  return { parentH: head.parentId ? h(`x:${head.parentId}`) : undefined, cache: head.id !== undefined };
}

export async function discoverCodex(files: Files, cursor: SyncCursor): Promise<Unit[]> {
  const tz = cursor.tz;
  const top = await listDir(files, R, '');
  const at = (name: string) => top.find((e) => e.name === name);
  const index = at('session_index.jsonl');
  const titles = await readIndex(files, index?.kind === 'file' ? index : undefined);

  const rollouts = new Map<string, FileStat>();
  for (const dir of ['sessions', 'archived_sessions']) if (at(dir)?.kind === 'directory') await walkRollouts(files, dir, rollouts);

  const units: Unit[] = [];
  for (const [id, f] of rollouts) {
    const key = `x:${id}`;
    const { parentH, cache } = await parentOf(files, cursor, key, f);
    const indexTitle = titles.get(id);
    units.push({
      key,
      files: [f],
      deps: [indexTitle ?? ''],
      parentH,
      recordParent: cache,
      subagent: parentH ? { externalId: `session:${id}`, type: 'agent.session' } : undefined,
      async render() {
        const s = await parseCodexSession(streamLines(files, R, f.rel, f.size), tz);
        const title = makeTitle(indexTitle, s.head.nickname, s.firstUser, `Session ${id.slice(0, 8)}`);
        return [sessionDocument(CODEX, { sessionId: id, parentSessionId: s.head.parentId, title, info: s, sourcePath: displayPath(R, f.rel), tz })];
      },
    });
  }

  const agents = at('AGENTS.md');
  if (agents?.kind === 'file') units.push(memoryUnit(files, CODEX, agents, undefined));
  if (at('memories')?.kind === 'directory')
    for (const m of await walkText(files, R, 'memories')) units.push(memoryUnit(files, CODEX, m, undefined));
  const history = at('history.jsonl');
  if (history?.kind === 'file') units.push(historyUnit(files, CODEX, history, tz, codexPromptRow));
  return units;
}

export function codexSource(files: Files, opts?: SourceOpts) {
  return makeSource(CODEX, files, discoverCodex, opts);
}
