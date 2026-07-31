# deepseek-bridge

Local OpenAI-compatible HTTP API wrapping the DeepSeek web UI.

Runs DeepSeek in a hidden Electron BrowserWindow. Exposes standard
`/v1/chat/completions` and `/v1/models` endpoints on `127.0.0.1:11435`.

## Setup

```
cd ~/Projects/deepseek-bridge
npm install
npm start
```

First launch opens a DeepSeek window. Log in with your account, then
close the window or let it run hidden. The bridge auto-detects when
the chat UI is ready and begins processing API requests.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Status + queue length |
| GET | /v1/models | Model list |
| POST | /v1/chat/completions | Chat completions (streaming + non-streaming) |

## Usage examples

```bash
# health check
curl http://127.0.0.1:11435/health

# non-streaming chat
curl http://127.0.0.1:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hello"}]}'

# streaming chat
curl -N http://127.0.0.1:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hello"}],"stream":true}'
```

## Goose integration

Add to `~/.zshrc`:

```bash
# deepseek-bridge model
goose -m deepseek    # uses bridge on localhost:11435
```

Or configure Goose to use the `openai` provider with:
- `OPENAI_HOST=127.0.0.1:11435`
- `OPENAI_BASE_PATH=v1`
- `OPENAI_API_KEY=noop`

## How it works

1. Electron opens `https://chat.deepseek.com/` in a hidden BrowserWindow.
2. A preload script detects the textarea and submit button.
3. HTTP requests are queued. For each request, the preload types the
   prompt into DeepSeek's UI and clicks submit.
4. A polling loop reads the response text from the DOM as it streams.
5. The main process relays chunks back over SSE or accumulates for
   non-streaming JSON responses.