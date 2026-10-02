// The methods the bridge can call. Each request names a session; tab methods
// act on the session's current tab unless `tab_id` picks another of its tabs.
//
// `act` methods change the page and refuse while the user has taken over.
// `tab` methods resolve and site-check the tab before running, and refuse
// while the page shows a dialog unless marked `dialogSafe`.

import { emitEvent } from './bridge.js';
import * as cdp from './cdp.js';
import { DEFAULT_NAVIGATION_TIMEOUT_MS } from './constants.js';
import * as control from './control.js';
import { overlayState, pausedError, showOverlay, withActing } from './control.js';
import { AgentError, badRequest } from './errors.js';
import * as input from './input.js';
import { normalizeUrl, requireAllowed, urlAllowed } from './policy.js';
import { captureViewport } from './screenshot.js';
import * as sessions from './sessions.js';
import { allowSite, getSettings } from './settings.js';
import { documentTag, readPage, resolveRef, staleRef } from './snapshot.js';
import { clampInt, oneLine, sleep, truncate, withTimeout } from './util.js';

const METHODS = new Map();

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Act methods on one tab run one at a time: two clicks or two typings
// interleaving their input events would land text in the wrong field.
const tabQueues = new Map();

async function withTabLock(tabId, fn) {
  const previous = tabQueues.get(tabId) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => mine);
  tabQueues.set(tabId, queued);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tabQueues.get(tabId) === queued) tabQueues.delete(tabId);
  }
}

function define(name, options, fn) {
  METHODS.set(name, { tab: false, act: false, checkSite: true, dialogSafe: false, ...options, fn });
}

export function methodNames() {
  return [...METHODS.keys()];
}

export async function dispatch(request) {
  const method = METHODS.get(request.method);
  if (!method) throw new AgentError('unknown_method', `Unknown method "${request.method}".`);
  const params = request.params && typeof request.params === 'object' ? request.params : {};
  const session = await sessions.ensureSession(request.session);
  const settings = await getSettings();

  checkPaused(session, method);

  const ctx = { session, params, settings };
  if (!method.tab) return method.fn(ctx);

  ctx.tab = await sessions.resolveTab(session, params.tab_id);
  // resolveTab just confirmed the tab is in the agent's group (dragged back
  // in, for instance), so earlier work-stops on it no longer apply.
  control.unrevokeTab(ctx.tab.id);
  if (!method.act) return prepareAndRun(method, ctx);
  return withTabLock(ctx.tab.id, async () => {
    // Re-checked once our turn comes: the user may have taken over, or a
    // dialog opened, while this action waited behind another.
    checkPaused(session, method);
    ctx.tab = await sessions.resolveTab(session, ctx.tab.id);
    return prepareAndRun(method, ctx);
  });
}

function checkPaused(session, method) {
  if (session.paused && (method.act || (session.pausedReason === 'debugger_canceled' && method.tab))) {
    throw pausedError(session);
  }
}

async function prepareAndRun(method, ctx) {
  // The site first, so nothing (not even dialog text) leaks from a page the
  // agent may not use. A navigation still in progress counts too.
  if (method.checkSite) {
    await requireSite(ctx, ctx.tab.url);
    if (ctx.tab.pendingUrl) await requireSite(ctx, ctx.tab.pendingUrl);
  }
  const dialog = cdp.pendingDialog(ctx.tab.id);
  if (dialog && !method.dialogSafe) throw cdp.dialogOpenError(dialog);
  await sessions.setCurrentTab(ctx.session, ctx.tab.id);
  if (!method.act) return method.fn(ctx);
  return withActing(ctx.session, ctx.tab.id, () => runAction(method, ctx));
}

