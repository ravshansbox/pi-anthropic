import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { sanitizeSystem, type AnthropicSystem } from './sanitize-system.ts';
import { WEB_FETCH_TOOL } from './web-fetch.ts';
import { WEB_SEARCH_TOOL } from './web-search.ts';

type AnthropicTool = { name: string; type?: string };

type AnthropicPayload = {
  model?: string;
  system?: AnthropicSystem;
  tools?: AnthropicTool[];
};

const WEB_TOOLS: AnthropicTool[] = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL];

function addWebTools(tools: AnthropicTool[] = []): AnthropicTool[] {
  const names = new Set(tools.map((tool) => tool.name));
  return [...tools, ...WEB_TOOLS.filter((tool) => !names.has(tool.name))];
}

export default function (pi: ExtensionAPI) {
  pi.on('before_provider_request', (event) => {
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
