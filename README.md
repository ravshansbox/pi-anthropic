# pi-anthropic

Anthropic system prompt sanitiser extension for pi.

## Install

```bash
pi install npm:@ravshansbox/pi-anthropic
```

Add `-l` to install it in project settings.

## Usage

Pi loads the extension from `./index.ts` and sanitises outgoing Anthropic system prompts for Claude models that use the Anthropic Messages API before the provider request is sent.

For example, if a Claude request contains the known problematic documentation lines in the `system` text, the extension removes those lines while leaving the rest of the prompt unchanged.

It also adds Anthropic's server-side `web_search` and `web_fetch` tools to Claude requests. A tool is skipped if the request already has a tool with the same name. Pi does not show or keep the search and fetch results; you only see Claude's reply.

`./quota.ts` shows the used Anthropic quota in the footer when the active model is from Anthropic, e.g. `7% 1h29m · 33% 4d` (5-hour window first, then 7-day window, each with time until reset).

- Calls the Anthropic usage endpoint once on session start, then reads the quota from the rate limit headers of each Anthropic response
- Refreshes the Anthropic OAuth token in `~/.pi/agent/auth.json` when needed and writes it back
- Runs `pi -p hi` with the active model when a quota window resets
- Appends errors to `~/.pi/agent/pi-anthropic.log`

## Development

```bash
npm install
npm run check
```