// Runs an act method and reports how the page responded: dialogs it showed,
// tabs it opened (the newest becomes the current tab), file pickers it asked
// for. An action that opens a confirm/prompt dialog succeeds, with `dialog`;
// a dialog that was already there when it started means it never ran.
async function runAction(method, ctx) {
  const tabId = ctx.tab.id;
  const started = Date.now();
  let result;
  try {
    result = await method.fn(ctx);
  } catch (err) {
    if (!(err instanceof AgentError) || err.code !== 'dialog_open') throw err;
    const dialog = cdp.pendingDialog(tabId);
    const openedByUs = dialog && (cdp.dialogOpenedAt(tabId) ?? 0) >= started;
    if (!openedByUs || (dialog.type !== 'confirm' && dialog.type !== 'prompt')) throw err;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    result = { tab: sessions.tabInfo(tab, ctx.session), dialog, note: err.message };
  }
  const notes = result.note ? [result.note] : [];

  const shown = control.dialogsSince(tabId, started);
  if (shown.length) result.dialogs_shown = shown;

  const opened = await control.tabsOpenedBy(tabId, started);
  if (opened.length) {
    const infos = [];
    for (const tab of opened) {
      const { tab: loaded } = await waitForLoad(tab.id, 10_000).catch(() => ({ tab }));
      infos.push(sessions.tabInfo(loaded, ctx.session));
    }
    const newest = infos[infos.length - 1];
    await sessions.setCurrentTab(ctx.session, newest.tab_id);
    infos[infos.length - 1].current = true;
    result.opened_tabs = infos;
    notes.push(`The page opened ${infos.length === 1 ? 'a new tab' : `${infos.length} new tabs`}; tab ${newest.tab_id} is now the current tab.`);
  }

  const chooser = cdp.takeFileChooser(tabId, started);
  if (chooser) {
    cdp.clearFileChooser(tabId);
    let ref = null;
    if (chooser.backendNodeId) {
      ref = await documentTag(tabId).then((tag) => `e${chooser.backendNodeId}-${tag}`).catch(() => null);
    }
    result.file_chooser = { ref, multiple: chooser.multiple };
    notes.push(`The page asked for ${chooser.multiple ? 'files' : 'a file'}. Call upload_file${ref ? ` with ref ${ref}` : ''}.`);
  }

  if (notes.length) result.note = notes.join(' ');
  return result;
}

function describeTab(tab, session) {
  const info = sessions.tabInfo(tab, session);
  const dialog = cdp.pendingDialog(tab.id);
  if (dialog) info.dialog = dialog;
  return info;
}

async function requireSite(ctx, url, extraData = {}) {
  return requireAllowed(
    url || 'about:blank',
    ctx.settings,
    (site) => emitEvent('site_access.requested', { session_id: ctx.session.id, data: { site } }),
    extraData,
  );
}

// A confirm or prompt blocks the page from finishing its load, so waiting
// stops there and the caller reports the dialog.
function throwIfDecisionPending(tabId) {
  const dialog = cdp.pendingDialog(tabId);
  if (dialog && (dialog.type === 'confirm' || dialog.type === 'prompt')) throw cdp.dialogOpenError(dialog);
}

async function waitForLoad(tabId, timeoutMs, minWaitMs = 0) {
  const start = Date.now();
  let sawLoading = false;
  for (;;) {
    throwIfDecisionPending(tabId);
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new AgentError('tab_closed', `Tab ${tabId} was closed.`);
    }
    if (tab.status === 'loading') sawLoading = true;
    const elapsed = Date.now() - start;
    if (tab.status === 'complete' && (sawLoading || elapsed >= minWaitMs)) return { tab, timedOut: false };
    if (elapsed >= timeoutMs) return { tab, timedOut: true };
    await sleep(100);
  }
}

// After input: give the page a moment, and if that started a navigation,
// wait for it so the next read sees the new page.
async function settle(tabId) {
  await sleep(350);
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
  if (tab.status === 'loading') ({ tab } = await waitForLoad(tabId, 15_000));
  return tab;
}

async function afterAction(ctx, extra = {}) {
  const before = ctx.tab.url;
  const tab = await settle(ctx.tab.id);
  const result = { tab: sessions.tabInfo(tab, ctx.session), ...extra };
  if (!tab) {
    result.note = 'The tab closed.';
    return result;
  }
  if (tab.url !== before) {
    result.navigated = true;
    await requireSite(ctx, tab.url, { tab: result.tab });
  }
  return result;
}

// --- Element and coordinate targeting --------------------------------------

async function viewportSize(tabId) {
  const metrics = await cdp.send(tabId, 'Page.getLayoutMetrics');
  const vp = metrics.cssLayoutViewport || metrics.layoutViewport;
  return { width: vp.clientWidth, height: vp.clientHeight };
}

