import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import extension from './quota.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;

const HOUR = 3_600_000;
const MINUTE = 60_000;

let agentDir: string;
const realFetch = globalThis.fetch;
const realPath = process.env['PATH'];

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'pi-anthropic-sps-'));
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
      setStatus: (key: string, text: string | undefined) => {
        assert.equal(key, 'pi-anthropic-sps');
        statuses.push(text);
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
    emit: (event: string, eventCtx: unknown = ctx) => handlers.get(event)?.({}, eventCtx),
    stop: () => handlers.get('session_shutdown')?.({}, ctx),
  };
}

test('shows remaining Anthropic quota in the footer', async () => {
  await writeAuth({ access: 'token', refresh: 'r', expires: Date.now() + HOUR });
  mockFetch((url) =>
    url.endsWith('/api/oauth/usage')
      ? usage([7, HOUR + 29 * MINUTE + 30_000], [33, 85 * HOUR + 30 * MINUTE])
      : undefined,
  );

  const session = startSession();
  await waitFor(() => session.statuses.length > 0);
  session.stop();

  assert.equal(session.statuses.at(-1), '93% 1h29m · 67% 3d13h');
});

test('hides the status when the active model is not Anthropic', async () => {
  await writeAuth({ access: 'token', refresh: 'r', expires: Date.now() + HOUR });
  mockFetch(() => usage([7, HOUR], [33, 2 * HOUR]));

  const session = startSession('openai');
  await waitFor(() => session.statuses.length > 0);
  session.stop();

  assert.equal(session.statuses.at(-1), undefined);
});

test('shows the status again when switching to an Anthropic model', async () => {
  await writeAuth({ access: 'token', refresh: 'r', expires: Date.now() + HOUR });
  mockFetch(() => usage([50, 2 * HOUR + 30_000], [50, 3 * HOUR + 30_000]));

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
    return usage([0, HOUR], [0, 2 * HOUR]);
  });

  const session = startSession();
  await waitFor(() => session.statuses.length > 0);
  session.stop();

  const saved = JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf-8'));
  assert.equal(saved.anthropic.access, 'new');
  assert.equal(saved.anthropic.refresh, 'new-refresh');
  assert.deepEqual(usageAuth, ['Bearer new']);
  assert.deepEqual(session.notifications, ['pi-anthropic-sps: refreshed Anthropic auth']);
});

test('logs failed usage requests', async () => {
  await writeAuth({ access: 'token', refresh: 'r', expires: Date.now() + HOUR });
  mockFetch(() => undefined);

  const session = startSession();
  await waitFor(() => session.statuses.length > 0);
  session.stop();

  const log = await readFile(join(agentDir, 'pi-anthropic-sps.log'), 'utf-8');
  assert.match(log, /Anthropic usage request failed: 500/);
});

test('pings the active model when a quota window resets', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'pi-bin-'));
  const argsFile = join(binDir, 'args');
  await writeFile(join(binDir, 'pi'), `#!/bin/sh\necho "$@" > "${argsFile}"\n`);
  await chmod(join(binDir, 'pi'), 0o755);
  process.env['PATH'] = `${binDir}:${realPath}`;

  await writeAuth({ access: 'token', refresh: 'r', expires: Date.now() + HOUR });
  let poll = 0;
  mockFetch(() => {
    poll++;
    return poll === 1 ? usage([90, HOUR], [50, 2 * HOUR]) : usage([0, 6 * HOUR], [50, 2 * HOUR]);
  });
  mock.timers.enable({ apis: ['setTimeout'] });

  const session = startSession();
  await waitFor(() => session.statuses.length > 0);
  mock.timers.tick(10 * MINUTE);
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
