import type { ExtensionModule } from '@kiagent/connector-sdk';
import { claudeSource } from './claude/source';
import { codexSource } from './codex/source';

const mod = {
  async activate(host) {
    return { sources: [claudeSource(host.files), codexSource(host.files)] };
  },
} satisfies ExtensionModule<'files'>;

export default mod;
module.exports = mod;