async function elementCenter(tabId, ref, { scroll = true } = {}) {
  const backendNodeId = await resolveRef(tabId, ref);
  if (scroll) {
    try {
      await cdp.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
    } catch (err) {
      if (/no node/i.test(err.message)) throw staleRef(ref);
      // Some nodes cannot scroll (e.g. already fixed in place); quads still work.
    }
  }
  let quads;
  try {
    ({ quads } = await cdp.send(tabId, 'DOM.getContentQuads', { backendNodeId }));
  } catch (err) {
    if (/no node/i.test(err.message)) throw staleRef(ref);
    throw new AgentError('not_visible', `Element ${ref} has no visible box (it may be hidden). Take a screenshot or read_page again.`);
  }
  const vp = await viewportSize(tabId);
  for (const q of quads || []) {
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const left = Math.max(0, Math.min(...xs));
    const right = Math.min(vp.width, Math.max(...xs));
    const top = Math.max(0, Math.min(...ys));
    const bottom = Math.min(vp.height, Math.max(...ys));
    if (right - left >= 1 && bottom - top >= 1) {
      return { x: round1((left + right) / 2), y: round1((top + bottom) / 2) };
    }
  }
  throw new AgentError(
    'not_visible',
    `Element ${ref} is not visible in the viewport (zero size or covered by scrolling). Try scroll, or read_page again.`,
  );
}

const round1 = (n) => Math.round(n * 10) / 10;

// Chrome does not paint a page it is not showing (minimized window, another
// desktop or full-screen space, a fully covered window, locked screen). Mouse
// moves to such a page each wait about 5 s for a frame; presses, releases and
// keys do not. So clicks there skip the hover move, and the actions that are
// nothing but mouse movement (hover, drag) refuse at once.
async function requireVisible(tabId) {
  if (await pageVisible(tabId)) return;
  throw new AgentError(
    'window_hidden',
    "The agent's window is hidden (minimized, on another desktop, or fully covered), and Chrome does not deliver " +
      "mouse movement to hidden pages, so hover and drag cannot work right now. Ask the user to bring the agent's " +
      'window into view. Clicking, typing, keys, scrolling, reading and screenshots still work.',
  );
}

async function pageVisible(tabId) {
  return (await cdp.evaluate(tabId, 'document.visibilityState')) === 'visible';
}

async function resolvePoint(ctx, { required = true } = {}) {
  const point = await pointFor(ctx.tab.id, ctx.params.ref, ctx.params.coordinate);
  if (!point && required) {
    throw badRequest('Give ref (from read_page) or coordinate [x, y] (pixels in the latest screenshot).');
  }
  return point;
}

async function pointFor(tabId, ref, coordinate, { scroll = true } = {}) {
  if (ref) {
    const point = await elementCenter(tabId, ref, { scroll });
    return { ...point, target: ref };
  }
  if (Array.isArray(coordinate) && coordinate.length === 2) {
    const [x, y] = coordinate.map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw badRequest('coordinate must be [x, y] numbers');
    const scale = (await sessions.getScale(tabId)) || 1;
    return { x: round1(x / scale), y: round1(y / scale), target: `[${x}, ${y}]` };
  }
  return null;
}

async function callOnElement(tabId, ref, functionDeclaration, args = []) {
  const backendNodeId = await resolveRef(tabId, ref);
  let object;
  try {
    ({ object } = await cdp.send(tabId, 'DOM.resolveNode', { backendNodeId }));
  } catch (err) {
    if (/no node/i.test(err.message)) throw staleRef(ref);
    throw err;
  }
  const response = await cdp.send(tabId, 'Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
  });
  await cdp.send(tabId, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  if (response.exceptionDetails) throw new AgentError('js_error', cdp.exceptionText(response.exceptionDetails));
  return response.result?.value;
}

// --- Session ---------------------------------------------------------------

define('session_info', {}, async ({ session, settings }) => ({
  session: publicSession(session),
  tabs: (await sessions.sessionTabs(session)).map((t) => describeTab(t, session)),
  platform: input.PLATFORM,
  settings: { allow_all_sites: settings.allowAllSites, allow_javascript: settings.allowJavaScript },
}));

define('session_end', {}, async ({ session, params }) => {
  const { closed } = await control.endSession(session.id, { closeTabs: Boolean(params.close_tabs) });
  return { ended: true, closed_tabs: closed };
});

export function publicSession(session) {
  return {
    id: session.id,
    label: session.label,
    color: session.color,
    paused: session.paused,
    paused_reason: session.pausedReason,
  };
}

// --- Tabs ------------------------------------------------------------------

define('tabs_list', {}, async ({ session }) => ({
  tabs: (await sessions.sessionTabs(session)).map((t) => describeTab(t, session)),
}));

