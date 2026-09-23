import { redact } from './redact';
import { classifyUserText } from './wrappers';


export const DOC_BUDGET = 512 * 1024;
export const HALF = DOC_BUDGET / 2;
export const TURN_CAP = 16 * 1024;
export const SUMMARY_CAP = 160;
const SUMMARY_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'description', 'url', 'prompt'];

const bytes = (s: string): number => Buffer.byteLength(s);
const firstLineOf = (s: string): string => s.split('\n').find((l) => l.trim())?.trim() ?? '';

export function systemTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
export function dayKey(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}
export function hhmm(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}
export function stamp(ms: number, tz: string): string {
  return `${dayKey(ms, tz)} ${hhmm(ms, tz)}`;
}
export function tildify(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}

export function cutBytes(s: string, cap: number, marker = '… (truncated)'): string {
  if (bytes(s) <= cap) return s;
  return Buffer.from(s).subarray(0, cap).toString('utf8').replace(/�$/, '') + '\n' + marker;
}

export function toolLine(name: string, input: unknown): string {
  let obj: unknown = input;
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object') obj = parsed;
    } catch {
      /* not JSON — raw text */
    }
  }
  let summary = '';
  if (obj && typeof obj === 'object') {
    for (const k of SUMMARY_KEYS) {
      const v = (obj as Record<string, unknown>)[k];
      const text = Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(' ') : v;
      if (typeof text === 'string' && text.trim()) {
        summary = text;
        break;
      }
    }
  } else if (typeof input === 'string') summary = input;
  // Redact before every cut: a cut secret no longer matches (finalize stays the guarantee).
  summary = redact(firstLineOf(summary)).slice(0, SUMMARY_CAP);
  return summary ? `→ ${name}: ${summary}` : `→ ${name}`;
}

export function makeTitle(...candidates: Array<string | undefined>): string {
  for (const c of candidates) {
    const line = c ? firstLineOf(c) : '';
    if (line) return redact(line).slice(0, 80);
  }
  return 'Session';
}

interface Turn {
  role: 'user' | 'assistant';
  at?: string;
  text: string;
  tools: string[];
}

export class TranscriptBuilder {
  private cur: Turn | null = null;
  private head: string[] = [];
  private headBytes = 0;
  private headFull = false;
  private tail: string[] = [];
  private tailBytes = 0;
  private omitted = 0;
  firstUserText?: string;

  constructor(private readonly tz: string) {}

  /** One user record: injected wrapper parts are dropped per part; no-op if nothing is left. */
  user(parts: string[], at?: string): void {
    const text = parts
      .map(classifyUserText)
      .flatMap((c) => (c.kind === 'keep' ? [c.text] : []))
      .join('\n\n');
    if (!text) return;
    this.flush();
    if (this.firstUserText === undefined) this.firstUserText = text;
    this.cur = { role: 'user', at, text, tools: [] };
  }

  assistant(parts: string[], at?: string): void {
    const text = parts.map((p) => p.trim()).filter(Boolean).join('\n\n');
    if (!text) return;
    const t = this.ensureAssistant(at);
    t.text += (t.text ? '\n\n' : '') + text;
  }

  tool(name: string, input: unknown, at?: string): void {
    this.ensureAssistant(at).tools.push(toolLine(name, input));
  }

  body(): string {
    this.flush();
    const parts = [...this.head];
    if (this.omitted > 0) parts.push(`_… ${this.omitted} turns omitted …_`);
    parts.push(...this.tail);
    return parts.join('\n\n');
  }

  private ensureAssistant(at?: string): Turn {
    if (this.cur?.role !== 'assistant') {
      this.flush();
      this.cur = { role: 'assistant', at, text: '', tools: [] };
    }
    return this.cur;
  }

  private flush(): void {
    if (!this.cur) return;
    const t = this.cur;
    this.cur = null;
    const when = t.at && !Number.isNaN(Date.parse(t.at)) ? ` — ${hhmm(Date.parse(t.at), this.tz)}` : '';
    const content = [t.text, ...t.tools].filter(Boolean).join('\n');
    this.push(cutBytes(redact(`## ${t.role === 'user' ? 'User' : 'Assistant'}${when}\n${content}`), TURN_CAP));
  }

  private push(s: string): void {
    const n = bytes(s);
    if (!this.headFull && this.headBytes + n <= HALF) {
      this.head.push(s);
      this.headBytes += n;
      return;
    }
    this.headFull = true;
    this.tail.push(s);
    this.tailBytes += n;
    while (this.tailBytes > HALF && this.tail.length > 1) {
      this.tailBytes -= bytes(this.tail.shift() as string);
      this.omitted += 1;
    }
  }
}

export interface SessionHeader {
  title: string;
  agentLabel: string;
  cliVersion?: string;
  cwd?: string;
  gitBranch?: string;
  startedAt?: string;
  resume: string;
}

export function renderSession(h: SessionHeader, body: string, tz: string): string {
  const line1 = [
    `Agent: ${h.agentLabel}${h.cliVersion ? ` ${h.cliVersion}` : ''}`,
    h.cwd ? `Project: ${tildify(h.cwd)}` : '',
    h.gitBranch ? `Branch: ${h.gitBranch}` : '',
  ].filter(Boolean).join(' · ');
  const started = h.startedAt && !Number.isNaN(Date.parse(h.startedAt)) ? `Started ${stamp(Date.parse(h.startedAt), tz)} · ` : '';
  return `# ${h.title}\n${line1}\n${started}Resume: \`${h.resume}\`\n\n${body}`;
}
