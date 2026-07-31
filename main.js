const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const express = require('express');
const path = require('path');

const PORT = 11435;
const DEEPSEEK_URL = 'https://chat.deepseek.com/';
const MAX_TOOL_RESULT_BYTES = 130 * 1024;

var pendingRequest = null;
var requestQueue = [];
var requestIdSeq = 0;
var deepseekWindow = null;
var deepseekReady = false;
var currentStreamRes = null;
var streamBuffer = '';
var streamTimer = null;
var streamDone = false;
var responseInProgress = false;
var fullResponseText = '';
var emittedContent = '';
var firstDelta = true;
var currentAllowedTools = null;
var tray = null;
var lastToolDelay = 0;

function createDeepSeekWindow() {
  var preloadPath = path.join(__dirname, 'preload.cjs');
  var win = new BrowserWindow({
    width: 1280, height: 800, show: true, title: 'DeepSeek Bridge',
    webPreferences: { preload: preloadPath, contextIsolation: false, nodeIntegration: true },
  });
  win.loadURL(DEEPSEEK_URL);
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('did-finish-load', function() { setTimeout(checkReady, 2000); });
  win.on('close', function(e) { if (deepseekReady) { e.preventDefault(); win.hide(); } });
  win.on('closed', function() { deepseekWindow = null; if (!deepseekReady) app.quit(); });
  return win;
}

function checkReady() {
  if (!deepseekWindow || deepseekWindow.isDestroyed()) return;
  deepseekWindow.webContents.executeJavaScript(`
    (function() {
      var ta = document.querySelector('textarea');
      return !!(ta && !window.location.href.includes('/sign') && !window.location.href.includes('/login'));
    })()
  `).then(function(ready) {
    if (ready && !deepseekReady) {
      deepseekReady = true;
      if (deepseekWindow && !deepseekWindow.isDestroyed()) deepseekWindow.hide();
      processQueue();
    } else if (!ready) { setTimeout(checkReady, 3000); }
  }).catch(function() { setTimeout(checkReady, 3000); });
}

var TOOL_NAMES = {
  bash:1, shell:1, sh:1, run:1,
  read:1, write:1, edit:1, multiedit:1, apply_patch:1, patch:1,
  grep:1, glob:1, list:1, ls:1,
  web_search:1, websearch:1, web_fetch:1, webfetch:1, fetch:1,
  task:1, todo:1, todowrite:1, todoread:1, question:1, skill:1, lsp:1
};

function buildArgs(name, content) {
  var trimmed = content.trim();
  if (trimmed[0] === '{') {
    try {
      var o = JSON.parse(trimmed);
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch (e) {}
  }
  var lines = content.split('\n');
  var first = lines[0].trim();
  var rest = lines.slice(1).join('\n');
  switch (name) {
    case 'bash': case 'shell': case 'sh': case 'run':
      return { command: trimmed, description: 'Run command' };
    case 'read':
      return { filePath: first };
    case 'write':
      return { filePath: first, content: rest };
    case 'edit': case 'multiedit': case 'apply_patch': case 'patch':
      return { filePath: first, content: trimmed };
    case 'grep':
      return { pattern: first };
    case 'glob':
      return { pattern: first };
    case 'list': case 'ls':
      return { path: first || '.' };
    case 'webfetch': case 'web_fetch': case 'fetch':
      return { url: first };
    case 'websearch': case 'web_search':
      return { query: trimmed };
    default:
      return { input: trimmed };
  }
}

function isToolName(name, allowedSet) {
  if (allowedSet && allowedSet.size > 0) return allowedSet.has(name);
  return !!TOOL_NAMES[name];
}

function parseToolCalls(text, allowedSet) {
  var tc = [];
  var id = 0;
  var re = /<(\w+)>([\s\S]*?)<\/\1>/g;
  var m;
  var matched = [];
  while ((m = re.exec(text)) !== null) {
    var name = m[1].toLowerCase();
    if (!isToolName(name, allowedSet)) continue;
    var content = m[2].trim();
    tc.push({
      index: id,
      id: 'call_' + Date.now() + '_' + id,
      type: 'function',
      function: { name: name, arguments: JSON.stringify(buildArgs(name, content)) }
    });
    matched.push(m[0]);
    id++;
  }
  var cleaned = text;
  for (var i = 0; i < matched.length; i++) {
    cleaned = cleaned.split(matched[i]).join('');
  }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { toolCalls: tc, content: cleaned };
}

function contentOf(msg) {
  var c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    var out = [];
    for (var i = 0; i < c.length; i++) {
      if (c[i] && typeof c[i] === 'object') out.push(c[i].text || '');
      else if (typeof c[i] === 'string') out.push(c[i]);
    }
    return out.join('\n');
  }
  return '';
}

