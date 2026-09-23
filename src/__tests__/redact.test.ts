import { redact } from '../redact';

const R = '[redacted]';
it.each([
  ['sk-ant-api03-AbCdEfGhIjKlMnOp1234', `${R}`],
  ['key sk-proj-ABCDEFGHIJKLMNOPQRST1234 end', `key ${R} end`],
  ['ghp_ABCDEFGHIJKLMNOPQRSTuvwx1234', R],
  ['github_pat_11ABCDEFG0123456789_abcdefghij', R],
  ['xoxb-1234567890-abcdefghij', R],
  ['AKIAIOSFODNN7EXAMPLE', R],
  ['AIzaSyA-abcdefghijklmnopqrstuvwxyz01234', R],
  ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', R],
  ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', `Authorization: ${R}`],
])('redact.token %p', (input, expected) => {
  expect(redact(input)).toBe(expected);
});

it('redact.unterminated-pem', () => {
  expect(redact('x\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nstill key')).toBe('x\n[redacted private key]');
  expect(redact('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\nafter')).toBe('[redacted private key]\nafter');
});

it('redact.unterminated-pem stops at the next blank line', () => {
  expect(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n\n## Next turn')).toBe('[redacted private key]\n\n## Next turn');
});

it('redact.quoted-json-key', () => {
  expect(redact('{"password": "hunter2hunter2x"}')).toBe('{"password": "[redacted]"}');
  expect(redact("{'api_key': 'abc123def456ghi'}")).toBe("{'api_key': '[redacted]'}");
});

it('redact.quoted-value-with-spaces', () => {
  expect(redact('DB_PASSWORD="correct horse battery 9"')).toBe('DB_PASSWORD="[redacted]"');
});

it('redact.bare assignment', () => {
  expect(redact('export GITHUB_TOKEN=abc123def456ghi789')).toBe('export GITHUB_TOKEN=[redacted]');
});

it('redact.leaves-type-annotations and prose', () => {
  for (const s of [
    'token: string',
    'password: z.string().min(8)',
    'const apiKey = getKey();',
    'the secret: we ship on Friday',
    'tokenCount = 42',
    'token: CancellationToken',
  ])
    expect(redact(s)).toBe(s);
});

it('is idempotent', () => {
  const once = redact('password="hunter2hunter2x" sk-ant-api03-AbCdEfGhIjKlMnOp1234');
  expect(redact(once)).toBe(once);
});
