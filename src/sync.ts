import { createHash } from 'node:crypto';
import type { Batch, DocumentInput, PullPhase, Session } from '@kiagent/connector-sdk';
import type { FileStat } from './files';

/** Bump whenever parsing, filtering, redaction or layout changes (spec §4.3). */
export const RENDER_VERSION = 1;
/** Docs are capped near 516 KiB, so 15 per batch keeps a batch under ~8 MiB. */
const MAX_DOCS = 15;
/** Refs per deletion-only batch while skipping subagents (spec §4.3). */
export const DELETE_CHUNK = 500;

export function h(s: string): string {
  return createHash('sha256').update(s).digest('base64url').slice(0, 11);
}

export interface SyncCursor {
  v: 1;
  fps: Record<string, string>;
  parents: Record<string, string>;
  pass: 'initial' | 'done';
  tz: string;
}

export function initialCursor(tz: string): SyncCursor {
  return { v: 1, fps: {}, parents: {}, pass: 'initial', tz };
}

export interface Unit {
  key: string;
  files: Array<Pick<FileStat, 'rel' | 'size' | 'mtimeMs' | 'dev' | 'ino'>>;
  deps?: string[];
  parentH?: string;
  recordParent?: boolean;
  /** Set on subagent-session units: the doc they render (spec §4.2). */
  subagent?: { externalId: string; type: 'agent.session' };
  render(): Promise<DocumentInput[]>;
}

const strip = (v: string | undefined): string | undefined => (v?.startsWith('!') ? v.slice(1) : v);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function* runSync(o: {
  cursor: SyncCursor;
  units: Unit[];
  session: Pick<Session, 'signal' | 'log'>;
  maxDocs?: number;
  skipSubagents?: boolean;
}): AsyncGenerator<Batch<SyncCursor, DocumentInput>> {
  const maxDocs = o.maxDocs ?? MAX_DOCS;
  const cur = o.cursor;
  const fps = { ...cur.fps };
  const parents = { ...cur.parents };
  const phase: PullPhase = cur.pass === 'initial' ? 'backfill' : 'live';
  const checkpoint = (pass: SyncCursor['pass']): SyncCursor => ({ v: 1, fps: { ...fps }, parents: { ...parents }, pass, tz: cur.tz });

  const byH = new Map<string, Unit & { uh: string }>();
  for (const u of o.units) byH.set(h(u.key), Object.assign(u, { uh: h(u.key) }));
  for (const [uh, u] of byH) if (u.recordParent) parents[uh] = u.parentH ?? '';
  // Spec §4.3, after the recordParent loop so skipped Codex subagents keep
  // their cached parent. While skipping, subagent units are never rendered,
  // and any that were indexed (an fps entry exists, ok or failed) are deleted
  // FIRST, in deletion-only batches. Each batch drops only ITS chunk's fps
  // entries, so a crash between batches leaves the rest for the next pull.
  const skipped = o.skipSubagents ? [...byH.values()].filter((u) => u.subagent) : [];
  for (const u of skipped) byH.delete(u.uh);
  const cleanup = skipped
    .filter((u) => fps[u.uh] !== undefined)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (let i = 0; i < cleanup.length; i += DELETE_CHUNK) {
    const chunk = cleanup.slice(i, i + DELETE_CHUNK);
    for (const u of chunk) delete fps[u.uh];
    yield { phase, items: [], deletions: chunk.map((u) => u.subagent!), cursor: checkpoint(cur.pass) };
    if (o.session.signal.aborted) return;
  }

  const depth = new Map<string, number>();
  const depthOf = (uh: string, seen: Set<string> = new Set()): number => {
    const known = depth.get(uh);
    if (known !== undefined) return known;
    const p = byH.get(uh)?.parentH;
    let d = 0;
    if (p && byH.has(p) && !seen.has(uh)) {
      seen.add(uh);
      d = depthOf(p, seen) + 1;
    }
    depth.set(uh, d);
    return d;
  };
  const ordered = [...byH.values()].sort(
    (a, b) => depthOf(a.uh) - depthOf(b.uh) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  const isOk = (ph: string): boolean => {
    const v = fps[ph];
    return v !== undefined && !v.startsWith('!');
  };
  const base = (u: Unit): string =>
    h(JSON.stringify([RENDER_VERSION, u.files.map((f) => [f.rel, f.size, f.mtimeMs, f.dev, f.ino]), u.deps ?? []]));
  const fpOf = (u: Unit, linked: boolean): string => (u.parentH ? h(`${base(u)}|${linked ? 1 : 0}`) : base(u));

  // Selection: linkedSel is optimistic and never persisted (spec §4.3).
  const selected = new Set<string>();
  for (const u of ordered) {
    const linkedSel = u.parentH ? isOk(u.parentH) || selected.has(u.parentH) : false;
    if (strip(fps[u.uh]) !== fpOf(u, linkedSel)) selected.add(u.uh);
  }

  let items: DocumentInput[] = [];
  for (const u of ordered) {
    if (!selected.has(u.uh)) continue;
    if (o.session.signal.aborted) return;
    const linkedActual = u.parentH ? isOk(u.parentH) : false;
    let docs: DocumentInput[] = [];
    let ok = true;
    try {
      docs = await u.render();
    } catch (e) {
      ok = false;
      o.session.log('warn', `agent-sessions: ${u.key} skipped: ${errText(e)}`);
    }
    const fp = fpOf(u, linkedActual);
    // A unit's fp enters the map with its LAST document, so the batch that
    // carries that document also carries the fp (never one batch later).
    if (docs.length === 0) fps[u.uh] = ok ? fp : `!${fp}`;
    for (let i = 0; i < docs.length; i++) {
      items.push(docs[i]);
      if (i === docs.length - 1) fps[u.uh] = fp;
      if (items.length >= maxDocs) {
        yield { phase, items, cursor: checkpoint(cur.pass) };
        items = [];
        if (o.session.signal.aborted) return;
      }
    }
  }
  yield { phase, items, cursor: checkpoint('done') };
}
