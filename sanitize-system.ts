type AnthropicSystemBlock = {
  type: string;
  text?: string;
  cache_control?: { type: 'ephemeral'; ttl?: '1h' | '5m' };
};

export type AnthropicSystem = AnthropicSystemBlock[] | string;

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

export function sanitizeSystem(system: AnthropicSystem | undefined): AnthropicSystem | undefined {
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
