// chrome.debugger wrapper: attach on demand, send DevTools Protocol commands
// with timeouts, buffer console and network events per tab, and track the
// page's JavaScript dialogs and intercepted file choosers.
//
// Attaching shows Chrome's "Agent Chrome started debugging this browser" bar.
// Extensions cannot hide it; it doubles as the "agent is connected" sign, and
// it disappears when the bridge disconnects (we detach everything then).

import { DEFAULT_COMMAND_TIMEOUT_MS } from './constants.js';
import { AgentError, errorText } from './errors.js';
import { textMatcher, truncate, withTimeout } from './util.js';

const PROTOCOL_VERSION = '1.3';
const MAX_CONSOLE_ENTRIES = 300;
const MAX_NETWORK_ENTRIES = 400;
const MAX_ENTRY_TEXT = 2000;
// Attaching and enabling domains need the page's renderer, which a dialog left
// open from before (we no longer hear about it after a detach) blocks forever.
const ATTACH_STEP_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 3_000;

const attached = new Set();
const attaching = new Map();
const pageEnabled = new Set();
const capturing = new Set();
const consoleBuffers = new Map();
const networkBuffers = new Map();
const pageUrls = new Map();

// A JavaScript dialog (alert/confirm/prompt/beforeunload) freezes the page:
// every command that touches it hangs until the dialog is answered. So the
// open dialog is tracked per tab, new commands fail fast, and commands already
// in flight are interrupted when a dialog needs an answer.
const dialogs = new Map();
const inflight = new Map();
const fileChoosers = new Map();
const dragData = new Map();

// guard(tabId) throws to stop work on a tab: it runs before every command and
// attach, so an action already under way stops at its next step once the
// agent disconnects, the user takes over, or the tab leaves the agent.
const hooks = { onDialog: null, guard: null };

export function setHooks(next) {
  Object.assign(hooks, next);
}

export function isAttached(tabId) {
  return attached.has(tabId);
}

function blockedError(tabId) {
  return new AgentError(
    'page_blocked',
    `Tab ${tabId} is not responding. It is probably showing a dialog from before the agent reconnected. ` +
      'Ask the user to close it (OK or Cancel), then retry.',
  );
}

function step(promise, tabId) {
  return withTimeout(promise, ATTACH_STEP_TIMEOUT_MS, 'page_blocked', blockedError(tabId).message);
}

export async function attach(tabId) {
  hooks.guard?.(tabId);
  if (attached.has(tabId) && pageEnabled.has(tabId)) return;
  if (attaching.has(tabId)) return attaching.get(tabId);
  const pending = attachNow(tabId).finally(() => attaching.delete(tabId));
  attaching.set(tabId, pending);
  return pending;
}

async function attachNow(tabId) {
  const target = { tabId };
  if (!attached.has(tabId)) {
    try {
      await step(chrome.debugger.attach(target, PROTOCOL_VERSION), tabId);
    } catch (err) {
      if (err instanceof AgentError) throw err;
      const message = errorText(err);
      if (!/already attached/i.test(message)) {
        throw new AgentError('debugger_attach_failed', `Could not control tab ${tabId}: ${message}`);
      }
      // Either this extension attached before the service worker restarted,
      // or someone else (DevTools, another extension) holds the tab. Only the
      // first lets our commands through. The probe is answered by the browser,
      // so a blocked page cannot hang it.
      try {
        await step(chrome.debugger.sendCommand(target, 'Page.getNavigationHistory', {}), tabId);
      } catch {
        throw new AgentError(
          'debugger_busy',
          `Another debugger (DevTools or another extension) is attached to tab ${tabId}. Ask the user to close it, then retry.`,
        );
      }
    }
    attached.add(tabId);
  }
  // Page events (dialogs, file pickers, navigations) are all the agent needs
  // by default. Runtime and Network wait for console/network: pages can
  // detect an enabled Runtime domain, which bot checks on real accounts use.
  try {
    await step(chrome.debugger.sendCommand(target, 'Page.enable', {}), tabId);
  } catch (err) {
    if (err instanceof AgentError) throw err;
    throw new AgentError('cdp_error', `Page.enable: ${errorText(err)}`);
  }
  pageEnabled.add(tabId);
}

