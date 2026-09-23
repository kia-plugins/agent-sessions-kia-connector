import { OVERSIZED } from '../files';
import { parseJson, str, type SessionInfo } from '../doc';
import { TranscriptBuilder } from '../transcript';

export interface CodexHead {
  id?: string;
  parentId?: string;
  nickname?: string;
  cwd?: string;
  gitBranch?: string;
  cliVersion?: string;
  startedAt?: string;
  legacy: boolean;
}

export function parseCodexHead(line: string | null): CodexHead {
  const r = line ? parseJson(line) : null;
  if (!r) return { legacy: false };
  if (r.type === 'session_meta' && r.payload && typeof r.payload === 'object') {
    const p = r.payload;
    const spawn = p.source?.subagent?.thread_spawn;
    return {
      id: str(p.id),
      parentId: str(p.parent_thread_id) ?? str(spawn?.parent_thread_id),
      nickname: str(p.agent_nickname) ?? str(spawn?.agent_nickname),
      cwd: str(p.cwd),
      gitBranch: str(p.git?.branch),
      cliVersion: str(p.cli_version),
      startedAt: str(p.timestamp) ?? str(r.timestamp),
      legacy: false,
    };
  }
  // Legacy (Aug–Sep 2025): {id, timestamp, instructions, git}.
  if (r.type === undefined && str(r.id) && str(r.timestamp))
    return { id: r.id, gitBranch: str(r.git?.branch), startedAt: r.timestamp, legacy: true };
  return { legacy: false };
}

const partTexts = (content: unknown): string[] =>
  Array.isArray(content) ? content.filter((p) => typeof p?.text === 'string').map((p) => p.text as string) : [];

export type CodexSession = SessionInfo & { head: CodexHead };

export async function parseCodexSession(lines: AsyncIterable<string | typeof OVERSIZED>, tz: string): Promise<CodexSession> {
  const b = new TranscriptBuilder(tz);
  let head: CodexHead | null = null;
  let model: string | undefined;
  for await (const line of lines) {
    if (line === OVERSIZED) continue;
    if (head === null) {
      head = parseCodexHead(line);
      continue;
    }
    const r = parseJson(line);
    if (!r) continue;
    let item: Record<string, any> | null = null;
    if (r.type === 'response_item') item = r.payload;
    else if (r.type === 'turn_context') model ??= str(r.payload?.model);
    else if (head.legacy && typeof r.type === 'string' && !('payload' in r)) item = r;
    if (!item || typeof item !== 'object') continue;
    const at = str(r.timestamp);
    switch (item.type) {
      case 'message':
        if (item.role === 'user') b.user(partTexts(item.content), at);
        else if (item.role === 'assistant') b.assistant(partTexts(item.content), at);
        break;
      case 'agent_message':
        b.assistant(partTexts(item.content), at);
        break;
      case 'function_call':
        if (typeof item.name === 'string') b.tool(item.name, item.arguments, at);
        break;
      case 'custom_tool_call':
        if (typeof item.name === 'string') b.tool(item.name, item.input, at);
        break;
      default:
        break; // *_output, reasoning, and anything new: dropped
    }
  }
  const h = head ?? { legacy: false };
  return {
    head: h, cwd: h.cwd, gitBranch: h.gitBranch, cliVersion: h.cliVersion, startedAt: h.startedAt,
    model, firstUser: b.firstUserText, body: b.body(),
  };
}
