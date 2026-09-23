import fs from 'node:fs';
import path from 'node:path';
import { parseClaudeSession } from '../claude/session';
import { parseCodexSession } from '../codex/session';

const FIX = path.join(__dirname, '..', '..', 'test', 'fixtures');
async function* lines(file: string) {
  for (const l of fs.readFileSync(path.join(FIX, file), 'utf8').split('\n')) if (l) yield l;
}
const cases: Array<[string, (l: AsyncIterable<string>, tz: string) => Promise<{ body: string }>]> = [
  ['claude-main.jsonl', parseClaudeSession],
  ['claude-subagent.jsonl', parseClaudeSession],
  ['codex-current.jsonl', parseCodexSession],
  ['codex-subagent.jsonl', parseCodexSession],
  ['codex-legacy.jsonl', parseCodexSession],
];

it.each(cases)('%s: real-format capture drops every DROPPED-SENTINEL and keeps real turns', async (file, parse) => {
  expect(fs.statSync(path.join(FIX, file)).size).toBeLessThanOrEqual(50_000);
  const { body } = await parse(lines(file), 'UTC');
  expect(body).not.toContain('DROPPED-SENTINEL');
  expect(body).not.toMatch(/<(system-reminder|environment_context|local-command-caveat|INSTRUCTIONS)>/i);
  expect(body).toMatch(/## User/);
  expect(body).toMatch(/text \d+/);
});

it('the Codex subagent capture names its parent', () => {
  const first = JSON.parse(fs.readFileSync(path.join(FIX, 'codex-subagent.jsonl'), 'utf8').split('\n')[0]);
  expect(first.payload.parent_thread_id ?? first.payload.source?.subagent?.thread_spawn?.parent_thread_id).toBeTruthy();
});
