# deepseek-bridge

A local OpenAI-compatible HTTP API that drives the real DeepSeek web UI in
a hidden browser window. No API key. No credit top-ups. Just your DeepSeek
account and an Electron window.

Exposes `127.0.0.1:11435/v1` so any OpenAI-compatible client (OpenCode,
Claude Code, any tool that speaks `/v1/chat/completions`) can use DeepSeek
for free, with full tool-call support and DeepThink reasoning.

## Why this exists

DeepSeek's API costs money. The web UI is free. This bridge
types your prompts into the actual chat.deepseek.com page, clicks submit,
reads the streaming response from the page's own XHR calls, and shapes it
back into standard OpenAI SSE format. From your coding agent's perspective,
it looks exactly like an OpenAI endpoint.

DeepThink mode is auto-enabled. Search mode is auto-disabled. Thinking
content streams to OpenCode's reasoning panel. Tool calls loop back through
the same conversation thread so the model sees its own output, just like a
real user session.

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by DeepSeek
(Hangzhou DeepSeek Artificial Intelligence Co., Ltd.) or any of its
affiliates. The name "DeepSeek" is used solely to describe the service this
tool interoperates with.

This software does not:

- Distribute, repackage, or redistribute any DeepSeek intellectual property
- Bypass any authentication, paywall, or access control mechanism
- Modify, reverse-engineer, or tamper with DeepSeek's backend services
- Scrape, crawl, or extract data from DeepSeek beyond what a user manually
  typing into the website would receive

It is a browser automation tool. It opens a real browser window to
chat.deepseek.com and types prompts on your behalf, exactly as you would
manually. You must use your own DeepSeek account and comply with DeepSeek's
Terms of Service. You are responsible for how you use this tool.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

This project depends on the chat.deepseek.com web interface, which DeepSeek
may change, restrict, or discontinue at any time without notice. There is no
guarantee this bridge will continue to work. Rate limits, bot detection, or
other restrictions could be introduced at any point. This is a best-effort
tool maintained by the community — use it while it works, but don't build
critical infrastructure on it.

## What you get

- Free DeepSeek access through the web UI (no API key required)
- Full streaming support with proper SSE delta chunks
- DeepThink reasoning content piped to `reasoning_content` in the delta
- Tool-call loop: bash, read, write, grep, web_search, and more
- Handles both `<bash>cmd</bash>` and `<tool_call>` JSON tag formats
- Catches bare shell commands when the model forgets tags
- Auto-enables DeepThink, auto-disables Search on every prompt
- System tray icon, hides to background, reuses login session

## Quick start

```bash
git clone https://github.com/kusoidev/deepseek-bridge.git
cd deepseek-bridge
npm install
npm run build
npm start
```

A DeepSeek window opens. Log in once, close it. The bridge runs in the
background. Hit `http://127.0.0.1:11435/health` to confirm it's ready.

## Tested with

**[OpenCode](https://github.com/anthropics/opencode)** on macOS (Apple
Silicon). Other OpenAI-compatible clients should work. If you test one and
it does (or doesn't), open an issue.

## Setup for OpenCode

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "provider": {
    "deepseek": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepSeek (local bridge)",
      "options": { "baseURL": "http://127.0.0.1:11435/v1" },
      "models": {
        "deepseek-chat": {
          "max_tokens": 8192,
          "context_length": 65536
        }
      }
    }
  },
  "model": "deepseek/deepseek-chat"
}
```

No API key needed. OpenCode sends one anyway; the bridge ignores it.

## How it works

```
POST /v1/chat/completions  -->  Express queue (serial, one at a time)
                                          |
                                   Electron BrowserWindow
                                   (chat.deepseek.com, hidden)
                                          |
                                   Preload types prompt, clicks Enter
                                   Patches XMLHttpRequest to intercept
                                   DeepSeek's streaming SSE response
                                          |
                                   Extracts text + thinking tokens
                                   Sends chunks back via IPC
                                          |
                                   Main process shapes into OpenAI
                                   SSE format (delta.content,
                                   reasoning_content, tool_calls)
                                          |
You  <--  SSE stream  <--  finish_reason: stop | tool_calls | error
```

## Features

### DeepThink support

DeepThink mode is enabled automatically when the bridge starts and before
every prompt. Thinking text streams to `delta.reasoning_content`, which
OpenCode renders in its thinking panel. Response text goes to
`delta.content`. They never mix.

### Tool calls

The model can invoke tools through XML-style tags. Both formats are
supported:

```xml
<bash>ls -la ~/Downloads</bash>
```

```xml
<tool_call>{"id":"bash_1","type":"bash","command":"ls -la","description":"List files"}</tool_call>
```

Tool results are fed back into the same conversation thread with randomized
delays (4-7 seconds, never repeating) so follow-up turns look natural.

### Bare command fallback

If the model outputs a single-line command without any tool tags, the bridge
detects it and wraps it as a bash tool call automatically. Covers cases
where the model forgets the XML wrapper.

### Tool allowlist

Only recognized tool names are parsed. HTML tags and markdown angle brackets
are left in the prose untouched. Request-level tool filtering via the
OpenAI `tools` array is supported.

## Endpoints

| Method | Path                    | Description                              |
|--------|-------------------------|------------------------------------------|
| GET    | `/health`               | Status + queue length                    |
| GET    | `/v1/models`            | Returns `deepseek-chat` model            |
| POST   | `/v1/chat/completions`  | Chat completions (streaming + non-streaming) |

## Building

```bash
npm run build
```

Two TypeScript compilations:

- **Main** (`tsconfig.main.json`) — Node.js, no DOM. App, DeepSeek, Server, Shared, Scripts.
- **Preload** (`tsconfig.preload.json`) — Renderer with DOM. Preload, Shared.

Output lands in `dist/` (gitignored). Entry point: `dist/Main/App/Main.js`.

## Source layout

```
src/
  Main/
    App/                Lifecycle + shared state
      Main.ts             Entry point
      State.ts            All mutable state in one object
      Constants.ts        Port, URLs, tool allowlist
      TrayManager.ts      System tray icon and menu
    DeepSeek/           Model interaction
      DeepSeekWindow.ts   BrowserWindow + IPC handlers
      PromptBuilder.ts    OpenAI messages to prompt string
      StreamHandler.ts    SSE writing, flush, finish
      ToolParser.ts       XML + tool_call tag parsing
    Server/             HTTP-facing
      ApiServer.ts        Express routes
      RequestQueue.ts     Serialized queue with delays
  Preload/             Renderer preload (nodeIntegration: true)
    PreloadEntry.ts       Entry point
    DeepSeekUi.ts         Textarea typing, Enter submit, toggles
    XhrPatch.ts           XMLHttpRequest monkey-patch
  Shared/              Shared between main and preload
    Types.ts              All interfaces
  Scripts/             Standalone utilities
    GenCerts.ts           RSA certificate generator (optional)
```

## Requirements

- Node.js 20+
- npm
- A DeepSeek account

## Limitations

- Single conversation thread — switching projects without starting a new
  chat on the DeepSeek side leaks context between them
- Prompts are typed into a real textarea character by character; very long
  prompts take a moment to submit
- One request at a time — the queue is strictly serial
- Only tested on macOS (Apple Silicon). Electron is cross-platform but
  Linux and Windows are not verified

## License

MIT — see [LICENSE](./LICENSE) for full text.

This project is a browser automation tool. It is not a derivative work of
DeepSeek. It does not contain, bundle, or redistribute any DeepSeek code,
assets, or proprietary materials. The browser window it controls connects
to the publicly accessible chat.deepseek.com website using the user's own
credentials, exactly as a human would.