define('tabs_create', { act: true }, async (ctx) => {
  const url = ctx.params.url ? normalizeUrl(ctx.params.url) : null;
  if (url) await requireSite(ctx, url);
  const created = await sessions.createSessionTab(ctx.session, { active: ctx.params.active !== false });
  control.unrevokeTab(created.id);
  if (!url) return { tab: sessions.tabInfo(created, ctx.session) };
  // Attach before the first load so a dialog the page opens while loading is
  // seen (and reported) instead of silently stalling the load.
  await cdp.attach(created.id);
  // The load goes through runAction like any action, so dialogs, tabs and
  // file pickers the new page opens are reported the same way.
  const load = {
    fn: async (loadCtx) => {
      await chrome.tabs.update(created.id, { url });
      const timeout = clampInt(loadCtx.params.timeout_ms, DEFAULT_NAVIGATION_TIMEOUT_MS, 1000, 120_000);
      const { tab, timedOut } = await waitForLoad(created.id, timeout, 500);
      const info = sessions.tabInfo(tab, loadCtx.session);
      await requireSite(loadCtx, tab.url, { tab: info });
      return { tab: info, timed_out: timedOut };
    },
  };
  const loadCtx = { ...ctx, tab: created };
  return withTabLock(created.id, () => withActing(ctx.session, created.id, () => runAction(load, loadCtx)));
});

define('tabs_select', { tab: true, act: true, checkSite: false, dialogSafe: true }, async ({ tab, session }) => {
  const updated = await chrome.tabs.update(tab.id, { active: true });
  return { tab: sessions.tabInfo(updated, session) };
});

define('tabs_close', { tab: true, act: true, checkSite: false, dialogSafe: true }, async ({ tab }) => {
  await chrome.tabs.remove(tab.id);
  return { closed: tab.id };
});

// --- Navigation --------------------------------------------------------------

define('navigate', { tab: true, act: true, checkSite: false }, async (ctx) => {
  const { tab, params } = ctx;
  const action = params.action || (params.url ? 'goto' : null);
  if (!action) throw badRequest('Give url, or action "back", "forward" or "reload".');
  const timeout = clampInt(params.timeout_ms, DEFAULT_NAVIGATION_TIMEOUT_MS, 1000, 120_000);
  try {
    if (action === 'goto') {
      const url = normalizeUrl(params.url);
      await requireSite(ctx, url);
      await attachForNavigation(tab.id);
      await chrome.tabs.update(tab.id, { url });
    } else if (action === 'back') {
      await attachForNavigation(tab.id);
      await chrome.tabs.goBack(tab.id);
    } else if (action === 'forward') {
      await attachForNavigation(tab.id);
      await chrome.tabs.goForward(tab.id);
    } else if (action === 'reload') {
      await attachForNavigation(tab.id);
      await chrome.tabs.reload(tab.id);
    } else {
      throw badRequest('action must be "back", "forward" or "reload".');
    }
  } catch (err) {
    if (err instanceof AgentError) throw err;
    throw new AgentError('navigation_failed', `Could not ${action}: ${err.message || err}`);
  }
  const { tab: after, timedOut } = await waitForLoad(tab.id, timeout, 500);
  const info = sessions.tabInfo(after, ctx.session);
  await requireSite(ctx, after.url, { tab: info });
  return { tab: info, timed_out: timedOut };
});

// --- Seeing the page -----------------------------------------------------------

// Attaching first lets a dialog the next page opens be seen. A page Chrome
// will not let us attach to (chrome://, the Web Store) can still be left.
async function attachForNavigation(tabId) {
  try {
    await cdp.attach(tabId);
  } catch (err) {
    if (!['debugger_attach_failed', 'debugger_busy', 'page_blocked'].includes(err.code)) throw err;
  }
}

// Reads re-check the site afterwards: a redirect can take the tab to another
// site between the check before the read and the read itself.
async function confirmStillAllowed(ctx, url) {
  const current = url ?? (await chrome.tabs.get(ctx.tab.id).catch(() => null))?.url;
  if (typeof current === 'string') await requireSite(ctx, current);
}

define('screenshot', { tab: true }, async (ctx) => {
  const { tab, session, params } = ctx;
  const shot = await captureViewport(tab.id, params);
  await confirmStillAllowed(ctx);
  return {
    tab: sessions.tabInfo(tab, session),
    ...shot,
    note: "Coordinates for click, hover and scroll are in this image's pixels.",
  };
});

define('read_page', { tab: true }, async (ctx) => {
  const { tab, session, params } = ctx;
  const filter = params.filter || 'all';
  const maxChars = clampInt(params.max_chars, 25_000, 1000, 200_000);
  const page = await readPage(tab.id, { filter, ref: params.ref || null, maxChars });
  await confirmStillAllowed(ctx);
  return { tab: sessions.tabInfo(tab, session), ...page };
});

