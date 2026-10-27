import { spawn } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';

interface QuotaState {
  fiveHourUsed: number | null;
  fiveHourReset: Date | null;
  sevenDayUsed: number | null;
  sevenDayReset: Date | null;
}

type OAuthAuthRecord = {
  access?: string | undefined;
  refresh?: string | undefined;
  expires?: number | undefined;
};

type AuthFile = Record<string, OAuthAuthRecord>;

type OAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

type UsageWindow = { utilization?: number; resets_at?: string };

type UsageResponse = {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
};

const extensionName = 'pi-anthropic';
const provider = 'anthropic';
const requestTimeoutMs = 30_000;

function nextMarkAfter(time: Date): Date {
  const next = new Date(time.getTime());
  next.setSeconds(0, 0);
  const minute = next.getMinutes();
  next.setMinutes(minute + 10 - (minute % 10));
  return next;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function formatResetTime(reset: Date): string {
  const diff = reset.getTime() - Date.now();
  if (diff <= 0) return 'now';

  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);

  if (days === 1) return `${days}d${hours}h`;
  if (days > 1) return `${Math.round(diff / 86400000)}d`;
  if (hours === 1) return `${hours}h${minutes}m`;
  if (hours > 1) return `${Math.round(diff / 3600000)}h`;
  if (minutes > 0) return `${minutes}m`;
  return 'now';
}

function authPath() {
  return join(getAgentDir(), 'auth.json');
}

async function loadAuth(): Promise<AuthFile | null> {
  try {
    return JSON.parse(await readFile(authPath(), 'utf-8')) as AuthFile;
  } catch {
    return null;
  }
}

async function persistAuthRecord(record: OAuthAuthRecord): Promise<void> {
  const current = (await loadAuth()) ?? {};
  current[provider] = record;
  await writeFile(authPath(), JSON.stringify(current, null, 2));
}

async function logError(message: string, error?: unknown): Promise<void> {
  const detail =
    error instanceof Error
      ? (error.stack ?? error.message)
      : error !== undefined
        ? String(error)
        : '';
  const line = `[${new Date().toISOString()}] ${message}${detail ? ` ${detail}` : ''}\n`;
  try {
    await appendFile(join(getAgentDir(), `${extensionName}.log`), line);
  } catch (error) {
    console.error(`${extensionName}: could not write log:`, error);
  }
}

function parseWindow(window: UsageWindow | undefined) {
  return {
    used: window ? clampPercent(window.utilization ?? 0) : null,
    reset: window?.resets_at ? new Date(window.resets_at) : null,
  };
}

function parseHeaderWindow(headers: Record<string, string>, name: string) {
  const utilization = headers[`anthropic-ratelimit-unified-${name}-utilization`];
  const reset = headers[`anthropic-ratelimit-unified-${name}-reset`];
  return {
    used: utilization === undefined ? null : clampPercent(Number(utilization) * 100),
    reset: reset === undefined ? null : new Date(Number(reset) * 1000),
  };
}

function parseHeaders(headers: Record<string, string>): QuotaState | null {
  const fiveHour = parseHeaderWindow(headers, '5h');
  const sevenDay = parseHeaderWindow(headers, '7d');
  if (fiveHour.used === null && sevenDay.used === null) return null;
  return {
    fiveHourUsed: fiveHour.used,
    fiveHourReset: fiveHour.reset,
    sevenDayUsed: sevenDay.used,
    sevenDayReset: sevenDay.reset,
  };
}

