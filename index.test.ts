import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import extension from './index.ts';

type Handler = (event: { payload: unknown }, ctx: { model?: { api: string } }) => unknown;

function sendRequest(payload: unknown, api = 'anthropic-messages'): unknown {
  let handler: Handler | undefined;
  const pi = {
    on: (event: string, h: Handler) => {
      if (event === 'before_provider_request') handler = h;
    },
  } as unknown as ExtensionAPI;
  extension(pi);
  return handler?.({ payload }, { model: { api } }) ?? payload;
}

const webTools = [
  { type: 'web_search_20250305', name: 'web_search' },
  { type: 'web_fetch_20250910', name: 'web_fetch' },
];

test('adds Anthropic web tools to Claude requests', () => {
  const result = sendRequest({
    model: 'claude-sonnet-4-5',
    tools: [{ name: 'read', input_schema: {} }],
  });
  assert.deepEqual(result, {
    model: 'claude-sonnet-4-5',
    tools: [{ name: 'read', input_schema: {} }, ...webTools],
  });
});

test('adds Anthropic web tools when the request has no tools', () => {
  const result = sendRequest({ model: 'claude-sonnet-4-5' });
  assert.deepEqual(result, { model: 'claude-sonnet-4-5', tools: webTools });
});

test('does not add a web tool whose name is already taken', () => {
  const result = sendRequest({
    model: 'claude-sonnet-4-5',
    tools: [{ name: 'web_search', input_schema: {} }],
  });
  assert.deepEqual(result, {
    model: 'claude-sonnet-4-5',
    tools: [{ name: 'web_search', input_schema: {} }, webTools[1]],
  });
});

test('leaves non-Claude requests unchanged', () => {
  const payload = { model: 'gpt-5', tools: [] };
  assert.equal(sendRequest(payload), payload);
});

test('leaves Claude requests to other APIs unchanged', () => {
  const payload = { model: 'claude-sonnet-5', context: {}, options: {} };
  assert.equal(sendRequest(payload, 'pi-messages'), payload);
});

test('still strips known bad system prompt lines', () => {
  const result = sendRequest({
    model: 'claude-sonnet-4-5',
    system: 'keep\n- When asked about: extensions (docs/extensions.md, examples/extensions/) x',
  }) as { system: string };
  assert.equal(result.system, 'keep');
});
