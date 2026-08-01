/**
 * A single message in an OpenAI-compatible chat completion request or response.
 * Mirrors the standard OpenAI /v1/chat/completions message schema.
 */
export interface OpenAiMessage {
  /** One of 'system', 'user', 'assistant', or 'tool'. */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Text content (string) or multimodal content parts. Optional for tool_calls-only messages. */
  content?: string | OpenAiContentPart[];
  /** Name of the participant. Used for tool results to identify the source. */
  name?: string;
  /** Tool calls made by the assistant. Present on assistant messages that request tool execution. */
  tool_calls?: OpenAiToolCall[];
  /** The ID of the tool call this message is a result for. Present on tool messages. */
  tool_call_id?: string;
}

/**
 * A single content part in a multimodal message.
 * Supports text and image_url types per the OpenAI spec.
 */
export interface OpenAiContentPart {
  /** Content part type: 'text', 'image_url', etc. */
  type: string;
  /** Text content of this part, if type is 'text'. */
  text?: string;
}

/**
 * A tool call requested by the assistant.
 * Contains a unique ID and the function to invoke.
 */
export interface OpenAiToolCall {
  /** Unique identifier for this tool call, used to match results back. */
  id: string;
  /** Always 'function' for OpenAI-compatible tool calls. */
  type: 'function';
  /** The function name and JSON-encoded arguments. */
  function: OpenAiFunctionCall;
}

/**
 * A function invocation within a tool call.
 */
export interface OpenAiFunctionCall {
  /** Name of the function to call (e.g., 'bash', 'read', 'write'). */
  name: string;
  /** JSON-encoded string of the function arguments. */
  arguments: string;
}

/**
 * A tool definition sent by the client in a request.
 * Specifies which tools the model is allowed to call.
 */
export interface OpenAiToolDef {
  /** Always 'function'. */
  type: 'function';
  /** The function descriptor with at minimum a name. */
  function: { name: string };
  /** Alternative field for the tool name (some clients send it here). */
  name?: string;
}

/**
 * A parsed tool call extracted from XML-style tags in the model's output.
 * The index reflects the original order of tags in the text.
 */
export interface ParsedToolCall {
  /** Zero-based position in the sequence of parsed tool calls. */
  index: number;
  /** Unique call ID (e.g., 'call_1712345678_0'). */
  id: string;
  /** Always 'function'. */
  type: 'function';
  /** The function name and arguments, with arguments as a JSON string. */
  function: OpenAiFunctionCall;
}

/**
 * Result of parsing tool calls from the model's full response text.
 * Contains the extracted tool calls and the cleaned prose with tags removed.
 */
export interface ParsedContent {
  /** Array of parsed tool calls found in the text. */
  toolCalls: ParsedToolCall[];
  /** The original text with all tool XML tags stripped and newline runs collapsed. */
  content: string;
}

/**
 * The prompt string to type into DeepSeek, plus a kind tag that determines
 * how it should be handled by the request queue.
 *
 * - 'continuation': tool results fed back after model requested tools
 * - 'fresh': first message in a conversation (system prompts + user)
 * - 'turn': subsequent user message in an ongoing conversation
 * - 'fallback': couldn't determine context, sending most recent user message
 * - 'empty': no usable prompt found (triggers a 400 error)
 */
export interface BuiltPrompt {
  /** The full text to type into the DeepSeek textarea. */
  text: string;
  /** Dispatch classification for the request queue. */
  kind: 'continuation' | 'fresh' | 'turn' | 'fallback' | 'empty';
}

/**
 * Abstraction over an HTTP response, used by the streaming pipeline.
 * Either a real Express response (streaming) or a fake shim (non-streaming
 * mode that captures SSE chunks and assembles a JSON response at the end).
 */
export interface StreamSink {
  /** Set an HTTP response header. */
  setHeader(name: string, value: string): void;
  /** Flush headers to the client (called before first data chunk). */
  flushHeaders(): void;
  /** Write a raw SSE data frame to the response. */
  write(data: string): void;
  /** Signal end of response. */
  end(): void;
  /** Optional Express status setter (present on real response, absent on shim). */
  status?(code: number): { json(data: unknown): void };
  /** Optional Express JSON sender (present on real response, absent on shim). */
  json?(data: unknown): void;
}

/**
 * A request sitting in the serialized queue waiting to be processed.
 * Contains the messages, optional tool definitions, and the response sink.
 */
export interface QueuedRequest {
  /** Monotonically increasing request ID for logging. */
  id: number;
  /** Full OpenAI message array for this completion request. */
  messages: OpenAiMessage[];
  /** Tool definitions from the request, or null if no tools specified. */
  tools: OpenAiToolDef[] | null;
  /** The HTTP response to write chunks or JSON to. */
  res: StreamSink;
}