define('get_text', { tab: true }, async (ctx) => {
  const { tab, session, params } = ctx;
  const maxChars = clampInt(params.max_chars, 20_000, 500, 200_000);
  const page = await pageText(tab.id);
  await confirmStillAllowed(ctx, page.href);
  return {
    tab: sessions.tabInfo(tab, session),
    title: page.title,
    text: truncate(page.text, maxChars),
    truncated: page.text.length > maxChars,
    total_chars: page.text.length,
  };
});

// Runs in the extension's isolated world, so page scripts cannot fake it.
async function pageText(tabId) {
  const run = chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: () => ({
      href: location.href,
      title: document.title,
      text: (document.body || document.documentElement)?.innerText || '',
    }),
  });
  const [frame] = await withTimeout(run, 15_000, 'timeout', 'Reading the page text timed out (is a dialog open?).');
  return frame?.result || { href: 'about:blank', title: '', text: '' };
}

define('find_text', { tab: true }, async (ctx) => {
  const { tab, session, params } = ctx;
  const query = String(params.query ?? '');
  if (!query) throw badRequest('query is required.');
  const maxResults = clampInt(params.max_results, 20, 1, 100);
  const contextChars = clampInt(params.context_chars, 80, 0, 400);
  let pattern;
  try {
    pattern = new RegExp(params.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  } catch (err) {
    throw badRequest(`Bad regex: ${err.message}`);
  }
  const { text, href } = await pageText(tab.id);
  await confirmStillAllowed(ctx, href);
  const matches = [];
  let total = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    if (m[0] === '') {
      pattern.lastIndex += 1;
      continue;
    }
    total += 1;
    if (matches.length < maxResults) {
      const start = Math.max(0, m.index - contextChars);
      const end = Math.min(text.length, m.index + m[0].length + contextChars);
      matches.push({ match: m[0], context: oneLine(text.slice(start, end)), position: m.index });
    }
    if (total >= 10_000) break;
  }
  return { tab: sessions.tabInfo(tab, session), query, total, matches, truncated: total > matches.length };
});

define('wait_for', { tab: true }, async (ctx) => {
  const { tab, session, params } = ctx;
  const text = params.text ? String(params.text) : null;
  const gone = params.text_gone ? String(params.text_gone) : null;
  if (!text && !gone) {
    if (params.seconds === undefined) throw badRequest('Give text, text_gone, or seconds.');
    const ms = clampInt(Number(params.seconds) * 1000, 1000, 0, 60_000);
    await sleep(ms);
    return { tab: sessions.tabInfo(await chrome.tabs.get(tab.id), session), waited_ms: ms };
  }
  const timeout = clampInt(params.timeout_ms, 30_000, 500, 120_000);
  const start = Date.now();
  for (;;) {
    throwIfDecisionPending(tab.id);
    let content = null;
    let href = null;
    try {
      ({ text: content, href } = await pageText(tab.id));
      content = content.toLowerCase();
    } catch {
      // Mid-navigation; try again.
    }
    if (href) await confirmStillAllowed(ctx, href);
    if (content !== null) {
      const ok = (!text || content.includes(text.toLowerCase())) && (!gone || !content.includes(gone.toLowerCase()));
      if (ok) {
        return { tab: sessions.tabInfo(await chrome.tabs.get(tab.id), session), found: true, waited_ms: Date.now() - start };
      }
    }
    if (Date.now() - start >= timeout) {
      return { tab: sessions.tabInfo(await chrome.tabs.get(tab.id), session), found: false, timed_out: true };
    }
    await sleep(300);
  }
});

// Console and network capture start on a tab's first console/network call
// (an enabled Runtime domain is detectable by pages), and only entries from
// pages the agent may use are returned.
const CAPTURE_STARTED_NOTE =
  'Capture started with this call. Reload the page (navigate action "reload") to see what it logs while loading.';

define('console', { tab: true }, async (ctx) => {
  const { tab, session, params } = ctx;
  const started = await cdp.enableCapture(tab.id, tab.url);
  const limit = clampInt(params.limit, 100, 1, 300);
  const result = {
    tab: sessions.tabInfo(tab, session),
    ...cdp.consoleEntries(tab.id, {
      pattern: params.pattern,
      level: params.level,
      limit,
      clear: params.clear,
      pageAllowed: (url) => urlAllowed(url, ctx.settings),
    }),
  };
  if (started) result.note = CAPTURE_STARTED_NOTE;
  return result;
});

