import * as express from 'express';
import { StreamSink } from '../../Shared/Types';
import { PORT } from '../App/Constants';
import { State } from '../App/State';
import { EnqueueRequest } from './RequestQueue';

/**
 * Start the Express HTTP API server on 127.0.0.1:PORT.
 *
 * Registers three routes:
 * - GET /health: Returns bridge status and current queue length.
 * - GET /v1/models: Returns a models list with 'deepseek-chat'.
 * - POST /v1/chat/completions: OpenAI-compatible chat completions.
 *
 * Streaming requests (stream: true) pass the raw Express response to the
 * queue for SSE chunk writing. Non-streaming requests use a fake StreamSink
 * shim that captures SSE chunks internally, then assembles a single JSON
 * response when end() is called.
 */
export function StartServer(): void {
  const app = express.default();
  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: State.deepseekReady ? 'ready' : 'loading', queue: State.requestQueue.length });
  });

  app.get('/v1/models', (_req, res) => {
    res.json({
      object: 'list',
      data: [{ id: 'deepseek-chat', object: 'model', created: 1700000000, owned_by: 'deepseek' }],
    });
  });

  app.post('/v1/chat/completions', (req, res) => {
    if (!req.body.messages) return res.status(400).json({ error: 'messages required' });
    if (!State.deepseekReady) return res.status(503).json({ error: 'not ready' });

    const rid = ++State.requestIdSeq;
    const tools = req.body.tools || null;

    if (req.body.stream) {
      EnqueueRequest({ id: rid, messages: req.body.messages, tools, res });
    } else {
      const chunks: string[] = [];
      let toolCalls: unknown[] | null = null;
      let finishReason = 'stop';

      const fakeRes: StreamSink = {
        setHeader: () => { },
        flushHeaders: () => { },
        write: (data: string) => {
          if (data.startsWith('data: ') && data !== 'data: [DONE]\n\n') {
            try {
              const j = JSON.parse(data.slice(6));
              const choice = j && j.choices && j.choices[0];
              const delta = choice && choice.delta;
              if (delta && delta.content) chunks.push(delta.content);
              if (delta && delta.tool_calls) toolCalls = delta.tool_calls;
              if (choice && choice.finish_reason) finishReason = choice.finish_reason;
            } catch (_) { }
          }
        },
        end: () => {
          const message: Record<string, unknown> = { role: 'assistant', content: chunks.join('') };
          if (toolCalls && toolCalls.length) message.tool_calls = toolCalls;
          res.json({
            id: `c-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'deepseek-chat',
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
        },
      };

      EnqueueRequest({ id: rid, messages: req.body.messages, tools, res: fakeRes });
    }
  });

  app.listen(PORT, '127.0.0.1', () => { console.log(`[bridge] http://127.0.0.1:${PORT}`); });
}