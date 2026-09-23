import type { DocumentInput } from '@kiagent/connector-sdk';
import { redact } from './redact';
import { cutBytes, DOC_BUDGET, renderSession } from './transcript';

export type Agent = 'claude-code' | 'codex';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Everything that differs between the two agents, in one place. */
export interface AgentCtx {
  root: 'claude' | 'codex';
  agent: Agent;
  label: string;
  resume(sessionId: string): string;
}
export const CLAUDE: AgentCtx = { root: 'claude', agent: 'claude-code', label: 'Claude Code', resume: (id) => `claude --resume ${id}` };
export const CODEX: AgentCtx = { root: 'codex', agent: 'codex', label: 'Codex', resume: (id) => `codex resume ${id}` };

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

export function parseJson(line: string): Record<string, any> | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function displayPath(root: 'claude' | 'codex', rel: string): string {
  return rel ? `~/.${root}/${rel}` : `~/.${root}`;
}

export function projectLabel(p: string | undefined): string | undefined {
  return p?.split('/').filter(Boolean).pop();
}

/** Claude names project dirs by replacing '/' with '-' in the cwd. */
export function claudeProjectLabel(dir: string): string {
  return dir.replace(/^-(?:Users|home)-[^-]+-/, '') || dir;
}

/** Applied once, by the source shell, to every document it yields: the only
 *  redaction pass (spec §4.7) and the only hard size cap. Renderers are pure layout. */
export function finalize(d: DocumentInput): DocumentInput {
  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d.metadata)) {
    if (v === undefined || v === null || v === '') continue;
    metadata[k] = typeof v === 'string' ? redact(v) : v;
  }
  return {
    ...d,
    title: d.title === null ? null : redact(d.title),
    markdown: d.markdown === null ? null : cutBytes(redact(d.markdown), DOC_BUDGET + 4096),
    metadata,
  };
}

/** What either agent's transcript parser returns. */
export interface SessionInfo {
  title?: string;
  cwd?: string;
  gitBranch?: string;
  cliVersion?: string;
  model?: string;
  startedAt?: string;
  firstUser?: string;
  body: string;
}

export function sessionDocument(
  ctx: AgentCtx,
  o: { key?: string; sessionId: string; parentSessionId?: string; resumeId?: string; title: string; info: SessionInfo; sourcePath: string; tz: string },
): DocumentInput {
  const { info } = o;
  return {
    externalId: `session:${o.key ?? o.sessionId}`,
    type: 'agent.session',
    title: o.title,
    markdown: renderSession(
      { title: o.title, agentLabel: ctx.label, cliVersion: info.cliVersion, cwd: info.cwd, gitBranch: info.gitBranch,
        startedAt: info.startedAt, resume: ctx.resume(o.resumeId ?? o.sessionId) },
      info.body,
      o.tz,
    ),
    metadata: {
      agent: ctx.agent, role: o.parentSessionId ? 'subagent' : 'main', cwd: info.cwd, gitBranch: info.gitBranch,
      sessionId: o.sessionId, parentSessionId: o.parentSessionId, model: info.model, cliVersion: info.cliVersion,
      sourcePath: o.sourcePath,
    },
    createdAt: info.startedAt ?? null,
    ...(o.parentSessionId ? { parent: { externalId: `session:${o.parentSessionId}`, type: 'agent.session' } } : {}),
  };
}

export function renderMemory(agent: Agent, rel: string, label: string | undefined, text: string, mtimeMs: number, sourcePath: string): DocumentInput {
  const name = rel.split('/').pop() as string;
  return {
    externalId: `memory:${rel}`,
    type: 'agent.memory',
    title: label ? `${label} — ${name}` : name,
    markdown: text,
    metadata: { agent, sourcePath },
    createdAt: new Date(mtimeMs).toISOString(),
  };
}