define('network', { tab: true }, async (ctx) => {
  const { tab, session, params } = ctx;
  const started = await cdp.enableCapture(tab.id, tab.url);
  const limit = clampInt(params.limit, 100, 1, 400);
  const result = {
    tab: sessions.tabInfo(tab, session),
    ...cdp.networkEntries(tab.id, {
      pattern: params.pattern,
      limit,
      clear: params.clear,
      pageAllowed: (url) => urlAllowed(url, ctx.settings),
    }),
  };
  if (started) result.note = CAPTURE_STARTED_NOTE;
  return result;
});

// --- Acting on the page ----------------------------------------------------------

define('click', { tab: true, act: true }, async (ctx) => {
  const { params, tab } = ctx;
  const point = await resolvePoint(ctx);
  const clickCount = clampInt(params.click_count, 1, 1, 3);
  await input.click(tab.id, point.x, point.y, {
    button: params.button || 'left',
    clickCount,
    modifiers: input.parseModifiers(params.modifiers),
    hover: await pageVisible(tab.id),
  });
  return afterAction(ctx, { clicked: point });
});

define('drag', { tab: true, act: true }, async (ctx) => {
  const { params, tab } = ctx;
  await requireVisible(tab.id);
  const from = await resolvePoint(ctx);
  // The source is in view now; scrolling to the target could move it away.
  const to = await pointFor(tab.id, params.to_ref, params.to_coordinate, { scroll: false });
  if (!to) throw badRequest('Give to_ref (from read_page) or to_coordinate [x, y] (pixels in the latest screenshot).');
  const steps = clampInt(params.steps, 12, 2, 50);
  const { nativeDrag } = await input.drag(tab.id, from, to, {
    steps,
    modifiers: input.parseModifiers(params.modifiers),
  });
  return afterAction(ctx, { dragged: { from, to }, native_drag: nativeDrag });
});

define('hover', { tab: true, act: true }, async (ctx) => {
  await requireVisible(ctx.tab.id);
  const point = await resolvePoint(ctx);
  await input.mouseMove(ctx.tab.id, point.x, point.y);
  return afterAction(ctx, { hovered: point });
});

const PLACE_CARET_AT_END = `function () {
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
    try { const n = this.value.length; this.setSelectionRange(n, n); } catch (_) {}
    return true;
  }
  if (this.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(this);
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }
  return false;
}`;

const READ_FIELD_VALUE = `function () {
  if (this instanceof HTMLInputElement && this.type === 'password') return this.value ? '(password hidden)' : '';
  if ('value' in this && typeof this.value === 'string') return this.value;
  if (this.isContentEditable) return this.innerText;
  return null;
}`;

define('type', { tab: true, act: true }, async (ctx) => {
  const { params, tab } = ctx;
  if (typeof params.text !== 'string') throw badRequest('text is required (use "" with clear to empty a field).');
  if (params.ref) {
    const point = await elementCenter(tab.id, params.ref);
    await input.click(tab.id, point.x, point.y, { hover: await pageVisible(tab.id) });
    if (!params.clear) await callOnElement(tab.id, params.ref, PLACE_CARET_AT_END);
  }
  if (params.clear) await input.pressCombo(tab.id, input.SELECT_ALL_COMBO);
  if (params.text) {
    if (params.slowly) await input.typeSlowly(tab.id, params.text);
    else await input.insertText(tab.id, params.text);
  } else if (params.clear) {
    await input.pressCombo(tab.id, 'Backspace');
  }
  if (params.submit) await input.pressCombo(tab.id, 'Enter');
  const result = await afterAction(ctx, { typed_chars: params.text.length, submitted: Boolean(params.submit) });
  if (params.ref && !result.navigated && result.tab) {
    try {
      const value = await callOnElement(tab.id, params.ref, READ_FIELD_VALUE);
      if (typeof value === 'string') result.field_value = truncate(value, 500);
    } catch {
      // The field may be gone after submit; the typing still happened.
    }
  }
  return result;
});

define('key', { tab: true, act: true }, async (ctx) => {
  const keys = String(ctx.params.keys || '').trim();
  if (!keys) throw badRequest('keys is required, e.g. "Enter", "Tab", "ctrl+a", or "Down Down Enter".');
  const repeat = clampInt(ctx.params.repeat, 1, 1, 50);
  for (let i = 0; i < repeat; i++) {
    for (const combo of keys.split(/\s+/)) await input.pressCombo(ctx.tab.id, combo);
  }
  return afterAction(ctx, { pressed: keys, repeat });
});

