import type { DocumentInput } from '@kiagent/connector-sdk';
import { parseJson, str, UUID } from '../doc';

export function renderTasks(listId: string, taskJsons: string[], createdAtMs: number, sourcePath: string): DocumentInput {
  const tasks = taskJsons
    .map(parseJson)
    .filter((t): t is Record<string, any> => !!t && str(t.subject) !== undefined)
    .sort((x, y) => Number(x.id) - Number(y.id) || String(x.id).localeCompare(String(y.id)));
  const title = `Tasks — ${listId.slice(0, 8)}`;
  const lines = tasks.map((t) => {
    const desc = str(t.description);
    return `- [${t.status === 'completed' ? 'x' : ' '}] ${t.subject}${desc ? ` — ${desc}` : ''}`;
  });
  const session = UUID.test(listId);
  return {
    externalId: `tasks:${listId}`,
    type: 'agent.tasks',
    title,
    markdown: `# ${title}\n\n${lines.join('\n')}`,
    metadata: { agent: 'claude-code', sessionId: session ? listId : undefined, sourcePath },
    createdAt: new Date(createdAtMs).toISOString(),
    ...(session ? { parent: { externalId: `session:${listId}`, type: 'agent.session' } } : {}),
  };
}

export function renderPlan(name: string, text: string, mtimeMs: number, sourcePath: string): DocumentInput {
  const heading = /^# (.+)$/m.exec(text)?.[1]?.trim();
  return {
    externalId: `plan:${name}`,
    type: 'agent.plan',
    title: heading || name,
    markdown: text,
    metadata: { agent: 'claude-code', sourcePath },
    createdAt: new Date(mtimeMs).toISOString(),
  };
}
