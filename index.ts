import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

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

const WEB_TOOLS: AnthropicTool[] = [
  { type: 'web_search_20250305', name: 'web_search' },
  { type: 'web_fetch_20250910', name: 'web_fetch' },
];

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

export default function anthropicSystemPromptSanitizer(pi: ExtensionAPI) {
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