define('scroll', { tab: true, act: true }, async (ctx) => {
  const { params, tab } = ctx;
  if (!params.direction) {
    if (!params.ref) throw badRequest('Give direction (up, down, left, right), or ref to scroll an element into view.');
    const point = await elementCenter(tab.id, params.ref);
    return { ...(await afterAction(ctx, { scrolled_to: params.ref, at: point })), page: await scrollPosition(tab.id) };
  }
  if (!['up', 'down', 'left', 'right'].includes(params.direction)) {
    throw badRequest('direction must be up, down, left or right.');
  }
  const amount = clampInt(params.amount, 5, 1, 50);
  const delta = amount * 100;
  const dx = params.direction === 'left' ? -delta : params.direction === 'right' ? delta : 0;
  const dy = params.direction === 'up' ? -delta : params.direction === 'down' ? delta : 0;
  let outcome;
  if (params.ref) {
    outcome = await callOnElement(tab.id, params.ref, `function (dx, dy) { return (${SCROLL_FROM})(this, dx, dy); }`, [dx, dy]);
  } else {
    let point = await resolvePoint(ctx, { required: false });
    if (!point) {
      const vp = await viewportSize(tab.id);
      point = { x: round1(vp.width / 2), y: round1(vp.height / 2) };
    }
    outcome = await cdp.evaluate(tab.id, `(${SCROLL_FROM})(document.elementFromPoint(${point.x}, ${point.y}), ${dx}, ${dy})`);
  }
  const result = await afterAction(ctx, { scrolled: { direction: params.direction, amount, element: outcome.element, moved: outcome.moved } });
  if (!outcome.moved) {
    result.note = `Nothing scrolled: the ${outcome.element === 'page' ? 'page' : 'scrollable area'} is already at its ${params.direction === 'up' || params.direction === 'left' ? 'start' : 'end'}, or this part of the page does not scroll.`;
  }
  return { ...result, page: await scrollPosition(tab.id) };
});

// Scrolls the nearest scrollable box around `start` (else the page) directly.
// A synthetic mouse wheel would need Chrome to paint the page, which it does
// not for a minimized window, and a stuck wheel event blocks all later input.
// Pages that only react to wheel events (some maps and carousels) need keys
// or drag instead.
const SCROLL_FROM = `function (start, dx, dy) {
  const page = document.scrollingElement || document.documentElement;
  const scrollable = (el) => {
    const style = getComputedStyle(el);
    const y = dy !== 0 && /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
    const x = dx !== 0 && /(auto|scroll|overlay)/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
    return x || y;
  };
  let el = start;
  while (el && el !== document.body && el !== document.documentElement && !scrollable(el)) el = el.parentElement;
  const target = el && el !== document.body && el !== document.documentElement ? el : page;
  const before = [target.scrollLeft, target.scrollTop];
  target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return {
    element: target === page ? 'page' : target.tagName.toLowerCase(),
    moved: target.scrollLeft !== before[0] || target.scrollTop !== before[1],
  };
}`;

async function scrollPosition(tabId) {
  try {
    return await cdp.evaluate(
      tabId,
      '({ scroll_x: Math.round(scrollX), scroll_y: Math.round(scrollY), page_width: document.documentElement.scrollWidth, page_height: document.documentElement.scrollHeight, viewport_height: innerHeight })',
    );
  } catch {
    return null;
  }
}

const SELECT_OPTIONS = `function (values) {
  if (!(this instanceof HTMLSelectElement)) throw new Error('Element is not a <select>; click it and pick the option instead.');
  const wanted = values.map((v) => String(v).trim().toLowerCase());
  const matched = [];
  let first = true;
  for (const option of this.options) {
    const keys = [option.value, option.label, option.textContent].map((v) => String(v || '').trim().toLowerCase());
    const hit = keys.some((k) => wanted.includes(k));
    if (this.multiple) option.selected = hit;
    else if (hit && first) { option.selected = true; first = false; }
    if (hit && (this.multiple || matched.length === 0)) matched.push(option.label || option.value);
  }
  if (!matched.length) {
    const available = Array.from(this.options).slice(0, 30).map((o) => o.label || o.value);
    throw new Error('No option matched. Options: ' + available.join(' | '));
  }
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return matched;
}`;

define('select_option', { tab: true, act: true }, async (ctx) => {
  const { params, tab } = ctx;
  if (!params.ref) throw badRequest('ref of the <select> is required.');
  const values = Array.isArray(params.values) ? params.values : params.value !== undefined ? [params.value] : [];
  if (!values.length) throw badRequest('values (option values or labels) is required.');
  await elementCenter(tab.id, params.ref);
  const selected = await callOnElement(tab.id, params.ref, SELECT_OPTIONS, [values]);
  return afterAction(ctx, { selected });
});

