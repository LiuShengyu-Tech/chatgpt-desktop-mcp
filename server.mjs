#!/usr/bin/env node
// ChatGPT Desktop MCP server (zero dependencies, Node >= 22).
// Drives the ChatGPT desktop app's own window over the Chrome DevTools
// Protocol. The app must be started with --remote-debugging-port (see
// start-chatgpt.ps1). Everything happens in the visible UI, so the user can
// keep using the same window.

const PORT = Number(process.env.CHATGPT_CDP_PORT || 9222);
const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- CDP ----
let conn = null; // { ws, call, targetId }

async function fetchMain() {
  try {
    const list = await (await fetch(`http://${HOST}:${PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    const pages = list.filter(t => t.type === 'page' && t.url.startsWith('app://'));
    return pages.find(t => !t.url.includes('initialRoute')) || pages[0] || null;
  } catch {
    return undefined; // port not reachable
  }
}

// If ChatGPT is closed, start it with the debugging port (start-chatgpt.ps1).
// If it runs without the port, it is only restarted when the user allowed it
// (restart_chatgpt with confirm, or CHATGPT_AUTO_RESTART=1).
const AUTO_RESTART = process.env.CHATGPT_AUTO_RESTART === '1';
async function launchChatGPT(restart = false) {
  const { execFile } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('./start-chatgpt.ps1', import.meta.url));
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Port', String(PORT)];
  if (restart) args.push('-Restart');
  return new Promise(res => execFile('powershell.exe', args,
    { windowsHide: true, timeout: 30000 },
    (err, stdout, stderr) => res({ ok: !err, out: String(stdout || '') + String(stderr || '') })));
}

async function chatgptRunning() {
  const { execFile } = await import('node:child_process');
  return new Promise(res => execFile('tasklist', ['/FI', 'IMAGENAME eq ChatGPT.exe', '/NH'], { windowsHide: true, timeout: 10000 },
    (err, out) => res(!err && /ChatGPT\.exe/i.test(String(out)))));
}

const NEEDS_RESTART = `ChatGPT is open but was started without the debugging port, so it cannot be controlled. ` +
  `Ask the user whether ChatGPT may be restarted with the debugging port (this closes the window and interrupts any reply or task running in it). ` +
  `If they agree, call restart_chatgpt with confirm: true. (Set CHATGPT_AUTO_RESTART=1 to allow this without asking.)`;

let launching = null;
let justLaunched = false;
async function mainTarget() {
  let main = await fetchMain();
  if (main) return main;
  if (main === undefined) {
    const running = await chatgptRunning();
    if (running && !AUTO_RESTART) throw new Error(NEEDS_RESTART);
    launching ||= launchChatGPT(running).finally(() => { launching = null; });
    const r = await launching;
    if (!r.ok) throw new Error(`ChatGPT is not reachable on ${HOST}:${PORT} and could not be started with the debugging port: ${r.out.trim()}`);
  }
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await sleep(1500);
    main = await fetchMain();
    if (main) { justLaunched = true; return main; }
  }
  throw new Error('ChatGPT was started but its main window did not appear within 45 s.');
}

async function cdp() {
  const target = await mainTarget();
  if (conn && conn.targetId === target.id && conn.ws.readyState === WebSocket.OPEN) return conn;
  if (conn) try { conn.ws.close(); } catch {}
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };
    const fail = message => { cleanup(); reject(new Error(message)); try { ws.close(); } catch {} };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => fail('CDP websocket failed');
    const onClose = () => fail('CDP closed before the connection opened');
    const timer = setTimeout(() => fail('CDP connection timed out after 10 s'), 10000);
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  });
  let seq = 0;
  const pending = new Map();
  // Drop the connection and fail every pending request; the next cdp() call reconnects.
  const invalidate = error => {
    if (conn?.ws === ws) conn = null;
    for (const p of pending.values()) { clearTimeout(p.timer); p.rej(error); }
    pending.clear();
    try { ws.close(); } catch {}
  };
  ws.addEventListener('message', e => {
    let m;
    try { m = JSON.parse(e.data); } catch { invalidate(new Error('Invalid CDP response')); return; }
    const p = m.id && pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  });
  ws.addEventListener('close', () => invalidate(new Error('CDP closed')));
  ws.addEventListener('error', () => invalidate(new Error('CDP websocket failed')));
  // Never retry automatically after a timeout: the request may already have taken effect
  // (a message sent, a thread created). 45 s leaves room for the 30 s in-page bridge wait.
  const call = (method, params = {}, timeoutMs = 45000) => new Promise((res, rej) => {
    if (ws.readyState !== WebSocket.OPEN) { rej(new Error('CDP is not connected')); return; }
    const id = ++seq;
    const timer = setTimeout(() => invalidate(new Error(`${method}: CDP request timed out after ${Math.round(timeoutMs / 1000)} s; the outcome is unknown`)), timeoutMs);
    pending.set(id, { res, rej, timer });
    try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { invalidate(e); }
  });
  conn = { ws, call, targetId: target.id };
  if (justLaunched) {
    // Freshly started app: wait until the UI (mode switch / message box) is rendered.
    justLaunched = false;
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline && conn?.ws === ws) {
      try {
        const r = await call('Runtime.evaluate', {
          expression: `!!(document.querySelector('[contenteditable="true"]') || document.querySelector('button[aria-label^="Switch mode"]'))`,
          returnByValue: true,
        }, 5000);
        if (r.result.value) { await sleep(1000); break; }
      } catch {}
      await sleep(1000);
    }
  }
  // A timeout during the startup wait drops the connection; reconnect once instead of returning null.
  return conn?.ws === ws ? conn : cdp();
}

// Run a function in the page. fn is serialized; args must be JSON-safe.
async function evaluate(fn, ...args) {
  const { call } = await cdp();
  const r = await call('Runtime.evaluate', {
    expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

// ------------------------------------------------------ page helpers ----
// These run inside the ChatGPT window.

function pageListChats(limit) {
  const out = [];
  const seen = new Set();
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  for (const el of document.querySelectorAll('[data-app-action-sidebar-thread-id], [data-sidebar-chatgpt-conversation-key]')) {
    const id = el.getAttribute('data-app-action-sidebar-thread-id') || el.getAttribute('data-sidebar-chatgpt-conversation-key');
    if (seen.has(id)) continue;
    seen.add(id);
    const title = el.getAttribute('data-app-action-sidebar-thread-title') || el.getAttribute('aria-label') || clean(el.querySelector('[data-thread-title]')?.innerText || el.innerText).split(' ').slice(0, 20).join(' ');
    const project = el.closest('[data-app-action-sidebar-project-label]')?.getAttribute('data-app-action-sidebar-project-label') || null;
    out.push({
      id,
      title: clean(title),
      kind: id.startsWith('chatgpt:') ? 'chatgpt' : (el.getAttribute('data-app-action-sidebar-thread-kind') || 'codex'),
      project,
      active: el.getAttribute('data-app-action-sidebar-thread-selected') === 'true' || el.getAttribute('data-app-action-sidebar-thread-active') === 'true' || el.getAttribute('aria-current') === 'page' || !!el.querySelector('[aria-current="page"]') || clean(title) === document.title,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function pageOpenChat(id, title) {
  const rows = [...document.querySelectorAll('[data-app-action-sidebar-thread-id], [data-sidebar-chatgpt-conversation-key]')];
  const key = el => el.getAttribute('data-app-action-sidebar-thread-id') || el.getAttribute('data-sidebar-chatgpt-conversation-key');
  const name = el => (el.getAttribute('data-app-action-sidebar-thread-title') || el.getAttribute('aria-label') || el.innerText || '').trim();
  let row = id ? rows.find(r => key(r) === id) : null;
  if (!row && title) row = rows.find(r => name(r) === title) || rows.find(r => name(r).includes(title));
  if (!row) return { ok: false, error: 'Chat not found in the sidebar. Call list_chats first (only chats visible in the sidebar can be opened).' };
  const target = row.matches('[role=button],a,button') ? row : (row.querySelector('a,[role=button],[data-thread-title-trigger]') || row);
  target.scrollIntoView({ block: 'center' });
  target.click();
  return { ok: true, id: key(row), title: name(row).split('\n')[0] };
}

function pageNewChat(project) {
  const btns = [...document.querySelectorAll('button,a,[role=button]')];
  let el;
  if (project) {
    el = btns.find(b => /^(Start new chat|New local chat|New chat) in /.test(b.getAttribute('aria-label') || '') && (b.getAttribute('aria-label') || '').endsWith(' in ' + project));
    if (!el) return { ok: false, error: `No "new chat" button for project "${project}".` };
  } else {
    el = btns.find(b => (b.innerText || '').trim() === 'New chat') || btns.find(b => b.getAttribute('aria-label') === 'Start new chat') || btns.find(b => b.getAttribute('aria-label') === 'New chat');
    if (!el) return { ok: false, error: 'New chat button not found.' };
  }
  el.click();
  return { ok: true };
}

function pageReadMessages() {
  // Only the visible chat: other chats stay mounted but hidden.
  // Intermediate notes inside an expanded "Worked for ..." block are steps, not messages.
  const nodes = [...document.querySelectorAll('[data-conversation-role]')]
    .filter(n => n.getClientRects().length && !n.closest('[data-spacing="activity"]'));
  // keep outermost nodes only
  const top = nodes.filter(n => !nodes.some(o => o !== n && o.contains(n)));
  return top.map(n => {
    // ChatGPT chats mark a turn with an <h4> ("You said:") whose parent holds the text.
    const box = /^H[1-6]$/.test(n.tagName) ? n.parentElement : n;
    let text = (box.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    text = text.replace(/^(You said:|ChatGPT said:)\s*/, '').trim();
    return { role: n.getAttribute('data-conversation-role'), text };
  }).filter(m => m.text);
}

// Expand each turn's "Worked for ..." block (UI only) and read its steps:
// the agent's interim notes and the actions it took ("Ran a command", ...).
async function pageReadSteps(expand) {
  const vis = e => e.getClientRects().length > 0;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const turns = [...document.querySelectorAll('[data-turn-key]')].filter(vis);
  if (expand) {
    let clicked = false;
    for (const t of turns) {
      const b = t.querySelector('[data-turn-disclosure-button]');
      if (b && b.getAttribute('aria-expanded') === 'false') { b.click(); clicked = true; }
    }
    if (clicked) await wait(1200);
    for (let round = 0; round < 3; round++) {
      const bs = turns.flatMap(t => [...t.querySelectorAll('[data-spacing="activity"] button[aria-expanded="false"]')].filter(vis));
      if (!bs.length) break;
      bs.forEach(b => b.click());
      await wait(700);
    }
  }
  const clean = s => (s || '').replace(/^ChatGPT said:\s*/, '').replace(/\n{3,}/g, '\n\n').trim();
  return turns.map(t => {
    const b = t.querySelector('[data-turn-disclosure-button]');
    const act = t.querySelector('[data-spacing="activity"]');
    const steps = [];
    if (act) {
      const els = [...act.querySelectorAll('[data-markdown-text-style="assistant-message"], [data-local-conversation-item-target-ids]')];
      const top = els.filter(e => !els.some(o => o !== e && o.contains(e)));
      for (const e of top) {
        if (e.hasAttribute('data-local-conversation-item-target-ids')) {
          const lines = (e.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
          const detail = [...e.querySelectorAll('pre, code')].map(p => p.innerText.trim()).filter(Boolean);
          steps.push({ type: 'action', summary: lines[0] || '', details: [...new Set([...lines.slice(1), ...detail])] });
        } else {
          steps.push({ type: 'note', text: clean(e.innerText) });
        }
      }
    }
    return { worked: b ? (b.innerText || '').trim() : null, expanded: b ? b.getAttribute('aria-expanded') === 'true' : null, steps };
  });
}

function pageState() {
  const btns = [...document.querySelectorAll('button')];
  const label = b => (b.getAttribute('aria-label') || '').toLowerCase();
  const visible = e => e.getClientRects().length > 0;
  const stopVisible = btns.some(b => /^(stop|stop generating|stop streaming|interrupt)/.test(label(b)) && visible(b));
  const sendVisible = btns.some(b => /^(send|send message)$/.test(label(b)) && visible(b));
  // The Stop/Send button is the source of truth; a turn marker can stay "in_progress" after a stop.
  const busy = stopVisible || (!sendVisible && [...document.querySelectorAll('[data-talvt-turn-state]')].some(e => visible(e) && !/^(complete|completed|cancelled|canceled|failed|error|interrupted|stopped)$/.test(e.getAttribute('data-talvt-turn-state') || '')));
  const composer = document.querySelector('[contenteditable="true"]');
  const modeBtn = btns.find(b => (b.getAttribute('aria-label') || '').startsWith('Switch mode, current mode:'));
  return {
    title: document.title,
    mode: modeBtn ? modeBtn.getAttribute('aria-label').replace('Switch mode, current mode: ', '') : null,
    busy,
    hasComposer: !!composer,
    messageCount: [...document.querySelectorAll('[data-conversation-role]')].filter(visible).length,
  };
}

function pageFocusComposer() {
  const eds = [...document.querySelectorAll('[contenteditable="true"]')].filter(e => e.offsetParent !== null);
  const ed = eds[eds.length - 1];
  if (!ed) return false;
  ed.focus();
  const sel = window.getSelection();
  sel.selectAllChildren(ed);
  sel.collapseToEnd();
  return true;
}

function pageClickStop() {
  const b = [...document.querySelectorAll('button[aria-label="Stop"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"], button[data-testid="stop-button"]')]
    .filter(e => e.getClientRects().length).pop();
  if (!b) return false;
  b.click();
  return true;
}

function pageClickSend() {
  const send = [...document.querySelectorAll('button[aria-label="Send"], button[aria-label="Send message"], button[data-testid="send-button"]')].filter(b => b.offsetParent !== null).pop();
  if (!send) return { ok: false, error: 'Send button not found.' };
  if (send.disabled) return { ok: false, error: 'Send button is disabled.' };
  send.click();
  return { ok: true };
}

// Send one request to the app's own Codex app-server through the channel the
// window itself uses (electronBridge "mcp-request"). The app treats it like its
// own request, so new threads, turns and goals show up in the window live.
async function pageBridgeRequest(method, params, timeoutMs) {
  const b = window.electronBridge;
  if (!b || typeof b.sendMessageFromView !== 'function') return { bridgeMissing: true };
  const id = 'cdmcp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return await new Promise(res => {
    const done = v => { window.removeEventListener('message', h); clearTimeout(t); res(v); };
    const h = e => { const d = e.data; if (d && d.type === 'mcp-response' && d.message && d.message.id === id) done(d.message); };
    const t = setTimeout(() => done({ timeout: true }), timeoutMs);
    window.addEventListener('message', h);
    Promise.resolve(b.sendMessageFromView({ type: 'mcp-request', hostId: 'local', request: { id, method, params } }))
      .catch(err => done({ sendError: String(err && err.message || err) }));
  });
}

async function pageAppInfo() {
  const b = window.electronBridge || {};
  let ua = null;
  try { ua = await b.getDesktopUserAgent?.(); } catch {}
  let flavor = null;
  try { flavor = await b.getBuildFlavor?.(); } catch {}
  return { userAgent: ua, buildFlavor: flavor, hasBridge: typeof b.sendMessageFromView === 'function' };
}

// ------------------------------------------------- local projects ----
// The app keeps its local (folder-backed) projects in ~/.codex/.codex-global-state.json
// under "local-projects": { id: { name, rootPaths: [...] } }.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';

const STATE_FILE = process.env.CODEX_GLOBAL_STATE || join(process.env.CODEX_HOME || join(homedir(), '.codex'), '.codex-global-state.json');
const normPath = p => resolve(p).replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();

function localProjects() {
  let state;
  try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { throw new Error(`Cannot read ${STATE_FILE}: ${e.message}`); }
  return Object.values(state['local-projects'] || {}).map(p => ({ id: p.id, name: p.name, rootPaths: p.rootPaths || [] }));
}

// Pick the project whose root is cwd, or the deepest root that contains cwd.
function projectForCwd(cwd) {
  const target = normPath(cwd);
  let best = null, bestLen = -1;
  for (const p of localProjects()) {
    for (const root of p.rootPaths) {
      const r = normPath(root);
      if ((target === r || target.startsWith(r + '\\')) && r.length > bestLen) { best = { ...p, root }; bestLen = r.length; }
    }
  }
  return best;
}

// ------------------------------------------- preflight / app-server ----
// ChatGPT desktop versions this plugin was tested against (prefix of the
// "Codex Desktop/<version>" user agent). The bridge is an internal channel of
// the app, so other versions may work but are not guaranteed to.
const TESTED_APP_VERSIONS = ['26.1117'];

let preflightCache = null; // { targetId, result }

async function preflight({ launch = false } = {}) {
  const out = { port: PORT, debug_port_open: false, chatgpt_running: null, auto_restart_allowed: AUTO_RESTART };
  let main = await fetchMain();
  if (!main && launch) { try { main = await mainTarget(); } catch (e) { out.error = e.message; } }
  if (!main) {
    out.chatgpt_running = await chatgptRunning();
    out.ready = false;
    out.next = out.error ? out.error
      : out.chatgpt_running ? NEEDS_RESTART
      : 'ChatGPT is closed. Any tool call starts it with the debugging port.';
    return out;
  }
  out.debug_port_open = true;
  out.chatgpt_running = true;
  if (preflightCache && preflightCache.targetId === main.id) return { ...out, ...preflightCache.result, cached: true };
  const info = await evaluate(pageAppInfo);
  const version = /Codex Desktop\/([\d.]+)/.exec(info.userAgent || '')?.[1] || null;
  const res = {
    app_version: version,
    build_flavor: info.buildFlavor,
    tested_versions: TESTED_APP_VERSIONS,
    version_status: !version ? 'unknown' : TESTED_APP_VERSIONS.some(v => version === v || version.startsWith(v + '.')) ? 'tested' : 'untested',
    bridge: 'missing',
  };
  if (info.hasBridge) {
    const t0 = Date.now();
    const r = await evaluate(pageBridgeRequest, 'collaborationMode/list', {}, 10000);
    if (r.result) { res.bridge = 'ok'; res.bridge_ms = Date.now() - t0; res.modes = (r.result.data || []).map(m => m.mode); }
    else res.bridge = r.timeout ? 'no-response' : r.error ? `error: ${r.error.message}` : r.sendError ? `send-error: ${r.sendError}` : 'unexpected';
  }
  res.ready = res.bridge === 'ok';
  if (!res.ready) res.next = `The app's internal Codex channel did not answer (${res.bridge}). This ChatGPT version (${version || 'unknown'}) is not compatible with the codex_* tools; the window tools (send_message, read_chat, ...) may still work.`;
  else if (res.version_status !== 'tested') res.warning = `ChatGPT ${version || '(unknown version)'} has not been tested with this plugin (tested: ${TESTED_APP_VERSIONS.join(', ')}). The channel answered, so the codex_* tools should work, but check results.`;
  preflightCache = { targetId: main.id, result: res };
  return { ...out, ...res };
}

// Call the app's Codex app-server. Runs the preflight once per window.
async function appServer(method, params, timeoutMs = 30000) {
  const pf = await preflight({ launch: true });
  if (!pf.ready) throw new Error(pf.next || 'ChatGPT is not ready.');
  const r = await evaluate(pageBridgeRequest, method, params, timeoutMs);
  if (r.bridgeMissing) { preflightCache = null; throw new Error('The ChatGPT window has no internal Codex channel (bridge missing).'); }
  if (r.timeout) throw new Error(`${method}: no answer from ChatGPT within ${Math.round(timeoutMs / 1000)} s.`);
  if (r.sendError) throw new Error(`${method}: ${r.sendError}`);
  if (r.error) throw new Error(`${method}: ${r.error.message || JSON.stringify(r.error)}`);
  return r.result;
}

const tid = id => String(id || '').replace(/^local:/, '');
const clip = (s, n) => (s == null ? s : String(s).length > n ? String(s).slice(0, n) + `… [${String(s).length - n} more chars]` : String(s));

function formatItem(it) {
  switch (it.type) {
    case 'userMessage': return { type: 'user', text: (it.content || []).map(c => c.text || c.url || c.path || '').join('\n') };
    case 'agentMessage': return { type: it.phase === 'final_answer' ? 'reply' : 'note', text: it.text };
    case 'plan': return { type: 'plan', text: it.text };
    case 'reasoning': { const s = (it.summary || []).map(x => typeof x === 'string' ? x : x.text).filter(Boolean).join('\n'); return s ? { type: 'reasoning', text: s } : null; }
    case 'commandExecution': return { type: 'command', command: it.command, cwd: it.cwd, status: it.status, exit_code: it.exitCode, output: clip(it.aggregatedOutput, 2000) };
    case 'fileChange': return { type: 'file_change', status: it.status, files: (it.changes || []).map(c => `${c.kind?.type || c.kind || ''} ${c.path}`.trim()) };
    case 'mcpToolCall': return { type: 'tool_call', server: it.server, tool: it.tool, status: it.status };
    case 'webSearch': return { type: 'web_search', query: it.query };
    default: return { type: it.type, data: clip(JSON.stringify(it), 300) };
  }
}

function formatTurn(t) {
  const items = (t.items || []).map(formatItem).filter(Boolean);
  const reply = [...items].reverse().find(i => i.type === 'reply' || i.type === 'plan');
  return { turn_id: t.id, status: t.status, error: t.error || undefined, duration_ms: t.durationMs ?? undefined, reply: reply?.text ?? null, items };
}

async function latestTurns(threadId, limit, itemsView = 'full') {
  const r = await appServer('thread/turns/list', { threadId, limit, itemsView });
  return r.data || [];
}

async function threadInfo(threadId) {
  const r = await appServer('thread/read', { threadId });
  const t = r.thread || {};
  return { id: t.id, name: t.name, preview: t.preview, cwd: t.cwd, model: t.model, status: t.status };
}

async function startTurn(threadId, text, plan) {
  const params = { threadId, input: [{ type: 'text', text, text_elements: [] }] };
  if (plan !== undefined) {
    const { model } = await threadInfo(threadId);
    params.collaborationMode = { mode: plan ? 'plan' : 'default', settings: { model, developer_instructions: null } };
  }
  const r = await appServer('turn/start', params);
  if (!r?.turn?.id) throw new Error(`turn/start returned no turn id for thread ${threadId}; check codex_read before retrying, the message may have been sent.`);
  return r.turn.id;
}

async function waitTurn(threadId, turnId, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let flags = [];
  while (Date.now() < deadline) {
    await sleep(2000);
    const turns = await latestTurns(threadId, 5, 'notLoaded');
    const t = turns.find(x => x.id === turnId);
    if (t && t.status !== 'inProgress') {
      const full = (await latestTurns(threadId, 5)).find(x => x.id === turnId) || t;
      return { finished: true, ...formatTurn(full) };
    }
    try { flags = (await threadInfo(threadId)).status?.activeFlags || []; } catch {}
  }
  const cur = (await latestTurns(threadId, 5)).find(x => x.id === turnId);
  return { finished: false, ...(cur ? formatTurn(cur) : { turn_id: turnId }), waiting_on: flags.length ? flags : undefined,
    note: cur
      ? 'Still running. Check with codex_read later, or codex_interrupt to stop it.'
      : 'Target turn was not found among the latest 5 turns; completion is unknown. Check codex_read with a larger last_turns value.' };
}

// Watch several Codex threads and return as soon as one (mode 'any') or every one (mode 'all')
// has something to report:
//   finished        - thread is idle and no goal keeps it going (or the goal stayed idle past the grace time)
//   needs_attention - thread is running but blocked on something (activeFlags, e.g. an approval prompt)
//   not_loaded      - the app has no such thread loaded (wrong id, or not running)
//   error           - the thread could not be read for another reason
// A thread that is already idle when the watch starts counts as finished right away.
const GOAL_IDLE_GRACE_MS = 15000;
async function watchThreads(ids, { mode = 'any', timeoutSec = 3600, intervalSec = 5 } = {}) {
  const pending = new Map(ids.map(id => [tid(id), { idleSince: 0 }]));
  const events = [];
  const deadline = Date.now() + timeoutSec * 1000;
  const report = async (threadId, kind, info, extra = {}) => {
    let last = null;
    try { const [t] = await latestTurns(threadId, 1); if (t) last = formatTurn(t); } catch {}
    events.push({
      thread_id: threadId, event: kind, name: info?.name ?? undefined, cwd: info?.cwd,
      thread_status: info?.status?.type, turn_id: last?.turn_id, turn_status: last?.status,
      reply: clip(last?.reply, 1500), ...extra,
    });
    pending.delete(threadId);
  };
  while (pending.size) {
    for (const [threadId, st] of [...pending]) {
      let info;
      try { info = await threadInfo(threadId); }
      catch (e) {
        const msg = String(e.message || e);
        events.push(/not loaded/i.test(msg)
          ? { thread_id: threadId, event: 'not_loaded', note: 'The app has no such thread loaded, so it is not running. Check the id (list_chats) before waiting on it.' }
          : { thread_id: threadId, event: 'error', error: msg });
        pending.delete(threadId);
        continue;
      }
      const type = info.status?.type;
      const flags = info.status?.activeFlags || [];
      if (type === 'active') {
        st.idleSince = 0;
        if (flags.length) await report(threadId, 'needs_attention', info, { waiting_on: flags });
        continue;
      }
      let goal = null;
      try { goal = (await appServer('thread/goal/get', { threadId })).goal || null; } catch {}
      if (goal?.status === 'active') {
        st.idleSince ||= Date.now();
        if (Date.now() - st.idleSince < GOAL_IDLE_GRACE_MS) continue;
        await report(threadId, 'finished', info, { goal_status: 'active', note: 'Idle although its goal is still active.' });
      } else {
        await report(threadId, 'finished', info, goal ? { goal_status: goal.status } : {});
      }
    }
    if (events.length && (mode === 'any' || !pending.size)) break;
    if (Date.now() >= deadline) break;
    await sleep(intervalSec * 1000);
  }
  return { events, still_running: [...pending.keys()], timed_out: pending.size > 0 && Date.now() >= deadline && (mode === 'all' || !events.length) };
}

function checkCwd(cwd) {
  if (!cwd) throw new Error('cwd is required (absolute folder path).');
  if (!isAbsolute(cwd)) throw new Error(`cwd must be an absolute path: ${cwd}`);
  if (!existsSync(cwd)) throw new Error(`Folder does not exist: ${cwd}`);
  return resolve(cwd);
}

// ------------------------------------------------------------- tools ----
async function waitForReply(beforeAssistantCount, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastText = null, stableSince = 0;
  while (Date.now() < deadline) {
    await sleep(1000);
    const st = await evaluate(pageState);
    const msgs = await evaluate(pageReadMessages);
    const assistants = msgs.filter(m => m.role === 'assistant');
    if (assistants.length > beforeAssistantCount) {
      const text = assistants[assistants.length - 1].text;
      if (text === lastText) {
        if (!st.busy && Date.now() - stableSince >= 3000) return { done: true, reply: text };
      } else { lastText = text; stableSince = Date.now(); }
    }
  }
  return { done: false, reply: lastText };
}

const tools = {
  status: {
    description: 'Check the connection to the ChatGPT desktop app and show the current window title, mode, and whether a reply is in progress.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => evaluate(pageState),
  },
  list_chats: {
    description: 'List chats (sessions) shown in the ChatGPT desktop sidebar, with their ids, titles, kind (chatgpt or codex/local) and project.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max chats to return (default 50).' } } },
    run: async ({ limit = 50 }) => evaluate(pageListChats, limit),
  },
  open_chat: {
    description: 'Open a chat in the ChatGPT window by id (from list_chats) or by title.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
    run: async ({ id, title }) => {
      if (!id && !title) throw new Error('Give id or title.');
      const r = await evaluate(pageOpenChat, id || null, title || null);
      if (!r.ok) throw new Error(r.error);
      await sleep(1500);
      return { ...r, state: await evaluate(pageState) };
    },
  },
  stop: {
    description: 'Stop the reply or agent task that is running in the open chat (clicks the Stop button), then report whether it stopped.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const clicked = await evaluate(pageClickStop);
      if (!clicked) return { stopped: false, note: 'Nothing is running in the open chat.', state: await evaluate(pageState) };
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        const st = await evaluate(pageState);
        if (!st.busy) return { stopped: true, state: st };
      }
      return { stopped: false, note: 'Clicked Stop, but the chat still shows a running turn.', state: await evaluate(pageState) };
    },
  },
  list_projects: {
    description: 'List the local (folder-backed) projects the ChatGPT desktop app knows, with their names and working directories.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => localProjects(),
  },
  new_chat: {
    description: 'Start a new chat in the ChatGPT window. Give cwd (a working directory) to start a local agent chat in the project for that folder, or project (exact sidebar name). With neither, starts a plain chat.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory, e.g. D:\\my-repo. Must be (inside) the folder of a project added in the ChatGPT app; see list_projects.' },
        project: { type: 'string', description: 'Project name as shown in the sidebar.' },
      },
    },
    run: async ({ cwd, project }) => {
      let match = null;
      if (cwd) {
        match = projectForCwd(cwd);
        if (!match) {
          const known = localProjects().map(p => `${p.name}: ${p.rootPaths.join(', ')}`).join('\n');
          throw new Error(`No ChatGPT project for "${cwd}". Add the folder as a project in the ChatGPT app first ("Add new project"). Known projects:\n${known}`);
        }
        project = match.name;
      }
      const r = await evaluate(pageNewChat, project || null);
      if (!r.ok) throw new Error(r.error);
      await sleep(1500);
      return { ok: true, project: project || null, cwd: match ? match.root : undefined, state: await evaluate(pageState) };
    },
  },
  send_message: {
    description: 'Type a message into the currently open ChatGPT chat and send it. By default waits for the reply and returns it.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string' },
        wait: { type: 'boolean', description: 'Wait for the reply (default true).' },
        timeout_sec: { type: 'number', description: 'Max seconds to wait for the reply (default 300).' },
      },
    },
    run: async ({ text, wait = true, timeout_sec = 300 }) => {
      const before = (await evaluate(pageReadMessages)).filter(m => m.role === 'assistant').length;
      if (!(await evaluate(pageFocusComposer))) throw new Error('Message box not found. Open or create a chat first.');
      const { call } = await cdp();
      await call('Input.insertText', { text });
      await sleep(400);
      const s = await evaluate(pageClickSend);
      if (!s.ok) {
        // fall back to Enter
        await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      }
      if (!wait) return { sent: true };
      const r = await waitForReply(before, timeout_sec);
      let steps;
      if (r.done) { try { const turns = await evaluate(pageReadSteps, true); const last = turns[turns.length - 1]; if (last) steps = { worked: last.worked, steps: last.steps }; } catch {} }
      return { sent: true, finished: r.done, reply: r.reply ?? null, steps, note: r.done ? undefined : 'Timed out; call read_chat later for the full reply.' };
    },
  },
  read_chat: {
    description: 'Read the messages of the currently open ChatGPT chat (the turns rendered in the window; very long chats may show only recent turns). With include_steps, also expands each reply\'s "Worked for ..." block and returns the agent\'s interim notes and actions (e.g. "Ran a command"). The app may not show the exact command text.',
    inputSchema: { type: 'object', properties: {
      last_n: { type: 'number', description: 'Only return the last N messages.' },
      include_steps: { type: 'boolean', description: 'Also return intermediate steps per turn (default false). Expands the collapsed blocks in the window.' },
    } },
    run: async ({ last_n, include_steps = false }) => {
      const turns = include_steps ? await evaluate(pageReadSteps, true) : null;
      const msgs = await evaluate(pageReadMessages);
      const st = await evaluate(pageState);
      const out = { title: st.title, busy: st.busy, messages: last_n ? msgs.slice(-last_n) : msgs };
      if (turns) out.turns = last_n ? turns.slice(-Math.ceil(last_n / 2)) : turns;
      return out;
    },
  },

  // ---- pre-run check
  preflight: {
    description: 'Check before use: is ChatGPT running, is the debugging port open, which ChatGPT version it is and whether this plugin was tested with it, and whether the internal Codex channel (used by the codex_* tools) answers. Does not start or restart anything. If ChatGPT runs without the debugging port, ask the user before calling restart_chatgpt.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => { preflightCache = null; return preflight({ launch: false }); },
  },
  restart_chatgpt: {
    description: 'Restart the ChatGPT desktop app with the debugging port. This closes the ChatGPT window and interrupts any reply or task running in it, so only call it after the user agreed, and pass confirm: true.',
    inputSchema: { type: 'object', required: ['confirm'], properties: { confirm: { type: 'boolean', description: 'Must be true: the user agreed to the restart.' } } },
    run: async ({ confirm }) => {
      if (confirm !== true) throw new Error('Not restarted: ask the user first, then call again with confirm: true.');
      if (await fetchMain()) return { restarted: false, note: 'ChatGPT already has the debugging port open; nothing to do.', ...(await preflight()) };
      const r = await launchChatGPT(true);
      if (!r.ok) throw new Error(`Restart failed: ${r.out.trim()}`);
      preflightCache = null;
      await mainTarget();
      await cdp();
      return { restarted: true, ...(await preflight()) };
    },
  },

  // ---- background control through the app's own Codex app-server (shown live in the window)
  codex_new_thread: {
    description: 'Create a Codex (local agent) thread in the ChatGPT desktop app for a working folder, without clicking anything; it appears in the sidebar right away. Optionally sends a first message (in plan mode if plan: true) and waits for the reply. Default sandbox is read-only; ask the user before using workspace-write or danger-full-access. Approval prompts show in the ChatGPT window for the user.',
    inputSchema: {
      type: 'object', required: ['cwd'],
      properties: {
        cwd: { type: 'string', description: 'Absolute working folder for the agent, e.g. D:\\my-repo.' },
        prompt: { type: 'string', description: 'Optional first message.' },
        plan: { type: 'boolean', description: 'Send the first message in plan mode (the agent plans, does not execute).' },
        sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: 'Default read-only.' },
        approval_policy: { type: 'string', enum: ['untrusted', 'on-request', 'never'], description: 'When the agent must ask for approval (default on-request; prompts appear in the window).' },
        wait: { type: 'boolean', description: 'Wait for the first reply (default true).' },
        timeout_sec: { type: 'number', description: 'Max seconds to wait (default 600).' },
        open: { type: 'boolean', description: 'Also open the thread in the window (default false, so the user\'s current view is not changed).' },
      },
    },
    run: async ({ cwd, prompt, plan, sandbox = 'read-only', approval_policy = 'on-request', wait = true, timeout_sec = 600, open = false }) => {
      const dir = checkCwd(cwd);
      const r = await appServer('thread/start', { cwd: dir, sandbox, approvalPolicy: approval_policy });
      const threadId = r.thread?.id;
      if (!threadId) throw new Error('thread/start returned no thread id.');
      const out = { thread_id: threadId, sidebar_id: `local:${threadId}`, cwd: r.cwd || dir, model: r.model, sandbox };
      if (prompt) {
        out.turn_id = await startTurn(threadId, prompt, plan ? true : undefined);
        if (open) { await sleep(1500); try { await evaluate(pageOpenChat, `local:${threadId}`, null); out.opened = true; } catch {} }
        if (wait) Object.assign(out, await waitTurn(threadId, out.turn_id, timeout_sec));
      }
      return out;
    },
  },
  codex_send: {
    description: 'Send a message to a Codex thread (by thread_id from codex_new_thread or a "local:..." id from list_chats) through the app itself; it shows in the window live. plan: true runs this turn in plan mode, plan: false in default mode, omitted keeps the thread\'s mode. Waits for the turn to finish by default.',
    inputSchema: {
      type: 'object', required: ['thread_id', 'text'],
      properties: {
        thread_id: { type: 'string' },
        text: { type: 'string' },
        plan: { type: 'boolean' },
        wait: { type: 'boolean', description: 'Wait for the turn to finish (default true).' },
        timeout_sec: { type: 'number', description: 'Max seconds to wait (default 600).' },
      },
    },
    run: async ({ thread_id, text, plan, wait = true, timeout_sec = 600 }) => {
      const threadId = tid(thread_id);
      const turnId = await startTurn(threadId, text, plan);
      if (!wait) return { thread_id: threadId, turn_id: turnId, sent: true };
      return { thread_id: threadId, ...(await waitTurn(threadId, turnId, timeout_sec)) };
    },
  },
  codex_wait: {
    description: 'Wait for one or more Codex threads and return when the first one (mode any, default) or all of them (mode all) finish or need attention (e.g. an approval prompt). Returns each event with the latest reply. If your client can run background commands, prefer `node server.mjs wait <thread ids>` in the background: it exits on the same events and notifies you without blocking.',
    inputSchema: {
      type: 'object', required: ['thread_ids'],
      properties: {
        thread_ids: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['any', 'all'], description: 'Default any.' },
        timeout_sec: { type: 'number', description: 'Max seconds to wait (default 600).' },
      },
    },
    run: ({ thread_ids, mode = 'any', timeout_sec = 600 }) => watchThreads(thread_ids || [], { mode, timeoutSec: timeout_sec }),
  },
  codex_read: {
    description: 'Read a Codex thread\'s status and its latest turns with every step (messages, plan, commands with output, file changes, tool calls). Works whether or not the thread is open in the window.',
    inputSchema: {
      type: 'object', required: ['thread_id'],
      properties: {
        thread_id: { type: 'string' },
        last_turns: { type: 'number', description: 'How many recent turns (default 3).' },
      },
    },
    run: async ({ thread_id, last_turns = 3 }) => {
      const threadId = tid(thread_id);
      const info = await threadInfo(threadId);
      const turns = (await latestTurns(threadId, last_turns)).reverse().map(formatTurn);
      let goal = null;
      try { goal = (await appServer('thread/goal/get', { threadId })).goal || null; } catch {}
      return { ...info, goal, turns };
    },
  },
  codex_interrupt: {
    description: 'Stop the turn running in a Codex thread (same as pressing Stop in the window), then confirm it stopped. An active goal stays set; use codex_goal_clear or codex_goal_set with status paused to stop it continuing.',
    inputSchema: { type: 'object', required: ['thread_id'], properties: { thread_id: { type: 'string' } } },
    run: async ({ thread_id }) => {
      const threadId = tid(thread_id);
      const running = (await latestTurns(threadId, 3, 'notLoaded')).find(t => t.status === 'inProgress');
      if (!running) return { interrupted: false, note: 'No turn is running in this thread.' };
      await appServer('turn/interrupt', { threadId, turnId: running.id });
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        const t = (await latestTurns(threadId, 3, 'notLoaded')).find(x => x.id === running.id);
        if (t && t.status !== 'inProgress') return { interrupted: true, turn_id: running.id, status: t.status };
      }
      return { interrupted: false, turn_id: running.id, note: 'Interrupt sent, but the turn still shows as running.' };
    },
  },
  codex_goal_set: {
    description: 'Set (or update) the goal of a Codex thread. With status active, the agent keeps working turn after turn until it marks the goal complete; it shows as "Pursuing goal" in the window. Use status paused to pause it. Start the work with codex_send if no turn is running.',
    inputSchema: {
      type: 'object', required: ['thread_id'],
      properties: {
        thread_id: { type: 'string' },
        objective: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused', 'complete'], description: 'Default active.' },
        token_budget: { type: 'number', description: 'Optional token budget for the goal.' },
      },
    },
    run: async ({ thread_id, objective, status = 'active', token_budget }) => {
      const params = { threadId: tid(thread_id), status, origin: 'user' };
      if (objective !== undefined) params.objective = objective;
      if (token_budget !== undefined) params.tokenBudget = token_budget;
      return (await appServer('thread/goal/set', params)).goal;
    },
  },
  codex_goal_get: {
    description: 'Show a Codex thread\'s goal: objective, status (active, paused, blocked, usageLimited, budgetLimited, complete), tokens and time used.',
    inputSchema: { type: 'object', required: ['thread_id'], properties: { thread_id: { type: 'string' } } },
    run: async ({ thread_id }) => (await appServer('thread/goal/get', { threadId: tid(thread_id) })).goal || null,
  },
  codex_goal_clear: {
    description: 'Remove a Codex thread\'s goal so it stops continuing on its own. Does not stop a turn that is already running (use codex_interrupt).',
    inputSchema: { type: 'object', required: ['thread_id'], properties: { thread_id: { type: 'string' } } },
    run: async ({ thread_id }) => appServer('thread/goal/clear', { threadId: tid(thread_id) }),
  },
};