// Starts console and network capture on a tab. True when it just started.
export async function enableCapture(tabId, pageUrl) {
  await attach(tabId);
  if (capturing.has(tabId)) return false;
  await Promise.allSettled(
    ['Runtime.enable', 'Log.enable', 'Network.enable'].map((method) =>
      step(chrome.debugger.sendCommand({ tabId }, method, {}), tabId),
    ),
  );
  capturing.add(tabId);
  if (pageUrl && !pageUrls.has(tabId)) pageUrls.set(tabId, pageUrl);
  return true;
}

// Browser-side switch for file-picker interception; safe under a dialog.
export async function setFileChooserInterception(tabId, enabled) {
  if (!attached.has(tabId)) return;
  await sendUnchecked(tabId, 'Page.setInterceptFileChooserDialog', { enabled });
}

export async function send(tabId, method, params = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
  hooks.guard?.(tabId);
  await attach(tabId);
  const dialog = dialogs.get(tabId);
  if (dialog && method !== 'Page.handleJavaScriptDialog') throw dialogOpenError(dialog.info);
  try {
    return await sendRaw(tabId, method, params, timeoutMs);
  } catch (err) {
    if (err instanceof AgentError) throw err;
    const message = errorText(err);
    if (/not attached/i.test(message)) {
      attached.delete(tabId);
      pageEnabled.delete(tabId);
      await attach(tabId);
      try {
        return await sendRaw(tabId, method, params, timeoutMs);
      } catch (retryErr) {
        if (retryErr instanceof AgentError) throw retryErr;
        throw commandError(tabId, method, retryErr);
      }
    }
    throw commandError(tabId, method, err);
  }
}

function commandError(tabId, method, err) {
  const message = errorText(err);
  if (/no tab with given id|no target with given id|target closed|cannot find context/i.test(message)) {
    return new AgentError('tab_closed', `Tab ${tabId} was closed.`);
  }
  return new AgentError('cdp_error', `${method}: ${message}`);
}

function sendRaw(tabId, method, params, timeoutMs) {
  const command = chrome.debugger.sendCommand({ tabId }, method, params);
  // If something interrupts us, the command still settles later; ignore it.
  command.catch(() => {});
  let interrupt;
  const interrupted = new Promise((_, reject) => {
    interrupt = reject;
  });
  const waiting = inflight.get(tabId) || new Set();
  waiting.add(interrupt);
  inflight.set(tabId, waiting);
  return withTimeout(
    Promise.race([command, interrupted]),
    timeoutMs,
    'timeout',
    `${method} did not finish within ${Math.round(timeoutMs / 1000)}s.`,
  ).finally(() => waiting.delete(interrupt));
}

// For cleanup that must happen even while a dialog is open or the tab is
// being released (interception switches, a final mouse release): no guard, no
// dialog check, short timeout, never throws.
export async function sendUnchecked(tabId, method, params = {}) {
  try {
    await withTimeout(chrome.debugger.sendCommand({ tabId }, method, params), CLEANUP_TIMEOUT_MS, 'timeout', method);
  } catch {
    // Best effort.
  }
}

// Fail every command waiting on this tab with `error`.
export function interruptTab(tabId, error) {
  for (const interrupt of inflight.get(tabId) || []) interrupt(error);
}

export function interruptAll(error) {
  for (const tabId of inflight.keys()) interruptTab(tabId, error);
}

// Evaluate in the page's main world and return the plain value.
export async function evaluate(tabId, expression, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
  const response = await send(
    tabId,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs,
  );
  if (response.exceptionDetails) {
    throw new AgentError('js_error', exceptionText(response.exceptionDetails));
  }
  return response.result?.value;
}

export function exceptionText(details) {
  return truncate(details?.exception?.description || details?.text || 'JavaScript error', MAX_ENTRY_TEXT);
}

// --- Dialogs and file choosers ---------------------------------------------

export function pendingDialog(tabId) {
  return dialogs.get(tabId)?.info || null;
}

export function dialogOpenedAt(tabId) {
  return dialogs.get(tabId)?.at ?? null;
}

// The agent-visible description; `redact` hides text from unapproved sites.
export function redactDialog(tabId, replacement) {
  const dialog = dialogs.get(tabId);
  if (dialog) dialog.info = { ...dialog.info, ...replacement };
}

export function dialogOpenError(dialog) {
  const answer =
    dialog.type === 'prompt'
      ? 'Call handle_dialog with accept true and prompt_text, or accept false to cancel.'
      : 'Call handle_dialog with accept true (OK) or false (Cancel).';
  return new AgentError(
    'dialog_open',
    `The page is showing a ${dialog.type} dialog: "${dialog.message}". The page is frozen until it is answered. ${answer}`,
    { dialog },
  );
}

