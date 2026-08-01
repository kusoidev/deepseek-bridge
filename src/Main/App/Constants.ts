/**
 * TCP port the Express server listens on.
 * Chosen to avoid conflicts with Ollama (11434) — it's Ollama + 1.
 */
export const PORT = 11435;

/**
 * DeepSeek chat web UI base URL.
 * The BrowserWindow loads this and the preload script drives the textarea.
 */
export const DEEPSEEK_URL = 'https://chat.deepseek.com/';

/**
 * Maximum byte size of a tool result before it gets truncated.
 * Results exceeding this limit are replaced with an instruction to read
 * the output in smaller pieces. Default: 130 KB.
 */
export const MAX_TOOL_RESULT_BYTES = 130 * 1024;

/**
 * Global allowlist of recognized tool names.
 * Any tool name not in this map (and not in the request-level tools array)
 * is rejected during XML tag parsing to prevent false positives from
 * HTML/markdown angle brackets in the model's prose.
 *
 * The value (1) is a sentinel; only key presence matters.
 */
export const TOOL_NAMES: Record<string, number> = {
  bash: 1, shell: 1, sh: 1, run: 1,
  read: 1, write: 1, edit: 1, multiedit: 1, apply_patch: 1, patch: 1,
  grep: 1, glob: 1, list: 1, ls: 1,
  web_search: 1, websearch: 1, web_fetch: 1, webfetch: 1, fetch: 1,
  task: 1, todo: 1, todowrite: 1, todoread: 1, question: 1, skill: 1, lsp: 1,
  tool_call: 1,
};