// --------------------------------------------------------- MCP stdio ----
const send = obj => process.stdout.write(JSON.stringify(obj) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'chatgpt-desktop', version: '0.4.0' },
    } });
  }
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } });
  }
  if (method === 'tools/call') {
    const t = tools[params?.name];
    if (!t) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
    try {
      const out = await t.run(params.arguments || {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String(e.message || e) }] } });
    }
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (id !== undefined && !method?.startsWith('notifications/')) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

// CLI modes:
//   node server.mjs call <tool> '<json args>'        run one tool (quick testing)
//   node server.mjs wait [--all] [--timeout SEC] [--interval SEC] <thread id>...
//       watch Codex threads; exits 0 with JSON events when the first (or, with --all, every)
//       thread finishes or needs attention, 2 on timeout, 1 on error. Run it as a background
//       command so the agent is notified when it exits.
if (process.argv[2] === 'wait') {
  const args = process.argv.slice(3), ids = [], opt = { mode: 'any' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') opt.mode = 'all';
    else if (args[i] === '--timeout') opt.timeoutSec = Number(args[++i]);
    else if (args[i] === '--interval') opt.intervalSec = Number(args[++i]);
    else ids.push(args[i]);
  }
  if (!ids.length) { console.error('usage: node server.mjs wait [--all] [--timeout SEC] [--interval SEC] <thread id>...'); process.exit(1); }
  watchThreads(ids, opt)
    .then(o => { console.log(JSON.stringify(o, null, 2)); process.exit(o.timed_out ? 2 : 0); })
    .catch(e => { console.error(e.message); process.exit(1); });
} else if (process.argv[2] === 'call') {
  const t = tools[process.argv[3]];
  if (!t) { console.error('tools:', Object.keys(tools).join(', ')); process.exit(1); }
  t.run(JSON.parse(process.argv[4] || '{}'))
    .then(o => { console.log(JSON.stringify(o, null, 2)); process.exit(0); })
    .catch(e => { console.error(e.message); process.exit(1); });
} else {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { handle(JSON.parse(line)); } catch (e) { process.stderr.write('bad message: ' + e.message + '\n'); } }
    }
  });
}
