import { CLAUDE, claudeProjectLabel, displayPath, parseJson, sessionDocument, str, UUID } from '../doc';
import { listDir, readText, streamLines, type FileStat, type Files } from '../files';
import { claudePromptRow } from '../prompts';
import { historyUnit, makeSource, memoryUnit, walkText, type SourceOpts } from '../source';
import { h, type SyncCursor, type Unit } from '../sync';
import { makeTitle } from '../transcript';
import { renderPlan, renderTasks } from './artifacts';
import { parseClaudeSession } from './session';

const R = CLAUDE.root;

function sessionUnit(files: Files, tz: string, f: FileStat, sessionId: string, sub?: { agentId: string; meta?: FileStat }): Unit {
  return {
    key: sub ? `c:${sessionId}/${sub.agentId}` : `c:${sessionId}`,
    files: sub?.meta ? [f, sub.meta] : [f],
    parentH: sub ? h(`c:${sessionId}`) : undefined,
    subagent: sub ? { externalId: `session:${sessionId}/${sub.agentId}`, type: 'agent.session' } : undefined,
    async render() {
      const info = await parseClaudeSession(streamLines(files, R, f.rel, f.size), tz);
      const sourcePath = displayPath(R, f.rel);
      if (!sub) {
        const title = makeTitle(info.title, info.firstUser, `Session ${sessionId.slice(0, 8)}`);
        return [sessionDocument(CLAUDE, { sessionId, title, info, sourcePath, tz })];
      }
      const meta = sub.meta ? parseJson(await readText(files, R, sub.meta.rel, sub.meta.size, 64 * 1024)) : null;
      const title = makeTitle(str(meta?.description), str(meta?.agentType), info.firstUser, `Session ${sub.agentId.slice(0, 8)}`);
      return [
        sessionDocument(CLAUDE, {
          key: `${sessionId}/${sub.agentId}`, sessionId: sub.agentId, parentSessionId: sessionId, resumeId: sessionId,
          title, info, sourcePath, tz,
        }),
      ];
    },
  };
}

export async function discoverClaude(files: Files, cursor: SyncCursor): Promise<Unit[]> {
  const tz = cursor.tz;
  const units: Unit[] = [];
  const top = await listDir(files, R, '');
  const at = (name: string) => top.find((e) => e.name === name);

  if (at('projects')?.kind === 'directory') {
    for (const proj of await listDir(files, R, 'projects')) {
      if (proj.kind !== 'directory') continue;
      for (const e of await listDir(files, R, proj.rel)) {
        if (e.kind === 'file' && e.name.endsWith('.jsonl')) {
          units.push(sessionUnit(files, tz, e, e.name.slice(0, -'.jsonl'.length)));
        } else if (e.kind === 'directory' && e.name === 'memory') {
          for (const m of await walkText(files, R, e.rel)) units.push(memoryUnit(files, CLAUDE, m, claudeProjectLabel(proj.name)));
        } else if (e.kind === 'directory' && UUID.test(e.name)) {
          const subs = await listDir(files, R, `${e.rel}/subagents`);
          for (const s of subs) {
            const m = /^agent-(.+)\.jsonl$/.exec(s.name);
            if (s.kind !== 'file' || !m) continue;
            const meta = subs.find((x) => x.kind === 'file' && x.name === `agent-${m[1]}.meta.json`);
            units.push(sessionUnit(files, tz, s, e.name, { agentId: m[1], meta }));
          }
        }
      }
    }
  }

  if (at('tasks')?.kind === 'directory') {
    for (const dir of await listDir(files, R, 'tasks')) {
      if (dir.kind !== 'directory') continue;
      const tfiles = (await listDir(files, R, dir.rel)).filter((f) => f.kind === 'file' && f.name.endsWith('.json') && !f.name.startsWith('.'));
      if (tfiles.length === 0) continue;
      const listId = dir.name;
      units.push({
        key: `t:${listId}`,
        files: tfiles,
        parentH: UUID.test(listId) ? h(`c:${listId}`) : undefined,
        async render() {
          const bodies = await Promise.all(tfiles.map((f) => readText(files, R, f.rel, f.size, 256 * 1024)));
          return [renderTasks(listId, bodies, Math.min(...tfiles.map((f) => f.mtimeMs)), displayPath(R, dir.rel))];
        },
      });
    }
  }

  if (at('plans')?.kind === 'directory') {
    for (const p of await listDir(files, R, 'plans')) {
      if (p.kind !== 'file' || !p.name.endsWith('.md')) continue;
      units.push({
        key: `plan:${p.name}`,
        files: [p],
        async render() {
          return [renderPlan(p.name, await readText(files, R, p.rel, p.size, 1024 * 1024), p.mtimeMs, displayPath(R, p.rel))];
        },
      });
    }
  }

  const claudeMd = at('CLAUDE.md');
  if (claudeMd?.kind === 'file') units.push(memoryUnit(files, CLAUDE, claudeMd, undefined));
  const history = at('history.jsonl');
  if (history?.kind === 'file') units.push(historyUnit(files, CLAUDE, history, tz, claudePromptRow));
  return units;
}

export function claudeSource(files: Files, opts?: SourceOpts) {
  return makeSource(CLAUDE, files, discoverClaude, opts);
}
