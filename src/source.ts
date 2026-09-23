import type { DocumentInput, Source } from '@kiagent/connector-sdk';
import { displayPath, finalize, parseJson, renderMemory, type AgentCtx } from './doc';
import { listDir, readText, streamLines, type FileStat, type Files } from './files';
import { renderPromptDays, type PromptRow } from './prompts';
import { initialCursor, runSync, type SyncCursor, type Unit } from './sync';
import { systemTz } from './transcript';

export interface SourceOpts {
  tz?: () => string;
  maxDocs?: number;
}

export function missingRootMessage(ctx: AgentCtx): string {
  return `~/.${ctx.root} was not found or not permitted (it must resolve inside your home folder) — run ${ctx.label} once, restart KIA, then add this source`;
}

/** The one seam every document crosses: `finalize` (redaction + hard cap) runs here, once. */
export function makeSource(
  ctx: AgentCtx,
  files: Files,
  discover: (files: Files, cursor: SyncCursor) => Promise<Unit[]>,
  opts?: SourceOpts,
): Source<SyncCursor, DocumentInput> {
  const tz = opts?.tz ?? systemTz;
  return {
    descriptor: { id: ctx.agent, name: ctx.label, documentTypes: ctx.types, auth: 'none', cadence: { every: '15m' } },
    async connect() {
      const roots = await files.roots();
      if (!roots.some((r) => r.id === ctx.root)) throw new Error(missingRootMessage(ctx));
      return { identifier: displayPath(ctx.root, ''), config: {} };
    },
    async *pull(session, cursor) {
      // tz is fixed by the FIRST pull and carried forever after (spec §4.3).
      const c = cursor && cursor.v === 1 && typeof cursor.tz === 'string' ? cursor : initialCursor(tz());
      const units = await discover(files, c);
      for await (const b of runSync({ cursor: c, units, session, maxDocs: opts?.maxDocs })) {
        yield { ...b, items: b.items.map(finalize) };
      }
    },
    toDocument: (item) => item,
  };
}

const TEXT = /\.(md|txt)$/i;

export async function walkText(files: Files, root: string, rel: string): Promise<FileStat[]> {
  const out: FileStat[] = [];
  for (const e of await listDir(files, root, rel)) {
    if (e.kind === 'directory') out.push(...(await walkText(files, root, e.rel)));
    else if (e.kind === 'file' && TEXT.test(e.name)) out.push(e);
  }
  return out;
}

export function memoryUnit(files: Files, ctx: AgentCtx, f: FileStat, label: string | undefined): Unit {
  return {
    key: `memory:${f.rel}`,
    files: [f],
    async render() {
      const text = await readText(files, ctx.root, f.rel, f.size, 1024 * 1024);
      return [renderMemory(ctx.agent, f.rel, label, text, f.mtimeMs, displayPath(ctx.root, f.rel))];
    },
  };
}

export function historyUnit(files: Files, ctx: AgentCtx, f: FileStat, tz: string, toRow: (r: Record<string, any>) => PromptRow | null): Unit {
  return {
    key: 'history',
    files: [f],
    async render() {
      const rows: PromptRow[] = [];
      for await (const line of streamLines(files, ctx.root, f.rel, f.size)) {
        const r = typeof line === 'string' ? parseJson(line) : null;
        const row = r && toRow(r);
        if (row) rows.push(row);
      }
      return renderPromptDays(rows, tz, ctx.agent, displayPath(ctx.root, f.rel));
    },
  };
}
