const DROP = new Set(
  [
    // Claude Code
    'task-notification', 'system-reminder', 'local-command-caveat', 'local-command-stdout',
    'local-command-stderr', 'bash-stdout', 'bash-stderr', 'user-prompt-submit-hook',
    // Codex
    'environment_context', 'user_instructions', 'recommended_plugins', 'subagent_notification',
    'turn_aborted', 'instructions', 'guardian_tool_descriptions', 'guardian_context_omission',
    'realtime_delegation', 'external_codex_apps_writing_block_edits', 'skill',
  ].map((t) => t.toLowerCase()),
);
const COMMAND = new Set(['command-name', 'command-message', 'command-args']);
const BLOCK = /<([A-Za-z][A-Za-z0-9_-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/y;

export type Classified = { kind: 'keep'; text: string } | { kind: 'drop' };

/** Explicit allowlist, fail-open: unknown tags and user-authored XML are kept. */
export function classifyUserText(raw: string): Classified {
  const text = raw.trim();
  if (!text) return { kind: 'drop' };
  if (text.startsWith('[Request interrupted') || text.startsWith('# AGENTS.md instructions'))
    return { kind: 'drop' };
  if (!text.startsWith('<')) return { kind: 'keep', text };
  const blocks: Array<{ tag: string; body: string }> = [];
  let pos = 0;
  while (pos < text.length) {
    while (pos < text.length && /\s/.test(text[pos])) pos += 1;
    if (pos >= text.length) break;
    BLOCK.lastIndex = pos;
    const m = BLOCK.exec(text);
    if (!m) return { kind: 'keep', text };
    blocks.push({ tag: m[1].toLowerCase(), body: m[2].trim() });
    pos = BLOCK.lastIndex;
  }
  const tags = blocks.map((b) => b.tag);
  const body = (tag: string) => blocks.find((b) => b.tag === tag)?.body ?? '';
  if (tags.includes('command-name') && tags.every((t) => COMMAND.has(t) || DROP.has(t))) {
    const name = body('command-name');
    const cmd = name.startsWith('/') ? name : `/${name}`;
    const args = body('command-args');
    return { kind: 'keep', text: args ? `${cmd} ${args}` : cmd };
  }
  if (tags.includes('bash-input') && tags.every((t) => t === 'bash-input' || DROP.has(t)))
    return { kind: 'keep', text: `! ${body('bash-input')}` };
  if (tags.every((t) => DROP.has(t))) return { kind: 'drop' };
  return { kind: 'keep', text };
}