function buildDeepSeekPrompt(messages) {
  var lastIdx = messages.length - 1;
  var last = messages[lastIdx] || {};
  var lastRole = last.role || '';
  var hasAssistant = false;
  var hasTool = false;
  for (var h = 0; h < messages.length; h++) {
    if (messages[h].role === 'assistant') hasAssistant = true;
    if (messages[h].role === 'tool') hasTool = true;
  }

  // Continuation: the model's previous turn called tools and we now have the
  // results to feed back. Only send the results that arrived after the model's
  // last reply; the web thread already saw earlier turns.
  if (lastRole === 'tool') {
    var lastAssistantIdx = -1;
    for (var i = lastIdx; i >= 0; i--) {
      if (messages[i].role === 'assistant') { lastAssistantIdx = i; break; }
    }
    var callInfo = {};
    if (lastAssistantIdx >= 0 && Array.isArray(messages[lastAssistantIdx].tool_calls)) {
      for (var b = 0; b < messages[lastAssistantIdx].tool_calls.length; b++) {
        var tcall = messages[lastAssistantIdx].tool_calls[b];
        callInfo[tcall.id] = tcall.function;
      }
    }
    var parts = ['The tool(s) you just requested have been executed. Here is the output:'];
    for (var c = lastAssistantIdx + 1; c <= lastIdx; c++) {
      if (messages[c].role !== 'tool') continue;
      var fn = callInfo[messages[c].tool_call_id];
      var label;
      if (fn) label = (fn.name || 'tool') + '(' + (fn.arguments || '') + ')';
      else label = messages[c].name || messages[c].tool_call_id || 'tool';
      var res = contentOf(messages[c]) || '(no output)';
      var resBytes = Buffer.byteLength(res, 'utf8');
      if (resBytes > MAX_TOOL_RESULT_BYTES) {
        res = 'Tool result too large (' + Math.round(resBytes / 1024) + ' KB, limit ' + Math.round(MAX_TOOL_RESULT_BYTES / 1024) + ' KB), so it was not included. Read it in smaller pieces instead: target a specific file with a line range, use head or tail, grep for a pattern, or list with a limit, then continue. Do not rerun the same broad command.';
      }
      parts.push('Result for ' + label + ':\n' + res);
    }
    parts.push('Continue now. If you need another tool, reply with its tool tag. If the task is done, answer the user in plain text with no tool tags.');
    return { text: parts.join('\n\n'), kind: 'continuation' };
  }

  // A new user question. The web thread already holds every earlier turn of
  // this conversation, so we only type the new question. The one exception is
  // the very first request (no assistant or tool yet), where the web thread is
  // empty and needs the system instructions too.
  if (lastRole === 'user') {
    var userText = contentOf(last);
    if (!hasAssistant && !hasTool) {
      var head = [];
      for (var s = 0; s < messages.length; s++) {
        if (messages[s].role !== 'system') continue;
        var sys = contentOf(messages[s]);
        if (sys && !(sys.includes('title generator') && sys.includes('Generate a title'))) {
          head.push(sys);
        }
      }
      head.push(userText);
      return { text: head.filter(function(p) { return p; }).join('\n\n'), kind: 'fresh' };
    }
    return { text: userText, kind: 'turn' };
  }

  // Fallback: last message is an assistant turn with no trailing tool result,
  // which should not normally trigger a new request. Send the most recent user
  // message so the model has something to react to.
  for (var j = lastIdx; j >= 0; j--) {
    if (messages[j].role === 'user') return { text: contentOf(messages[j]), kind: 'fallback' };
  }
  return { text: '', kind: 'empty' };
}

function nextToolDelay() {
  // Random pause before feeding a tool result back to DeepSeek, in the range
  // 4000-7000ms at 100ms steps, and never the same value twice in a row, so
  // follow-up turns do not fire on a detectable fixed cadence.
  var d;
  do {
    d = 4000 + 100 * Math.floor(Math.random() * 31);
  } while (d === lastToolDelay);
  lastToolDelay = d;
  return d;
}

