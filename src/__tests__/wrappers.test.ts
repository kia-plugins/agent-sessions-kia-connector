import { classifyUserText } from '../wrappers';

const drop = { kind: 'drop' };
it.each([
  'task-notification', 'system-reminder', 'local-command-caveat', 'local-command-stdout',
  'local-command-stderr', 'bash-stdout', 'bash-stderr', 'user-prompt-submit-hook',
  'environment_context', 'user_instructions', 'recommended_plugins', 'subagent_notification',
  'turn_aborted', 'guardian_tool_descriptions', 'guardian_context_omission',
  'realtime_delegation', 'external_codex_apps_writing_block_edits', 'skill',
])('wrappers.%s-dropped', (tag) => {
  expect(classifyUserText(`<${tag}>\nsome injected body\n</${tag}>`)).toEqual(drop);
});

it('wrappers.case-insensitive-INSTRUCTIONS', () => {
  expect(classifyUserText('<INSTRUCTIONS>do x</INSTRUCTIONS>')).toEqual(drop);
});

it('drops a sequence of allowlisted blocks and whitespace between them', () => {
  expect(classifyUserText('<environment_context>a</environment_context>\n\n<skill>b</skill>')).toEqual(drop);
});

it('wrappers.unknown-tag-kept and multi-block-user-xml-kept', () => {
  const t = '<task>Review X</task>\n<action_safety>careful</action_safety>';
  expect(classifyUserText(t)).toEqual({ kind: 'keep', text: t });
  expect(classifyUserText('<pasted_content>my notes</pasted_content>')).toEqual({
    kind: 'keep', text: '<pasted_content>my notes</pasted_content>',
  });
});

it('renders-slash-command (caveat + command-name/message/args set)', () => {
  const t =
    '<local-command-caveat>Caveat: …</local-command-caveat>\n<command-name>/model</command-name>\n' +
    '<command-message>model</command-message>\n<command-args>opus</command-args>';
  expect(classifyUserText(t)).toEqual({ kind: 'keep', text: '/model opus' });
});

it('renders-bash-input', () => {
  expect(classifyUserText('<bash-input>git status</bash-input>')).toEqual({ kind: 'keep', text: '! git status' });
});

it('drops interruptions and AGENTS.md preambles; keeps plain text', () => {
  expect(classifyUserText('[Request interrupted by user]')).toEqual(drop);
  expect(classifyUserText('# AGENTS.md instructions for /x\n...')).toEqual(drop);
  expect(classifyUserText('  fix the bug  ')).toEqual({ kind: 'keep', text: 'fix the bug' });
  expect(classifyUserText('   ')).toEqual(drop);
});
