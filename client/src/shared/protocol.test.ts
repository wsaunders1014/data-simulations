import  { test, expect } from 'vitest';
import { isEnvelope } from './protocol';
import type { Envelope } from './protocol';
function validEnvelope(): Envelope {
  return { type: 'data', stream: 'metrics', seq: 1234, ts: 1761750000000, t: 123.4, data: {} };
}
test('Envelope is the right shape',()=>{
    const msg = validEnvelope();
    expect(isEnvelope(msg)).toBe(true);
});

//check for type mismatches
test.each([
  ['seq', '1234'],
  ['ts', '1761750000000'],
  ['t','123.4'],
  ['type', 4],
  ['stream', 42]
])('rejects a message whose %s is the wrong type', (key, badValue) => {
  const x = {...validEnvelope(), [key]:badValue}
  expect(isEnvelope(x)).toBe(false);
});
//check for missing keys
const REQUIRED_KEYS: readonly (keyof Envelope)[] = ['type', 'stream', 'seq', 'ts', 't', 'data'];

test.each(REQUIRED_KEYS)('rejects a message missing %s', (key) => {
  const { [key]: _removed, ...rest } = validEnvelope();
  expect(isEnvelope(rest)).toBe(false);
});
