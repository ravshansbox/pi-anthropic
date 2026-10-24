import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { WEB_FETCH_TOOL } from './web-fetch.ts';
import { WEB_SEARCH_TOOL } from './web-search.ts';

type AnthropicSystemBlock = {
  type: string;
  text?: string;
  cache_control?: { type: 'ephemeral'; ttl?: '1h' | '5m' };
};

type AnthropicTool = { name: string; type?: string };

type AnthropicPayload = {
  model?: string;
  system?: AnthropicSystemBlock[] | string;
  tools?: AnthropicTool[];
};

const WEB_TOOLS: AnthropicTool[] = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL];

function addWebTools(tools: AnthropicTool[] = []): AnthropicTool[] {
  const names = new Set(tools.map((tool) => tool.name));
  return [...tools, ...WEB_TOOLS.filter((tool) => !names.has(tool.name))];
}

const BAD_LINE_PREFIXES = [
  '- When asked about: extensions (docs/extensions.md, examples/extensions/)',
  '- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing',
];

function isBadLine(line: string): boolean {
  return BAD_LINE_PREFIXES.some((prefix) => line.startsWith(prefix));
}

function stripBadLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !isBadLine(line))
    .join('\n');
}

function sanitizeSystem(system: AnthropicPayload['system']): AnthropicPayload['system'] {
  if (typeof system === 'string') {
    return stripBadLines(system);
  }

  if (Array.isArray(system)) {
    return system.map((block) => {
      if (block.type !== 'text' || typeof block.text !== 'string') {
        return block;
      }

      return {
        ...block,
        text: stripBadLines(block.text),
      };
    });
  }

  return system;
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
