import { ParsedContent } from '../../Shared/Types';
import { ParseToolCalls } from './ToolParser';
import { State } from '../App/State';
import { ProcessQueue } from '../Server/RequestQueue';

/**
 * Write a single Server-Sent Events frame to the current HTTP response.
 *
 * Formats the object as JSON, wraps it in `data: ...\n\n`, and writes
 * to the response stream. Silently swallows errors (broken pipe, etc.).
 *
 * @param obj - The object to serialize as an SSE data frame.
 */
function WriteChunk(obj: Record<string, unknown>): void {
  if (!State.currentStreamRes) return;
  try { State.currentStreamRes.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) { }
}

/**
 * Emit a delta content chunk to the SSE client.
 *
 * Tracks emittedContent for tool-call boundary detection. The first delta
 * in a stream includes `role: 'assistant'`; subsequent deltas only carry
 * `content`. Each delta is a valid OpenAI-compatible streaming chunk.
 *
 * @param text - The text content to emit as a delta.
 */
function EmitContent(text: string): void {
  if (!text || !State.currentStreamRes) return;
  State.emittedContent += text;
  const delta: Record<string, unknown> = State.firstDelta
    ? { role: 'assistant', content: text }
    : { content: text };
  State.firstDelta = false;
  WriteChunk({
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'deepseek-chat',
    choices: [{ index: 0, delta, finish_reason: null }],
  });
}

/**
 * Emit a thinking-only delta chunk to the SSE client.
 *
 * Thinking deltas carry `reasoning_content` instead of `content`.
 * OpenCode renders these in its thinking panel. The first thinking
 * delta in a stream includes `role: 'assistant'`; subsequent deltas
 * only carry `reasoning_content`.
 *
 * @param text - The thinking text to emit.
 */
export function EmitThinking(text: string): void {
  if (!text || !State.currentStreamRes) return;
  const delta: Record<string, unknown> = State.firstDelta
    ? { role: 'assistant', reasoning_content: text }
    : { reasoning_content: text };
  State.firstDelta = false;
  WriteChunk({
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'deepseek-chat',
    choices: [{ index: 0, delta, finish_reason: null }],
  });
}

/**
 * Flush buffered response text to the client.
 *
 * Called every 50ms by the chunk interval timer. Stops at the first
 * opening angle bracket followed by a letter/underscore (potential
 * tool tag), so XML tool calls never leak into delta.content.
 *
 * Thinking text is emitted immediately on arrival (bridge:thinking handler)
 * rather than buffered, so it streams to OpenCode's thinking panel in
 * real time without mixing with response text.
 */
export function FlushStream(): void {
  if (!State.currentStreamRes || State.streamDone) return;
  if (State.streamBuffer.length === 0) return;
  let emit = State.streamBuffer;
  const tagStart = /<[a-zA-Z_]/.exec(emit);
  if (tagStart) emit = emit.slice(0, tagStart.index);
  if (emit.length === 0) return;
  State.streamBuffer = State.streamBuffer.slice(emit.length);
  EmitContent(emit);
}

/**
 * Finalize the current streaming response.
 *
 * Called when the model finishes (bridge:done) or errors (bridge:error).
 * Two possible outcomes:
 *
 * 1. Tool calls found: Parse XML tags from fullResponseText, emit any
 *    remaining prose, then emit a tool_calls delta with finish_reason
 *    'tool_calls'.
 *
 * 2. No tool calls: Flush any remaining buffer, emit a final empty
 *    delta with finish_reason 'stop'.
 *
 * After finishing, null out the stream state and schedule ProcessQueue
 * to run after a 500ms cooldown.
 *
 * @param error - Optional error message. If provided, emits an error chunk
 *                with finish_reason 'error' instead of normal completion.
 */
export function FinishStream(error?: string): void {
  if (!State.currentStreamRes || State.streamDone) return;
  State.streamDone = true;
  State.responseInProgress = false;
  if (State.streamTimer) { clearInterval(State.streamTimer); State.streamTimer = null; }
  let finishBranch = 'stop';

  if (error) {
    EmitContent(`\n[Error: ${error}]`);
    WriteChunk({
      id: 'e', object: 'chat.completion.chunk', created: 0, model: 'deepseek-chat',
      choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
    });
    try { State.currentStreamRes.write('data: [DONE]\n\n'); State.currentStreamRes.end(); } catch (_) { }
    State.currentStreamRes = null;
    State.pendingRequest = null;
    setTimeout(() => ProcessQueue(), 500);
    return;
  }

  let parsed: ParsedContent = ParseToolCalls(State.fullResponseText, State.currentAllowedTools);

  if (parsed.toolCalls.length === 0) {
    const bare = parsed.content.trim();
    if (bare && !bare.includes('\n') && /^[a-z][a-z0-9_-]*(\s+-\S+|\s+[~\/.\w])/.test(bare)) {
      parsed = {
        toolCalls: [{
          index: 0,
          id: `call_${Date.now()}_0`,
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: bare, description: 'Run command' }) },
        }],
        content: '',
      };
    }
  }

  if (parsed.toolCalls.length > 0) {
    let remaining = '';
    const pc = parsed.content;
    const ec = State.emittedContent.trim();
    if (ec && pc.indexOf(ec) === 0) remaining = pc.slice(ec.length);
    if (remaining.trim()) EmitContent(remaining);

    const tcDelta: Record<string, unknown> = { tool_calls: parsed.toolCalls };
    if (State.firstDelta) { tcDelta.role = 'assistant'; State.firstDelta = false; }
    WriteChunk({
      id: `tc-${Date.now()}`, object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000), model: 'deepseek-chat',
      choices: [{ index: 0, delta: tcDelta, finish_reason: 'tool_calls' }],
    });
    finishBranch = 'tool_calls';
    console.log(`[bridge] emitted ${parsed.toolCalls.length} tool call(s)`);
  } else {
    if (State.streamBuffer.length > 0) { EmitContent(State.streamBuffer); State.streamBuffer = ''; }
    const stopDelta: Record<string, unknown> = {};
    if (State.firstDelta) { stopDelta.role = 'assistant'; State.firstDelta = false; }
    WriteChunk({
      id: `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000), model: 'deepseek-chat',
      choices: [{ index: 0, delta: stopDelta, finish_reason: 'stop' }],
    });
  }

  console.log(`[bridge] finish=${finishBranch} fullLen=${State.fullResponseText.length} fullTail=${JSON.stringify(State.fullResponseText.slice(-60))} emittedLen=${State.emittedContent.length} emittedTail=${JSON.stringify(State.emittedContent.slice(-60))}`);
  try { State.currentStreamRes.write('data: [DONE]\n\n'); State.currentStreamRes.end(); } catch (_) { }
  State.currentStreamRes = null;
  State.pendingRequest = null;
  setTimeout(() => ProcessQueue(), 500);
}