function processQueue() {
  if (!deepseekReady || pendingRequest) return;
  if (responseInProgress) return;
  if (requestQueue.length === 0) return;

  pendingRequest = requestQueue.shift();
  var messages = pendingRequest.messages;
  var res = pendingRequest.res;

  currentAllowedTools = null;
  if (Array.isArray(pendingRequest.tools) && pendingRequest.tools.length) {
    currentAllowedTools = new Set();
    for (var t = 0; t < pendingRequest.tools.length; t++) {
      var tool = pendingRequest.tools[t];
      var nm = (tool.function && tool.function.name) || tool.name;
      if (nm) currentAllowedTools.add(String(nm).toLowerCase());
    }
  }

  var built = buildDeepSeekPrompt(messages);
  var userText = built.text;
  if (!userText) {
    if (res.status) res.status(400).json({ error: 'empty' }); else res.end();
    pendingRequest = null; processQueue(); return;
  }

  currentStreamRes = res;
  streamBuffer = '';
  fullResponseText = '';
  emittedContent = '';
  firstDelta = true;
  streamDone = false;
  responseInProgress = true;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  if (built.kind === 'continuation') {
    var delay = nextToolDelay();
    console.log('[bridge] tool-result delay ' + delay + 'ms');
    setTimeout(function() {
      if (deepseekWindow && !deepseekWindow.isDestroyed()) {
        deepseekWindow.webContents.send('bridge:send-prompt', userText);
      }
    }, delay);
  } else {
    deepseekWindow.webContents.send('bridge:send-prompt', userText);
  }
}

function writeChunk(obj) {
  if (!currentStreamRes) return;
  try { currentStreamRes.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {}
}

function emitContent(text) {
  // No streamDone check here: finishStream flips streamDone at its top, then
  // calls emitContent for the final buffered tail (and for error text). The
  // old guard dropped that last fragment, truncating every answer. Late chunks
  // are still blocked by the chunk handler's own streamDone guard, and writes
  // after end stay impossible because currentStreamRes is nulled on finish.
  if (!text || !currentStreamRes) return;
  emittedContent += text;
  var delta = firstDelta ? { role: 'assistant', content: text } : { content: text };
  firstDelta = false;
  writeChunk({
    id: 'chatcmpl-' + Date.now(), object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model: 'deepseek-chat',
    choices: [{ index: 0, delta: delta, finish_reason: null }]
  });
}

function flushStream() {
  if (!currentStreamRes || streamDone) return;
  if (streamBuffer.length === 0) return;
  var emit = streamBuffer;
  var tagStart = /<[a-zA-Z_]/.exec(emit);
  if (tagStart) emit = emit.slice(0, tagStart.index);
  if (emit.length === 0) return;
  streamBuffer = streamBuffer.slice(emit.length);
  emitContent(emit);
}

function finishStream(error) {
  if (!currentStreamRes || streamDone) return;
  streamDone = true;
  responseInProgress = false;
  if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }
  var finishBranch = 'stop';

  if (error) {
    emitContent('\n[Error: ' + error + ']');
    writeChunk({ id: 'e', object: 'chat.completion.chunk', created: 0, model: 'deepseek-chat',
      choices: [{ index: 0, delta: {}, finish_reason: 'error' }] });
    try { currentStreamRes.write('data: [DONE]\n\n'); currentStreamRes.end(); } catch (e) {}
    currentStreamRes = null; pendingRequest = null;
    setTimeout(function() { processQueue(); }, 500);
    return;
  }

  var parsed = parseToolCalls(fullResponseText, currentAllowedTools);

  if (parsed.toolCalls.length > 0) {
    var remaining = '';
    var pc = parsed.content;
    var ec = emittedContent.trim();
    if (ec && pc.indexOf(ec) === 0) remaining = pc.slice(ec.length);
    if (remaining.trim()) emitContent(remaining);

    var tcDelta = { tool_calls: parsed.toolCalls };
    if (firstDelta) { tcDelta.role = 'assistant'; firstDelta = false; }
    writeChunk({
      id: 'tc-' + Date.now(), object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000), model: 'deepseek-chat',
      choices: [{ index: 0, delta: tcDelta, finish_reason: 'tool_calls' }]
    });
    finishBranch = 'tool_calls';
    console.log('[bridge] emitted ' + parsed.toolCalls.length + ' tool call(s)');
  } else {
    if (streamBuffer.length > 0) { emitContent(streamBuffer); streamBuffer = ''; }
    var stopDelta = {};
    if (firstDelta) { stopDelta.role = 'assistant'; firstDelta = false; }
    writeChunk({
      id: 'chatcmpl-' + Date.now(), object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000), model: 'deepseek-chat',
      choices: [{ index: 0, delta: stopDelta, finish_reason: 'stop' }]
    });
  }

  console.log('[bridge] finish=' + finishBranch + ' fullLen=' + fullResponseText.length + ' fullTail=' + JSON.stringify(fullResponseText.slice(-60)) + ' emittedLen=' + emittedContent.length + ' emittedTail=' + JSON.stringify(emittedContent.slice(-60)));
  try { currentStreamRes.write('data: [DONE]\n\n'); currentStreamRes.end(); } catch (e) {}
  currentStreamRes = null; pendingRequest = null;
  setTimeout(function() { processQueue(); }, 500);
}

