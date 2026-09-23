import { OVERSIZED } from '../files';
import { parseJson, str, type SessionInfo } from '../doc';
import { TranscriptBuilder } from '../transcript';

/** Each text part is filtered on its own, so an injected block stored as a
 *  separate part never drags the typed prompt into "keep whole". */
function userTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text as string);
}

export async function parseClaudeSession(lines: AsyncIterable<string | typeof OVERSIZED>, tz: string): Promise<SessionInfo> {
  const b = new TranscriptBuilder(tz);
  const info: Omit<SessionInfo, 'body'> = {};
  for await (const line of lines) {
    const r = line === OVERSIZED ? null : parseJson(line);
    if (!r) continue;
    if (r.type === 'ai-title') {
      info.title = str(r.aiTitle) ?? info.title;
      continue;
    }
    // Record-level exclusions first (spec §4.5 step 1). isSidechain is NOT a filter.
    if ((r.type !== 'user' && r.type !== 'assistant') || r.isMeta || r.isCompactSummary) continue;
    info.cwd ??= str(r.cwd);
    info.gitBranch ??= str(r.gitBranch);
    info.cliVersion ??= str(r.version);
    info.startedAt ??= str(r.timestamp);
    const at = str(r.timestamp);
    const content = r.message?.content;
    if (r.type === 'user') {
      b.user(userTexts(content), at);
      continue;
    }
    info.model ??= str(r.message?.model);
    if (!Array.isArray(content)) continue;
    for (const p of content) {
      if (p?.type === 'text' && typeof p.text === 'string') b.assistant([p.text], at);
      else if (p?.type === 'tool_use' && typeof p.name === 'string') b.tool(p.name, p.input, at);
    }
  }
  return { ...info, firstUser: b.firstUserText, body: b.body() };
}
