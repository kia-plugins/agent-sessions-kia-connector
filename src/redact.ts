const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

const TOKENS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
];

const KEY = String.raw`[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*`;
const ASSIGN = new RegExp(
  String.raw`(["']?)(${KEY})\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\])]+)`,
  'gi',
);

function looksSecret(value: string): boolean {
  const raw = value.replace(/^["']|["']$/g, '');
  return raw.length >= 12 && /[A-Za-z]/.test(raw) && /\d/.test(raw) && raw !== '[redacted]';
}

/** Safety net, not DLP (spec §4.7). Applied before any truncation. */
export function redact(s: string): string {
  let out = s.replace(PEM, '[redacted private key]');
  for (const re of TOKENS) out = out.replace(re, '[redacted]');
  return out.replace(ASSIGN, (m, q: string, key: string, sep: string, val: string) => {
    if (!looksSecret(val)) return m;
    const masked = val.startsWith('"') ? '"[redacted]"' : val.startsWith("'") ? "'[redacted]'" : '[redacted]';
    return `${q}${key}${q}${sep}${masked}`;
  });
}
