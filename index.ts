import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import quota from './quota.ts';
import { sanitizeSystem, type AnthropicSystem } from './sanitize-system.ts';
import { webFetchTool } from './web-fetch.ts';
import { webSearchTool } from './web-search.ts';

type AnthropicTool = { name: string; type?: string };

type AnthropicPayload = {
  model?: string;
  system?: AnthropicSystem;
  tools?: AnthropicTool[];
};

const webTools: AnthropicTool[] = [webSearchTool, webFetchTool];

function addWebTools(tools: AnthropicTool[] = []): AnthropicTool[] {
  const names = new Set(tools.map((tool) => tool.name));
  return [...tools, ...webTools.filter((tool) => !names.has(tool.name))];
}

export default function (pi: ExtensionAPI) {
  quota(pi);
  pi.on('before_provider_request', (event, ctx) => {
    if (ctx.model?.api !== 'anthropic-messages') return;
    const payload = event.payload as AnthropicPayload;
    if (!payload || typeof payload !== 'object') return;
    if (typeof payload.model !== 'string') return;
    if (!payload.model.startsWith('claude-')) return;

    return {
      ...payload,
      ...(payload.system === undefined ? {} : { system: sanitizeSystem(payload.system) }),
      tools: addWebTools(payload.tools),
    };
  });
}
