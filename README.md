# Agent Sessions — KIAgent connector

Indexes your local Claude Code and Codex history into KIA, so past agent work is searchable next to your mail, docs and files.

## What is indexed

Two sources, one per agent, each added separately in KIA:

| Document | Claude Code (`~/.claude`) | Codex (`~/.codex`) |
|---|---|---|
| **Session** — one per conversation: your prompts, the agent's replies, one line per tool call, and a `Resume:` command | `projects/*/*.jsonl` | `sessions/**`, `archived_sessions/` |
| **Subagent session** — linked to its parent session | `projects/*/<session>/subagents/` | threads with a parent thread |
| **Plan** | `plans/*.md` | — |
| **Tasks** — checklist, linked to its session | `tasks/<list>/` | — |
| **Memory** | `CLAUDE.md`, `projects/*/memory/` | `AGENTS.md`, `memories/` |
| **Prompts** — one document per day | `history.jsonl` | `history.jsonl` |

Long sessions keep their beginning and end (up to 512 KiB per document) and note how many turns were left out in between.

**Not indexed:** tool outputs, thinking/reasoning, attachments, injected context (system reminders, environment blocks, `AGENTS.md` preambles), and costs or token counts.

History stays in KIA after Claude Code's 30-day cleanup deletes the original files.

## Privacy

- On install, KIA asks for **read-only** access to `~/.claude` and `~/.codex`. The connector never writes to either folder.
- Common secrets (API keys, tokens, private keys, `password=`-style assignments) are masked before anything is stored. This is a safety net, not data-loss prevention: a secret that matches no pattern **is** indexed.
- The connector reads local files only and makes no network requests.

## Notes

- A folder is granted when KIA starts. If you run Claude Code or Codex for the first time after KIA is already running, restart KIA, then add the source.
- Sources sync every 15 minutes. Only changed files are re-read.

## Development

```bash
npm test                  # unit + fixture + bundle smoke
npm run typecheck
npm run build             # dist/index.js
node scripts/bench.mjs    # backfill + unchanged tick against your real ~/.claude and ~/.codex (reads only)
node scripts/capture-fixture.mjs <claude|codex> <src.jsonl> <dest.jsonl>   # scrubbed real-format fixture
```

Fixtures in `test/fixtures/` are scrubbed captures: every free-text string is replaced, and dropped content becomes `DROPPED-SENTINEL`. Read a new fixture by hand before committing it.