ipcMain.on('bridge:ready', function() {
  deepseekReady = true;
  if (deepseekWindow && !deepseekWindow.isDestroyed()) deepseekWindow.hide();
  processQueue();
});
ipcMain.on('bridge:chunk', function(_e, t) {
  if (!currentStreamRes || streamDone) return;
  fullResponseText += t;
  streamBuffer += t;
  if (!streamTimer) streamTimer = setInterval(function() { flushStream(); if (streamDone && streamTimer) { clearInterval(streamTimer); streamTimer = null; } }, 50);
});
ipcMain.on('bridge:done', function() { finishStream(null); });
ipcMain.on('bridge:error', function(_e, e) { finishStream(e); });
ipcMain.on('bridge:diag', function(_e, d) {
  console.log('[bridge:diag] rawLen=' + (d && d.rawLen) + ' rawTail=' + JSON.stringify(d && d.rawTail));
});

function startServer() {
  var srv = express();
  srv.use(express.json({ limit: '10mb' }));
  srv.get('/health', function(_r, res) { res.json({ status: deepseekReady ? 'ready' : 'loading', queue: requestQueue.length }); });
  srv.get('/v1/models', function(_r, res) { res.json({ object: 'list', data: [{ id: 'deepseek-chat', object: 'model', created: 1700000000, owned_by: 'deepseek' }] }); });
  srv.post('/v1/chat/completions', function(req, res) {
    if (!req.body.messages) return res.status(400).json({ error: 'messages required' });
    if (!deepseekReady) return res.status(503).json({ error: 'not ready' });
    var rid = ++requestIdSeq;
    var tools = req.body.tools || null;
    if (req.body.stream) {
      requestQueue.push({ id: rid, messages: req.body.messages, tools: tools, res: res });
      processQueue();
    } else {
      var ch = [];
      var toolCalls = null;
      var finishReason = 'stop';
      var fr = {
        setHeader: function() {}, flushHeaders: function() {},
        write: function(d) {
          if (d.startsWith('data: ') && d !== 'data: [DONE]\n\n') {
            try {
              var j = JSON.parse(d.slice(6));
              var choice = j && j.choices && j.choices[0];
              var delta = choice && choice.delta;
              if (delta && delta.content) ch.push(delta.content);
              if (delta && delta.tool_calls) toolCalls = delta.tool_calls;
              if (choice && choice.finish_reason) finishReason = choice.finish_reason;
            } catch (e) {}
          }
        },
        end: function() {
          var message = { role: 'assistant', content: ch.join('') };
          if (toolCalls && toolCalls.length) message.tool_calls = toolCalls;
          res.json({
            id: 'c-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'deepseek-chat',
            choices: [{ index: 0, message: message, finish_reason: finishReason }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          });
        }
      };
      requestQueue.push({ id: rid, messages: req.body.messages, tools: tools, res: fr });
      processQueue();
    }
  });
  srv.listen(PORT, '127.0.0.1', function() { console.log('[bridge] http://127.0.0.1:' + PORT); });
}

function createTray() {
  var icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAABAAAAAQCAYAAAAf8/9hAAAARklEQVQ4T2NkYPj/n4EBBJgYKAQMowYMfTAAAAAASUVORK5CYII=');
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('DeepSeek Bridge');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Status: ' + (deepseekReady ? 'Ready' : 'Loading...'), enabled: false }, { type: 'separator' },
    { label: 'Show Window', click: function() { if (!deepseekWindow || deepseekWindow.isDestroyed()) deepseekWindow = createDeepSeekWindow(); else { deepseekWindow.show(); deepseekWindow.focus(); } } }, { type: 'separator' },
    { label: 'Quit', click: function() { app.exit(0); } }
  ]));
}

app.whenReady().then(function() { deepseekWindow = createDeepSeekWindow(); startServer(); createTray(); });
app.on('window-all-closed', function() {});
app.on('before-quit', function() { if (deepseekWindow && !deepseekWindow.isDestroyed()) deepseekWindow.destroy(); if (tray) { tray.destroy(); tray = null; } });
app.on('activate', function() { if (!deepseekWindow || deepseekWindow.isDestroyed()) deepseekWindow = createDeepSeekWindow(); else deepseekWindow.show(); });