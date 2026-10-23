import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import extension from './index.ts';

type Handler = (event: { payload: unknown }) => unknown;

function sendRequest(payload: unknown): unknown {
  let handler: Handler | undefined;
  const pi = {
    on: (_event: string, h: Handler) => {
      handler = h;
    },
  } as unknown as ExtensionAPI;
  extension(pi);
  return handler?.({ payload }) ?? payload;
}

test('leaves non-Claude requests unchanged', () => {
  const payload = { model: 'gpt-5', system: 'x' };
  assert.equal(sendRequest(payload), payload);
});

test('still strips known bad system prompt lines', () => {
  const result = sendRequest({
    model: 'claude-sonnet-4-5',
    system: 'keep\n- When asked about: extensions (docs/extensions.md, examples/extensions/) x',
  }) as { system: string };
  assert.equal(result.system, 'keep');
});