define('handle_dialog', { tab: true, act: true, checkSite: false, dialogSafe: true }, async (ctx) => {
  const dialog = cdp.pendingDialog(ctx.tab.id);
  if (!dialog) throw new AgentError('no_dialog', 'No dialog is open on this tab.');
  if (typeof ctx.params.accept !== 'boolean') throw badRequest('accept is required: true for OK, false for Cancel.');
  const promptText = typeof ctx.params.prompt_text === 'string' ? ctx.params.prompt_text : undefined;
  await cdp.answerDialog(ctx.tab.id, ctx.params.accept, promptText);
  const answered = { type: dialog.type, message: dialog.message, accept: ctx.params.accept };
  if (promptText !== undefined) answered.prompt_text = promptText;
  return afterAction(ctx, { answered });
});

// Files arrive as base64 (the bridge reads them from disk), so uploads work
// without granting the extension file:// access and from agents in Docker.
const SET_FILES = `function (files) {
  const list = new DataTransfer();
  for (const f of files) {
    const binary = atob(f.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    list.items.add(new File([bytes], f.name, { type: f.mime || '' }));
  }
  if (this instanceof HTMLInputElement && this.type === 'file') {
    if (!this.multiple && list.files.length > 1) throw new Error('This file input takes one file.');
    this.files = list.files;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return { via: 'file input', count: list.files.length };
  }
  // A drop zone without a file input: drop the files onto it.
  for (const type of ['dragenter', 'dragover', 'drop']) {
    this.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: list }));
  }
  return { via: 'drop', count: list.files.length };
}`;

define('upload_file', { tab: true, act: true }, async (ctx) => {
  const { params, tab } = ctx;
  if (!params.ref) {
    throw badRequest('ref is required: the file input or drop zone (file_chooser.ref from the click that opened a picker, or from read_page).');
  }
  const files = Array.isArray(params.files) ? params.files : [];
  if (!files.length) throw badRequest('files is required: [{name, mime?, data (base64)}].');
  let bytes = 0;
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || !file.name || typeof file.data !== 'string') {
      throw badRequest('Each file needs a name and base64 data.');
    }
    bytes += Math.floor((file.data.length * 3) / 4);
  }
  if (bytes > MAX_UPLOAD_BYTES) throw badRequest(`Files are too large: ${MAX_UPLOAD_BYTES / 1024 / 1024} MB at most in total.`);
  const outcome = await callOnElement(tab.id, params.ref, SET_FILES, [
    files.map((f) => ({ name: f.name, mime: typeof f.mime === 'string' ? f.mime : '', data: f.data })),
  ]);
  return afterAction(ctx, { uploaded: files.map((f) => f.name), via: outcome.via });
});

define('evaluate', { tab: true, act: true }, async (ctx) => {
  if (!ctx.settings.allowJavaScript) {
    throw new AgentError(
      'javascript_disabled',
      'Running JavaScript is turned off. The user can enable it under Advanced in the Agent Chrome extension.',
    );
  }
  const expression = String(ctx.params.expression || '');
  if (!expression.trim()) throw badRequest('expression is required.');
  const response = await cdp.send(
    ctx.tab.id,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    20_000,
  );
  if (response.exceptionDetails) throw new AgentError('js_error', cdp.exceptionText(response.exceptionDetails));
  const value = response.result?.value ?? response.result?.unserializableValue ?? response.result?.description ?? null;
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  // The bridge saves a long result to a file for the agent, so it may ask for
  // far more than fits in one model message.
  const maxChars = clampInt(ctx.params.max_chars, 20_000, 1000, 10_000_000);
  const full = text ?? 'undefined';
  return { tab: sessions.tabInfo(ctx.tab, ctx.session), result: truncate(full, maxChars), total_chars: full.length };
});

// Popup "Share current tab": the user hands a tab of theirs to an agent.
export async function shareTab(sessionId, tabId) {
  const session = await sessions.getSession(sessionId);
  if (!session) throw badRequest('That agent session no longer exists.');
  const tab = await sessions.adoptTab(session, tabId);
  control.unrevokeTab(tab.id);
  // Sharing a tab is consent for the agent to use that site (exactly that
  // host, not its subdomains).
  if (tab.url && /^https?:/i.test(tab.url)) await allowSite(new URL(tab.url).hostname);
  await showOverlay(tab.id, overlayState(session));
  emitEvent('tab.shared', { session_id: session.id, data: { tab: sessions.tabInfo(tab, session) } });
  return sessions.tabInfo(tab, session);
}