export function interruptForDialog(tabId) {
  const dialog = dialogs.get(tabId);
  if (dialog) interruptTab(tabId, dialogOpenError(dialog.info));
}

export async function answerDialog(tabId, accept, promptText) {
  const params = { accept: Boolean(accept) };
  if (typeof promptText === 'string') params.promptText = promptText;
  try {
    await withTimeout(
      chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', params),
      10_000,
      'timeout',
      'Answering the dialog timed out.',
    );
  } catch (err) {
    if (err instanceof AgentError) throw err;
    // Already answered (by the user, or it closed with the page).
    if (!/no dialog/i.test(errorText(err))) throw commandError(tabId, 'Page.handleJavaScriptDialog', err);
  }
  dialogs.delete(tabId);
}

export function takeFileChooser(tabId, since = 0) {
  const chooser = fileChoosers.get(tabId);
  if (!chooser || chooser.at < since) return null;
  return chooser;
}

export function clearFileChooser(tabId) {
  fileChoosers.delete(tabId);
}

// Data of a native drag Chrome intercepted (Input.setInterceptDrags).
export function takeDragData(tabId) {
  const data = dragData.get(tabId) || null;
  dragData.delete(tabId);
  return data;
}

function forgetTransientState(tabId) {
  attached.delete(tabId);
  pageEnabled.delete(tabId);
  capturing.delete(tabId);
  // Once detached we no longer hear dialogs close or file pickers open, so
  // forget them rather than act on stale state when we re-attach.
  dialogs.delete(tabId);
  fileChoosers.delete(tabId);
  dragData.delete(tabId);
}

export async function detach(tabId) {
  forgetTransientState(tabId);
  try {
    await withTimeout(chrome.debugger.detach({ tabId }), CLEANUP_TIMEOUT_MS, 'timeout', 'detach');
  } catch {
    // Not attached by us, or the tab is gone.
  }
}

// Detach every tab this extension holds, including ones attached before a
// service-worker restart (the in-memory set is empty then). Detach only ever
// releases our own attachment, so trying a tab DevTools holds is harmless.
export async function detachEverything() {
  const targets = await chrome.debugger.getTargets().catch(() => []);
  const tabIds = new Set([...attached, ...targets.filter((t) => t.attached && t.tabId).map((t) => t.tabId)]);
  await Promise.all([...tabIds].map((tabId) => detach(tabId)));
}

export function markDetached(tabId) {
  forgetTransientState(tabId);
}

export function forgetTab(tabId) {
  forgetTransientState(tabId);
  consoleBuffers.delete(tabId);
  networkBuffers.delete(tabId);
  pageUrls.delete(tabId);
  inflight.delete(tabId);
}

// --- Event buffers ---------------------------------------------------------

export function handleDebuggerEvent(source, method, params) {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  switch (method) {
    case 'Page.javascriptDialogOpening': {
      const info = {
        type: params.type,
        message: truncate(params.message || '', MAX_ENTRY_TEXT),
        default_prompt: params.defaultPrompt || '',
        url: params.url || '',
      };
      dialogs.set(tabId, { info, at: Date.now() });
      hooks.onDialog?.(tabId, info);
      break;
    }
    case 'Page.javascriptDialogClosed':
      dialogs.delete(tabId);
      break;
    case 'Page.fileChooserOpened':
      fileChoosers.set(tabId, {
        backendNodeId: params.backendNodeId ?? null,
        multiple: params.mode === 'selectMultiple',
        at: Date.now(),
      });
      break;
    case 'Input.dragIntercepted':
      dragData.set(tabId, params.data);
      break;
    case 'Page.frameNavigated':
      if (!params.frame?.parentId) {
        fileChoosers.delete(tabId);
        pageUrls.set(tabId, params.frame.url);
      }
      break;
    case 'Runtime.consoleAPICalled':
      pushConsole(tabId, {
        level: consoleLevel(params.type),
        source: 'console',
        text: (params.args || []).map(remoteObjectText).join(' '),
        url: params.stackTrace?.callFrames?.[0]?.url || '',
      });
      break;
    case 'Runtime.exceptionThrown':
      pushConsole(tabId, {
        level: 'error',
        source: 'exception',
        text: exceptionText(params.exceptionDetails),
        url: params.exceptionDetails?.url || '',
      });
      break;
    case 'Log.entryAdded':
      pushConsole(tabId, {
        level: consoleLevel(params.entry?.level),
        source: params.entry?.source || 'browser',
        text: params.entry?.text || '',
        url: params.entry?.url || '',
      });
      break;
    case 'Network.requestWillBeSent':
      onRequest(tabId, params);
      break;
    case 'Network.responseReceived': {
      const entry = findRequest(tabId, params.requestId);
      if (entry) {
        entry.status = params.response?.status ?? null;
        entry.mime = params.response?.mimeType || '';
        if (params.type) entry.type = params.type;
      }
      break;
    }
    case 'Network.loadingFailed': {
      const entry = findRequest(tabId, params.requestId);
      if (entry) entry.failed = params.canceled ? 'canceled' : params.errorText || 'failed';
      break;
    }
    case 'Network.loadingFinished': {
      const entry = findRequest(tabId, params.requestId);
      if (entry) entry.bytes = params.encodedDataLength ?? null;
      break;
    }
    default:
      break;
  }
}