export default function (pi: ExtensionAPI) {
  let state: QuotaState | null = null;
  let refreshNotified = false;
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  let ctxRef: ExtensionContext | null = null;

  function buildStatusText(): string | undefined {
    if (ctxRef?.model?.provider !== provider || !state) return undefined;

    const parts: string[] = [];
    if (state.fiveHourUsed !== null) {
      const resetStr = state.fiveHourReset ? formatResetTime(state.fiveHourReset) : '?';
      parts.push(`${state.fiveHourUsed}% ${resetStr}`);
    }
    if (state.sevenDayUsed !== null) {
      const resetStr = state.sevenDayReset ? formatResetTime(state.sevenDayReset) : '?';
      parts.push(`${state.sevenDayUsed}% ${resetStr}`);
    }
    return parts.length > 0 ? parts.join(' · ') : undefined;
  }

  function updateStatus() {
    if (ctxRef?.mode !== 'tui') return;
    const text = buildStatusText();
    const line = text === undefined ? undefined : ctxRef.ui.theme.fg('dim', text);
    ctxRef.ui.setStatus(extensionName, line);
  }

  function pingOnReset() {
    const ctx = ctxRef;
    if (!ctx) return;
    if (ctx.model?.provider !== provider) {
      void pollQuotaStatus();
      return;
    }

    const child = spawn(
      'pi',
      [
        '--no-session',
        '--no-extensions',
        '--no-context-files',
        '--no-tools',
        '--provider',
        ctx.model.provider,
        '--model',
        ctx.model.id,
        '-p',
        'hi',
      ],
      { cwd: ctx.cwd, stdio: 'ignore' },
    );

    child.on('error', (error: unknown) => {
      void logError('Reset ping failed:', error);
    });
    child.on('exit', () => {
      if (ctxRef) void pollQuotaStatus();
    });

    child.unref();
  }

  function schedulePing(after = Date.now()) {
    if (pingTimer) clearTimeout(pingTimer);
    pingTimer = null;
    const resets = [state?.fiveHourReset, state?.sevenDayReset]
      .map((reset) => reset?.getTime())
      .filter((time): time is number => time !== undefined && time > after);
    if (resets.length === 0) return;
    const next = Math.min(...resets);
    pingTimer = setTimeout(() => {
      pingOnReset();
      schedulePing(next);
    }, next - Date.now());
  }

  function updateState(next: QuotaState) {
    if (!ctxRef) return;
    state = next;
    schedulePing();
    updateStatus();
  }

  async function ensureAccess(auth: AuthFile): Promise<OAuthAuthRecord | undefined> {
    const record = auth[provider];
    if (!record?.refresh) return record;
    if (record.expires && record.expires > Date.now() + 60_000 && record.access) return record;

    const response = await fetch('https://api.anthropic.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: record.refresh,
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });

    if (!response.ok) {
      await logError(`Anthropic token refresh failed: ${response.status}`);
      return record;
    }

    const data = (await response.json()) as OAuthTokenResponse;
    const refreshed: OAuthAuthRecord = {
      ...record,
      access: data.access_token ?? record.access,
      refresh: data.refresh_token ?? record.refresh,
      expires: data.expires_in ? Date.now() + data.expires_in * 1000 : record.expires,
    };
    await persistAuthRecord(refreshed);
    if (!refreshNotified) {
      refreshNotified = true;
      ctxRef?.ui.notify(`${extensionName}: refreshed Anthropic auth`, 'info');
    }
    return refreshed;
  }

  async function pollQuotaStatus() {
    try {
      const auth = await loadAuth();
      if (!auth) return;

      const record = await ensureAccess(auth);
      if (!record?.access) return;

      const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          Authorization: `Bearer ${record.access}`,
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });

      if (!response.ok) {
        await logError(`Anthropic usage request failed: ${response.status}`);
        return;
      }

      const data = (await response.json()) as UsageResponse;
      const fiveHour = parseWindow(data.five_hour);
      const sevenDay = parseWindow(data.seven_day);
      updateState({
        fiveHourUsed: fiveHour.used,
        fiveHourReset: fiveHour.reset,
        sevenDayUsed: sevenDay.used,
        sevenDayReset: sevenDay.reset,
      });
    } catch (error) {
      await logError('Poll error:', error);
    }
  }

  function stopTimers() {
    if (checkTimer) clearTimeout(checkTimer);
    if (pingTimer) clearTimeout(pingTimer);
    checkTimer = null;
    pingTimer = null;
  }

  function scheduleCheck() {
    const delay = Math.max(0, nextMarkAfter(new Date()).getTime() - Date.now());
    checkTimer = setTimeout(() => {
      updateStatus();
      scheduleCheck();
    }, delay);
  }

  pi.on('session_start', (_event, ctx) => {
    stopTimers();
    state = null;
    refreshNotified = false;
    ctxRef = ctx;

    void pollQuotaStatus().then(updateStatus);
    scheduleCheck();
  });

  pi.on('after_provider_response', (event, ctx) => {
    if (ctx.model?.provider !== provider) return;
    const next = parseHeaders(event.headers);
    if (!next) return;
    ctxRef = ctx;
    updateState(next);
  });

  pi.on('model_select', (_event, ctx) => {
    ctxRef = ctx;
    updateStatus();
  });

  pi.on('session_shutdown', () => {
    stopTimers();
    ctxRef = null;
  });
}
