import { OpenAiMessage, OpenAiFunctionCall, BuiltPrompt } from '../../Shared/Types';
import { MAX_TOOL_RESULT_BYTES } from '../App/Constants';

/**
 * Extract the plain text content from an OpenAI message.
 *
 * Handles string content directly, arrays of content parts (multimodal),
 * and null/undefined (returns empty string).
 *
 * @param msg - An OpenAI message object.
 * @returns The concatenated text content.
 *
 * @example
 * ContentOf({ role: 'user', content: 'hello' })
 * // => 'hello'
 *
 * @example
 * ContentOf({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
 * // => 'hi'
 */
function ContentOf(msg: OpenAiMessage): string {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const part of c) {
      if (part && typeof part === 'object') parts.push(part.text || '');
      else if (typeof part === 'string') parts.push(part);
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * Convert an array of OpenAI messages into a single string to type into DeepSeek.
 *
 * This is the central prompt assembly logic. It decides what to type based on
 * the role of the LAST message in the array:
 *
 * - **last = tool**: The model just called tools and we have results. Build a
 *   continuation prompt that presents each tool's output labelled with the
 *   function call that produced it. Only include results that arrived after
 *   the model's last assistant turn (the web thread already saw earlier turns).
 *   Truncate any result over MAX_TOOL_RESULT_BYTES.
 *
 * - **last = user, first request**: No assistant or tool messages exist yet.
 *   Include system prompts (except the OpenAI title-generator one) followed
 *   by the user question. The web thread is empty so we need the full context.
 *
 * - **last = user, ongoing**: The web thread already holds the conversation
 *   history. Only type the new user question.
 *
 * - **fallback**: The last message is something unexpected (e.g., assistant
 *   with no trailing tool result). Scan backward for the most recent user
 *   message and send that.
 *
 * @param messages - Full array of OpenAI messages in chronological order.
 * @returns A BuiltPrompt with the text to type and a kind tag.
 *
 * @example
 * BuildDeepSeekPrompt([
 *   { role: 'system', content: 'You are helpful.' },
 *   { role: 'user', content: 'What is 2+2?' }
 * ])
 * // => { text: 'You are helpful.\n\nWhat is 2+2?', kind: 'fresh' }
 */
export function BuildDeepSeekPrompt(messages: OpenAiMessage[]): BuiltPrompt {
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx] || ({} as OpenAiMessage);
  const lastRole = last.role || '';

  let hasAssistant = false;
  let hasTool = false;
  for (const msg of messages) {
    if (msg.role === 'assistant') hasAssistant = true;
    if (msg.role === 'tool') hasTool = true;
  }

  if (lastRole === 'tool') {
    let lastAssistantIdx = -1;
    for (let i = lastIdx; i >= 0; i--) {
      if (messages[i].role === 'assistant') { lastAssistantIdx = i; break; }
    }
    const callInfo: Record<string, OpenAiFunctionCall> = {};
    if (lastAssistantIdx >= 0 && Array.isArray(messages[lastAssistantIdx].tool_calls)) {
      for (const tcall of messages[lastAssistantIdx].tool_calls!) {
        callInfo[tcall.id] = tcall.function;
      }
    }
    const parts = ['The tool(s) you just requested have been executed. Here is the output:'];
    for (let c = lastAssistantIdx + 1; c <= lastIdx; c++) {
      if (messages[c].role !== 'tool') continue;
      const fn = callInfo[messages[c].tool_call_id!];
      let label: string;
      if (fn) label = `${fn.name || 'tool'}(${fn.arguments || ''})`;
      else label = messages[c].name || messages[c].tool_call_id || 'tool';
      let res = ContentOf(messages[c]) || '(no output)';
      const resBytes = Buffer.byteLength(res, 'utf8');
      if (resBytes > MAX_TOOL_RESULT_BYTES) {
        res = `Tool result too large (${Math.round(resBytes / 1024)} KB, limit ${Math.round(MAX_TOOL_RESULT_BYTES / 1024)} KB), so it was not included. Read it in smaller pieces instead: target a specific file with a line range, use head or tail, grep for a pattern, or list with a limit, then continue. Do not rerun the same broad command.`;
      }
      parts.push(`Result for ${label}:\n${res}`);
    }
    parts.push('Continue now. If you need another tool, reply with its tool tag. If the task is done, answer the user in plain text with no tool tags.');
    return { text: parts.join('\n\n'), kind: 'continuation' };
  }

  if (lastRole === 'user') {
    const userText = ContentOf(last);
    if (!hasAssistant && !hasTool) {
      const head: string[] = [];
      for (const msg of messages) {
        if (msg.role !== 'system') continue;
        const sys = ContentOf(msg);
        if (sys && !(sys.includes('title generator') && sys.includes('Generate a title'))) {
          head.push(sys);
        }
      }
      head.push(userText);
      return { text: head.filter(p => p).join('\n\n'), kind: 'fresh' };
    }
    return { text: userText, kind: 'turn' };
  }

  for (let j = lastIdx; j >= 0; j--) {
    if (messages[j].role === 'user') return { text: ContentOf(messages[j]), kind: 'fallback' };
  }
  return { text: '', kind: 'empty' };
}