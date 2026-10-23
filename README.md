# pi-anthropic-sps

Anthropic system prompt sanitiser extension for pi.

## Install

```bash
pi install npm:@ravshansbox/pi-anthropic-sps
```

Add `-l` to install it in project settings.

## Usage

Pi loads the extension from `./index.ts` and sanitises outgoing Anthropic system prompts for Claude models before the provider request is sent.

For example, if a Claude request contains the known problematic documentation lines in the `system` text, the extension removes those lines while leaving the rest of the prompt unchanged.

It also adds Anthropic's server-side `web_search` and `web_fetch` tools to Claude requests. A tool is skipped if the request already has a tool with the same name. Pi does not show or keep the search and fetch results; you only see Claude's reply.

## Development

```bash
npm install
npm run check
```
