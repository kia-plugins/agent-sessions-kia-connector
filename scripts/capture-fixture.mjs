#!/usr/bin/env node
// Usage: node scripts/capture-fixture.mjs <agent: claude|codex> <src.jsonl> <dest.jsonl> [maxBytes=50000]
// Keeps whole records up to maxBytes. Every free-text string becomes `text <n>`,
// except strings the spec says to DROP, which become DROPPED-SENTINEL, and XML
// tag skeletons, which keep their tag names so the wrapper filter is exercised.
import fs from 'node:fs';

const [agent, src, dest, max = '50000'] = process.argv.slice(2);
if (!['claude', 'codex'].includes(agent) || !src || !dest) {
  console.error('usage: capture-fixture.mjs <claude|codex> <src> <dest> [maxBytes]');
  process.exit(2);
}
const KEEP = new Set(['type', 'role', 'name', 'status', 'subtype', 'record_type', 'timestamp', 'version', 'cli_version',
  'isMeta', 'isSidechain', 'isCompactSummary', 'id', 'sessionId', 'session_id', 'parent_thread_id', 'model', 'uuid', 'parentUuid']);
const DROP_PARTS = new Set(['thinking', 'redacted_thinking', 'tool_result', 'reasoning', 'function_call_output',
  'custom_tool_call_output', 'server_tool_use', 'web_search_tool_result']);
let n = 0;
const text = (s) => {
  const t = s.trimStart();
  if (t.startsWith('<')) return s.replace(/>([^<]+)</g, (m, inner) => (inner.trim() ? '>x<' : m));
  if (t.startsWith('# AGENTS.md instructions')) return '# AGENTS.md instructions for /Users/test\n\nx';
  return `text ${++n}`;
};
const scrub = (v, key, drop) => {
  if (typeof v === 'string') {
    // `name` is kept only as a tool name; a file name (has a dot) is real content.
    if (KEEP.has(key) && !(key === 'name' && v.includes('.'))) return v.replace(/\/Users\/[^/"]+/g, '/Users/test');
    return drop ? 'DROPPED-SENTINEL' : text(v);
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, key, drop));
  if (v && typeof v === 'object') {
    const d = drop || DROP_PARTS.has(v.type) || v.isMeta === true || v.isCompactSummary === true ||
      v.role === 'developer' || ['attachment', 'system', 'file-history-snapshot', 'queue-operation'].includes(v.type);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'base_instructions' ? 'DROPPED-SENTINEL' : scrub(x, k, d)]));
  }
  return v;
};
const out = [];
let bytes = 0;
for (const line of fs.readFileSync(src, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let rec;
  try { rec = JSON.parse(line); } catch { continue; }
  const s = JSON.stringify(scrub(rec, '', false));
  if (bytes + s.length + 1 > Number(max)) break;
  out.push(s);
  bytes += s.length + 1;
}
fs.writeFileSync(dest, out.join('\n') + '\n');
console.log(`${agent}: ${out.length} records, ${bytes} bytes → ${dest}`);
