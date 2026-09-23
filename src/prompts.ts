import type { DocumentInput } from '@kiagent/connector-sdk';
import { projectLabel, str, type Agent } from './doc';
import { cutBytes, dayKey, hhmm, TURN_CAP } from './transcript';

export interface PromptRow {
  atMs: number;
  text: string;
  project?: string;
  sessionId?: string;
}

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Claude `history.jsonl`: `{display, pastedContents, timestamp (ms), project, sessionId?}`. */
export function claudePromptRow(r: Record<string, any>): PromptRow | null {
  if (typeof r.timestamp !== 'number' || !str(r.display)) return null;
  return { atMs: r.timestamp, text: flat(r.display), project: str(r.project), sessionId: str(r.sessionId) };
}

/** Codex `history.jsonl`: `{session_id, ts (seconds), text}`. */
export function codexPromptRow(r: Record<string, any>): PromptRow | null {
  if (typeof r.ts !== 'number' || !str(r.text)) return null;
  return { atMs: r.ts * 1000, text: flat(r.text), sessionId: str(r.session_id) };
}

export function renderPromptDays(rows: PromptRow[], tz: string, agent: Agent, sourcePath: string): DocumentInput[] {
  const days = new Map<string, PromptRow[]>();
  for (const r of rows) {
    const day = dayKey(r.atMs, tz);
    const list = days.get(day) ?? [];
    list.push(r);
    days.set(day, list);
  }
  return [...days.keys()].sort().map((day) => {
    const list = (days.get(day) as PromptRow[]).sort((x, y) => x.atMs - y.atMs);
    const lines = list.map((r) =>
      '- ' +
      [hhmm(r.atMs, tz), projectLabel(r.project), cutBytes(r.text, TURN_CAP), r.sessionId ? `session ${r.sessionId.slice(0, 8)}` : undefined]
        .filter(Boolean)
        .join(' · '),
    );
    const title = `Prompts — ${day}`;
    return {
      externalId: `prompts:${day}`,
      type: 'agent.prompts',
      title,
      markdown: `# ${title}\n\n${lines.join('\n')}`,
      metadata: { agent, sourcePath },
      createdAt: new Date(list[0].atMs).toISOString(),
    };
  });
}
