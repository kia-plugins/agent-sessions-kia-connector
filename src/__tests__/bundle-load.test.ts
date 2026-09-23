import { join } from 'node:path';
import { bundleLoadSmoke } from '@kiagent/connector-sdk/testing';

describe('dist bundle loads standalone', () => {
  it('bundleLoadSmoke: activate() returns claude-code then codex', async () => {
    await bundleLoadSmoke({
      root: join(__dirname, '..', '..'),
      selfId: 'kia.agent-sessions',
      sourceIds: ['claude-code', 'codex'],
      host: { self: { id: 'kia.agent-sessions' }, files: { roots: async () => [] } },
    });
  }, 60_000);
});