function consoleLevel(level) {
  if (level === 'warning') return 'warn';
  if (level === 'verbose') return 'debug';
  return level || 'log';
}

function remoteObjectText(obj) {
  if (!obj) return '';
  if ('value' in obj) return typeof obj.value === 'string' ? obj.value : JSON.stringify(obj.value);
  if (obj.unserializableValue) return obj.unserializableValue;
  if (obj.description) return obj.description;
  return obj.type || '';
}

// Every entry remembers the page it came from, so reads can drop entries
// from sites the agent may not use.
function pushConsole(tabId, entry) {
  const list = consoleBuffers.get(tabId) || [];
  list.push({
    ...entry,
    text: truncate(entry.text, MAX_ENTRY_TEXT),
    page: pageUrls.get(tabId) || '',
    time: new Date().toISOString(),
  });
  if (list.length > MAX_CONSOLE_ENTRIES) list.splice(0, list.length - MAX_CONSOLE_ENTRIES);
  consoleBuffers.set(tabId, list);
}

function onRequest(tabId, params) {
  const url = params.request?.url || '';
  if (url.startsWith('data:') || url.startsWith('blob:')) return;
  const list = networkBuffers.get(tabId) || [];
  list.push({
    id: params.requestId,
    method: params.request?.method || 'GET',
    url,
    type: params.type || '',
    status: null,
    mime: '',
    failed: null,
    bytes: null,
    page: params.documentURL || pageUrls.get(tabId) || '',
    time: new Date().toISOString(),
  });
  if (list.length > MAX_NETWORK_ENTRIES) list.splice(0, list.length - MAX_NETWORK_ENTRIES);
  networkBuffers.set(tabId, list);
}

function findRequest(tabId, requestId) {
  const list = networkBuffers.get(tabId);
  if (!list) return null;
  // Redirects reuse the request id; the newest entry is the live one.
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].id === requestId) return list[i];
  }
  return null;
}

const LEVEL_RANK = { debug: 0, log: 1, info: 1, warn: 2, error: 3 };

// `pageAllowed(url)` filters out entries recorded on pages the agent may not
// use; how many were hidden is reported, never their content.
export function consoleEntries(tabId, { pattern, level, limit, clear, pageAllowed }) {
  const all = consoleBuffers.get(tabId) || [];
  const matches = textMatcher(pattern);
  const minRank = level ? (LEVEL_RANK[level] ?? 0) : 0;
  const visible = all.filter((e) => pageAllowed(e.page));
  const filtered = visible.filter((e) => (LEVEL_RANK[e.level] ?? 1) >= minRank && matches(e.text));
  if (clear) consoleBuffers.set(tabId, []);
  return { total: filtered.length, hidden: all.length - visible.length, entries: filtered.slice(-limit) };
}

export function networkEntries(tabId, { pattern, limit, clear, pageAllowed }) {
  const all = networkBuffers.get(tabId) || [];
  const matches = textMatcher(pattern);
  const visible = all.filter((e) => pageAllowed(e.page));
  const filtered = visible.filter((e) => matches(e.url));
  if (clear) networkBuffers.set(tabId, []);
  return {
    total: filtered.length,
    hidden: all.length - visible.length,
    entries: filtered.slice(-limit).map(({ id, ...rest }) => rest),
  };
}
