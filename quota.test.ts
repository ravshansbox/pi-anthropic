import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text, type Component } from '@earendil-works/pi-tui';
import extension from './index.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;

const hour = 3_600_000;
const minute = 60_000;

let agentDir: string;
const realFetch = globalThis.fetch;
const realPath = process.env['PATH'];

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'pi-anthropic-'));
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env['PATH'] = realPath;
  delete process.env['PI_CODING_AGENT_DIR'];
  mock.timers.reset();
});

async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out');
}

async function settle(ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
}

function usage(fiveHour: [number, number], sevenDay: [number, number]) {
  return {
    five_hour: {
      utilization: fiveHour[0],
      resets_at: new Date(Date.now() + fiveHour[1]).toISOString(),
    },
    seven_day: {
      utilization: sevenDay[0],
      resets_at: new Date(Date.now() + sevenDay[1]).toISOString(),
    },
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const body = handler(url, init);
    if (body === undefined) return new Response('', { status: 500 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return calls;
}

async function writeAuth(record: Record<string, unknown>) {
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ anthropic: record }));
}

function startSession(provider = 'anthropic') {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  extension(pi);

  const statuses: (string | undefined)[] = [];
  const notifications: string[] = [];
  const ctx = {
    cwd: agentDir,
    model: { provider, id: 'claude-sonnet-4-5' },
    ui: {
      setWidget: (
        key: string,
        content: string[] | (() => Component) | undefined,
        options?: { placement?: string },
      ) => {
        assert.equal(key, 'pi-anthropic');
        assert.equal(options?.placement, 'belowEditor');
        if (content === undefined) return statuses.push(undefined);
        const components = Array.isArray(content)
          ? content.map((line) => new Text(line, 1, 0))
          : [content()];
        statuses.push(
          components
            .flatMap((c) => c.render(80))
            .map((line) => line.trimEnd())
            .join('\n'),
        );
      },
      notify: (message: string) => notifications.push(message),
      theme: { fg: (_colour: string, text: string) => text },
    },
  };
  handlers.get('session_start')?.({}, ctx);

  return {
    statuses,
    notifications,
    ctx,
    emit: (event: string, eventCtx: unknown = ctx, payload: unknown = {}) =>
      handlers.get(event)?.(payload, eventCtx),
    stop: () => handlers.get('session_shutdown')?.({}, ctx),
  };
}

test('shows remaining Anthropic quota below the editor', async () => {
  await writeAuth({ access: 'token', refresh: 'r', expires: Date.now() + hour });
  mockFetch((url) =>
    url.endsWith('/api/oauth/usage')
      ? usage([7, hour + 29 * minute + 30_000], [33, 85 * hour + 30 * minute])
      : undefined,
  );

  const session = startSession();
  await waitFor(() => session.statuses.length > 0);
  session.stop();

  assert.equal(session.statuses.at(-1), '93% 1h29m · 67% 3d13h');
});

test('hides the status when the active model is not Anthropic', async () => {
  await writeAuth({ access: 'token', refresh: 'r', expires: Date.now() + hour });
  mockFetch(() => usage([7, hour], [33, 2 * hour]));

  const session = startSession('openai');
  await waitFor(() => session.statuses.length > 0);
  session.stop();

  assert.equal(session.statuses.at(-1), undefined);
});

test('shows the status again when switching to an Anthropic model', async () => {
  await writeAuth({ access: 'token', refresh: 'r', expires: Date.now() + hour });
  mockFetch(() => usage([50, 2 * hour + 30_000], [50, 3 * hour + 30_000]));

  const session = startSession('openai');
  await waitFor(() => session.statuses.length > 0);
  session.emit('model_select', {
    ...session.ctx,
    model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
  });
  session.stop();

  assert.equal(session.statuses.at(-1), '50% 2h0m · 50% 3h0m');
});

test('refreshes an expired Anthropic token and saves it', async () => {
  await writeAuth({ access: 'old', refresh: 'old-refresh', expires: Date.now() - 1 });
  const usageAuth: (string | null)[] = [];
  mockFetch((url, init) => {
    if (url.endsWith('/v1/oauth/token')) {
      return { access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600 };
    }
    usageAuth.push(new Headers(init?.headers).get('Authorization'));
    return usage([0, hour], [0, 2 * hour]);
  });

  const session = startSession();
  await waitFor(() => session.statuses.length > 0);
  session.stop();

  const saved = JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf-8'));
  assert.equal(saved.anthropic.access, 'new');
  assert.equal(saved.anthropic.refresh, 'new-refresh');
  assert.deepEqual(usageAuth, ['Bearer new']);
  assert.deepEqual(session.notifications, ['pi-anthropic: refreshed Anthropic auth']);
});

test('logs failed usage requests', async () => {
  await writeAuth({ access: 'token', refresh: 'r', expires: Date.now() + hour });
  mockFetch(() => undefined);

  const session = startSession();
  await waitFor(() => session.statuses.length > 0);
  session.stop();

  const log = await readFile(join(agentDir, 'pi-anthropic.log'), 'utf-8');
  assert.match(log, /Anthropic usage request failed: 500/);
});

test('updates the quota from Anthropic response headers', async () => {
  await writeAuth({ access: 'token', refresh: 'r', expires: Date.now() + hour });
  mockFetch(() => usage([7, hour], [33, 2 * hour]));

  const session = startSession();
  await waitFor(() => session.statuses.length > 0);
  const seconds = (ms: number) => String(Math.floor((Date.now() + ms) / 1000));
  session.emit('after_provider_response', session.ctx, {
    type: 'after_provider_response',
    status: 200,
    headers: {
      'anthropic-ratelimit-unified-5h-utilization': '0.25',
      'anthropic-ratelimit-unified-5h-reset': seconds(2 * hour + minute),
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
      'anthropic-ratelimit-unified-7d-reset': seconds(26 * hour + minute),
    },
  });
  session.stop();

  assert.equal(session.statuses.at(-1), '75% 2h0m · 60% 1d2h');
});

test('calls the usage endpoint only at session start', async () => {
  await writeAuth({ access: 'token', refresh: 'r', expires: Date.now() + hour });
  const calls = mockFetch(() => usage([7, 6 * hour], [33, 48 * hour]));
  mock.timers.enable({ apis: ['setTimeout'] });

  const session = startSession();
  await waitFor(() => session.statuses.length > 0);
  mock.timers.tick(30 * minute);
  await settle(200);
  session.stop();

  assert.equal(calls.filter((url) => url.endsWith('/api/oauth/usage')).length, 1);
});

test('pings the active model when a quota window resets', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'pi-bin-'));
  const argsFile = join(binDir, 'args');
  await writeFile(join(binDir, 'pi'), `#!/bin/sh\necho "$@" > "${argsFile}"\n`);
  await chmod(join(binDir, 'pi'), 0o755);
  process.env['PATH'] = `${binDir}:${realPath}`;

  await writeAuth({ access: 'token', refresh: 'r', expires: Date.now() + hour });
  mockFetch(() => usage([90, hour], [50, 2 * hour]));
  mock.timers.enable({ apis: ['setTimeout'] });

  const session = startSession();
  await waitFor(() => session.statuses.length > 0);
  mock.timers.tick(hour);
  await waitFor(async () => {
    try {
      return (await readFile(argsFile, 'utf-8')).length > 0;
    } catch {
      return false;
    }
  });
  session.stop();

  const args = await readFile(argsFile, 'utf-8');
  assert.match(args, /--provider anthropic --model claude-sonnet-4-5 -p hi/);
});
