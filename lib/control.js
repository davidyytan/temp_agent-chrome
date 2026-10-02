// Who is driving: the on-page overlay, the "agent is acting" window used to
// tell agent input from the user's, pausing when the user takes over, the
// guard that stops work the moment the agent loses a tab, and what happens
// when a page opens a dialog, a tab, or a file picker.

import { bridgeStatus, emitEvent } from './bridge.js';
import * as cdp from './cdp.js';
import { GROUP_COLOR_HEX } from './constants.js';
import { AgentError } from './errors.js';
import { urlAllowed } from './policy.js';
import * as sessions from './sessions.js';
import { cachedSettings } from './settings.js';
import { withTimeout } from './util.js';

// After an action ends, input events still arriving within this window are
// the action's own echoes, not the user.
const ACTING_GRACE_MS = 1200;
const IDLE_DELAY_MS = 1500;
// Overlay messages run on the page's main thread, which a dialog or a slow
// page can block; they are cosmetic, so they never wait long.
const OVERLAY_TIMEOUT_MS = 1500;
const MAX_DIALOG_LOG = 20;

const actingCount = new Map();
const actingUntil = new Map();
const actingSession = new Map();
const idleTimers = new Map();
const dialogLog = new Map();
const openedTabs = [];
// Tabs the agent lost (dragged out of its group, session ended). Work still
// running on them stops at its next command instead of re-attaching.
const revokedTabs = new Set();

// --- Overlay -----------------------------------------------------------------

export function overlayState(session, mode = 'idle') {
  let shown = mode;
  if (session.paused) shown = session.pausedReason === 'debugger_canceled' ? 'stopped' : 'paused';
  return {
    label: session.label,
    color: GROUP_COLOR_HEX[session.color] || GROUP_COLOR_HEX.blue,
    mode: shown,
  };
}

function deliver(tabId, message) {
  return withTimeout(chrome.tabs.sendMessage(tabId, message, { frameId: 0 }), OVERLAY_TIMEOUT_MS, 'timeout', 'overlay');
}

// Show (injecting if needed) the overlay on a tab. Best effort: pages Chrome
// does not let extensions script, like chrome:// pages, just go without.
export async function showOverlay(tabId, state) {
  const message = { type: 'agent-chrome:overlay', state };
  try {
    await deliver(tabId, message);
    return true;
  } catch {
    // No overlay script in this document yet (or the page is busy).
  }
  try {
    await withTimeout(
      chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content/overlay.js'] }),
      OVERLAY_TIMEOUT_MS,
      'timeout',
      'overlay',
    );
    await deliver(tabId, message);
    return true;
  } catch {
    return false;
  }
}

export async function removeOverlay(tabId) {
  try {
    await deliver(tabId, { type: 'agent-chrome:overlay', state: null });
  } catch {
    // Nothing to remove.
  }
}

// Screenshots hide the overlay so the agent sees the page, not our chrome.
export async function setOverlayHidden(tabId, hidden) {
  try {
    await deliver(tabId, { type: 'agent-chrome:overlay-visibility', hidden });
  } catch {
    // No overlay on this page.
  }
}

export async function refreshOverlay(tabId, session) {
  return showOverlay(tabId, overlayState(session, isAgentActing(tabId) ? 'acting' : 'idle'));
}

export async function refreshSessionOverlays(session) {
  const tabs = await sessions.sessionTabs(session);
  await Promise.all(tabs.map((tab) => refreshOverlay(tab.id, session)));
}

// --- Acting and the guard ----------------------------------------------------

export function isAgentActing(tabId) {
  return (actingCount.get(tabId) || 0) > 0 || Date.now() < (actingUntil.get(tabId) || 0);
}

export function pausedError(session) {
  const why = {
    debugger_canceled: 'The user stopped the agent from Chrome\'s "debugging this browser" bar.',
    user_ended: "The user ended this agent's browser session.",
  }[session.pausedReason] || "The user has taken control of this agent's tabs.";
  return new AgentError(
    'paused',
    `${why} Do not act on the page until they hand control back (Hand back button, or Resume in the extension). ` +
      'Tell the user what you were about to do, or wait.',
    { reason: session.pausedReason },
  );
}

function disconnectedError() {
  return new AgentError('disconnected', 'The agent bridge disconnected; the browser released its tabs.');
}

// cdp hook, run before every DevTools command and attach: throws to stop work
// on a tab the agent may no longer touch. Synchronous, from in-memory state.
export function guardTab(tabId) {
  if (!bridgeStatus().connected) throw disconnectedError();
  if (revokedTabs.has(tabId)) {
    throw new AgentError('tab_not_owned', `Tab ${tabId} is no longer the agent's (moved out of its group, or the session ended).`);
  }
  const sessionId = actingSession.get(tabId);
  if (sessionId === undefined) return;
  const session = sessions.peekSession(sessionId);
  if (!session) throw new AgentError('session_ended', "This agent's browser session was ended.");
  if (session.paused) throw pausedError(session);
}

export function revokeTab(tabId, error) {
  revokedTabs.add(tabId);
  cdp.interruptTab(tabId, error);
}

export function unrevokeTab(tabId) {
  revokedTabs.delete(tabId);
}

export async function withActing(session, tabId, fn) {
  actingCount.set(tabId, (actingCount.get(tabId) || 0) + 1);
  actingSession.set(tabId, session.id);
  clearTimeout(idleTimers.get(tabId));
  // Only while the agent acts does an upload button hand the agent a file
  // input instead of opening the OS picker; the user's own clicks get the
  // real picker. (Attach errors surface on the action's first command.)
  // Then the overlay, awaited briefly so it stops taking clicks before our
  // input arrives. Both are skipped under an open dialog: the page cannot
  // answer until it closes, and the only action possible then is answering it.
  await cdp.attach(tabId).catch(() => {});
  if (!cdp.pendingDialog(tabId)) {
    await cdp.setFileChooserInterception(tabId, true);
    await showOverlay(tabId, overlayState(session, 'acting'));
  }
  try {
    return await fn();
  } finally {
    const remaining = (actingCount.get(tabId) || 1) - 1;
    if (remaining > 0) actingCount.set(tabId, remaining);
    else actingCount.delete(tabId);
    const now = Date.now();
    actingUntil.set(tabId, now + ACTING_GRACE_MS);
    for (const [id, until] of actingUntil) if (until < now - 60_000) actingUntil.delete(id);
    idleTimers.set(
      tabId,
      setTimeout(async () => {
        idleTimers.delete(tabId);
        if (actingCount.get(tabId)) return;
        actingSession.delete(tabId);
        await cdp.setFileChooserInterception(tabId, false);
        const owner = await sessions.sessionForTabId(tabId);
        if (owner) await showOverlay(tabId, overlayState(owner, 'idle'));
      }, IDLE_DELAY_MS),
    );
  }
}

export function forgetTab(tabId) {
  actingCount.delete(tabId);
  actingUntil.delete(tabId);
  actingSession.delete(tabId);
  clearTimeout(idleTimers.get(tabId));
  idleTimers.delete(tabId);
  dialogLog.delete(tabId);
  revokedTabs.delete(tabId);
}

// Stop everything running on a session's tabs (actions mid-way included).
function interruptSession(session, error, tabs) {
  for (const tab of tabs) cdp.interruptTab(tab.id, error);
  for (const [tabId, sessionId] of actingSession) if (sessionId === session.id) cdp.interruptTab(tabId, error);
}

// --- Pause and resume ----------------------------------------------------------

export async function pauseSession(sessionId, reason, tabId = null) {
  const session = await sessions.getSession(sessionId);
  if (!session) return false;
  // Cancel on the debugging bar outranks an ordinary pause: it also stops reads.
  if (session.paused && !(reason === 'debugger_canceled' && session.pausedReason !== reason)) return false;
  const updated = await sessions.updateSession(sessionId, { paused: true, pausedReason: reason });
  const tabs = await sessions.sessionTabs(updated);
  interruptSession(updated, pausedError(updated), tabs);
  emitEvent('session.paused', { session_id: sessionId, data: { reason, tab_id: tabId } });
  await Promise.all(tabs.map((tab) => cdp.setFileChooserInterception(tab.id, false)));
  await refreshSessionOverlays(updated);
  return true;
}

export async function resumeSession(sessionId, reason) {
  const session = await sessions.getSession(sessionId);
  if (!session || !session.paused) return false;
  await sessions.setStopAll(false);
  const updated = await sessions.updateSession(sessionId, { paused: false, pausedReason: null });
  emitEvent('session.resumed', { session_id: sessionId, data: { reason } });
  await refreshSessionOverlays(updated);
  return true;
}

// The user pressed Cancel on Chrome's debugging bar. Chrome has already
// detached us everywhere; every agent stops, new ones start stopped, until
// the user resumes one.
export async function handleDebuggerCanceled() {
  await sessions.setStopAll(true);
  cdp.interruptAll(new AgentError('paused', 'The user stopped the agent from Chrome\'s "debugging this browser" bar.'));
  await Promise.all((await sessions.listSessions()).map((s) => pauseSession(s.id, 'debugger_canceled')));
  await cdp.detachEverything();
}

// The content script saw a trusted mousedown/keydown/touch in an agent tab.
// Outside the agent's own action window, that is the user taking over.
export async function handleUserInput(tab) {
  if (!tab || isAgentActing(tab.id)) return;
  const session = await sessions.ownerOf(tab);
  if (session && !session.paused) await pauseSession(session.id, 'user_input', tab.id);
}

// --- Releasing tabs ----------------------------------------------------------------

// A tab left the agent (dragged out of its group): stop work on it, detach,
// and clear its overlay.
export async function releaseTab(tabId) {
  revokeTab(tabId, new AgentError('tab_not_owned', `Tab ${tabId} was taken out of the agent's group.`));
  await cdp.detach(tabId);
  await removeOverlay(tabId);
}

// End a session's use of the browser. `byUser` (popup End) makes the agent's
// next request start paused instead of quietly opening a new window.
export async function endSession(sessionId, { closeTabs = false, byUser = false } = {}) {
  const session = await sessions.getSession(sessionId);
  if (!session) return { closed: 0 };
  const tabs = await sessions.sessionTabs(session);
  const error = new AgentError('session_ended', "This agent's browser session was ended.");
  for (const tab of tabs) revokeTab(tab.id, error);
  interruptSession(session, error, tabs);
  await Promise.all(tabs.map((tab) => cdp.detach(tab.id)));
  // Cosmetic; never wait on a page that is busy.
  Promise.all(tabs.map((tab) => removeOverlay(tab.id))).catch(() => {});
  if (closeTabs && tabs.length) {
    await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
  } else if (session.groupId !== null) {
    await chrome.tabGroups.update(session.groupId, { title: `✓ ${session.label}`, color: 'grey' }).catch(() => {});
  }
  await sessions.deleteSession(sessionId, { endedByUser: byUser });
  return { closed: closeTabs ? tabs.length : 0 };
}

// No agent connected: stop all running work, release every tab, clear the
// overlays. Detaching first, in parallel, so a frozen tab cannot hold up the
// others.
export async function handleDisconnect() {
  cdp.interruptAll(disconnectedError());
  await cdp.detachEverything();
  const tabIds = await sessions.allOwnedTabIds().catch(() => []);
  Promise.all(tabIds.map((tabId) => removeOverlay(tabId))).catch(() => {});
}

// --- Dialogs -------------------------------------------------------------------
//
// alert() only informs, so it is dismissed and reported. Leaving the page
// (beforeunload) during an agent action is what the agent asked for. confirm()
// and prompt() are decisions: they stay open for the agent to answer with
// handle_dialog, which goes through agent-core's approval like any action.
// While the user has control, dialogs are theirs.

export function handleDialogOpened(tabId, dialog) {
  // Synchronous first: hide a dialog's text from the agent before anything
  // can read it, when the dialog comes from a site the agent may not use.
  if (!urlAllowed(dialog.url, cachedSettings())) {
    cdp.redactDialog(tabId, {
      message: '(hidden: the dialog comes from a site the agent is not allowed on)',
      default_prompt: '',
    });
  }
  decideDialog(tabId).catch(() => {});
}

async function decideDialog(tabId) {
  const owner = await sessions.sessionForTabId(tabId);
  const dialog = cdp.pendingDialog(tabId);
  if (!owner || !dialog) return;
  const acting = isAgentActing(tabId);
  if (owner.paused && !acting) return;
  if (dialog.type === 'alert' || (dialog.type === 'beforeunload' && acting)) {
    logDialog(tabId, { ...dialog, handled: dialog.type === 'alert' ? 'dismissed' : 'left the page' });
    try {
      await cdp.answerDialog(tabId, true);
    } catch {
      // The user answered it first.
    }
    return;
  }
  cdp.interruptForDialog(tabId);
  emitEvent('dialog.opened', { session_id: owner.id, data: { tab_id: tabId, dialog } });
}

function logDialog(tabId, entry) {
  const list = dialogLog.get(tabId) || [];
  list.push({ ...entry, at: Date.now() });
  if (list.length > MAX_DIALOG_LOG) list.splice(0, list.length - MAX_DIALOG_LOG);
  dialogLog.set(tabId, list);
}

export function dialogsSince(tabId, since) {
  return (dialogLog.get(tabId) || []).filter((d) => d.at >= since).map(({ at, ...rest }) => rest);
}

// --- Tabs the page opens ---------------------------------------------------------

const NEW_TAB_PAGES = /^chrome:\/\/(newtab|new-tab-page)/;

// Recorded synchronously in tabs.onCreated so an action that just finished
// can find the tabs it opened; adoption into the session finishes async.
// Only tabs opened while the agent is in charge are adopted: what the user
// opens from an agent tab after taking over stays theirs.
export function noteTabCreated(tab) {
  if (tab.openerTabId === undefined) return;
  if (NEW_TAB_PAGES.test(tab.pendingUrl || tab.url || '')) return;
  const openerActing = isAgentActing(tab.openerTabId);
  const entry = { tabId: tab.id, openerTabId: tab.openerTabId, at: Date.now(), adopted: null };
  entry.adopted = (async () => {
    const owner = await sessions.sessionForTabId(tab.openerTabId);
    if (!owner || (owner.paused && !openerActing)) return null;
    const adopted = await sessions.adoptOpenedTab(owner, tab);
    unrevokeTab(adopted.id);
    emitEvent('tab.opened', { session_id: owner.id, data: { tab: sessions.tabInfo(adopted, owner), opener_tab_id: tab.openerTabId } });
    return adopted;
  })().catch(() => null);
  openedTabs.push(entry);
  if (openedTabs.length > 50) openedTabs.splice(0, openedTabs.length - 50);
}

export async function tabsOpenedBy(openerTabId, since) {
  const adopted = [];
  for (const entry of openedTabs) {
    if (entry.openerTabId !== openerTabId || entry.at < since) continue;
    const tab = await entry.adopted;
    if (tab) adopted.push(tab);
  }
  return adopted;
}

// --- Service worker start ----------------------------------------------------

// A restarted worker has no bridge connection and empty in-memory state, so it
// starts from "no agent connected": release whatever the previous instance
// held and clear stale overlays (they may still say "working…").
//
// Reloading or updating the extension also wipes chrome.storage.session, so
// sessions are gone while their tab groups stay. Those groups are marked
// released ("✓ name", grey) and their pages' orphaned overlays removed, rather
// than re-claimed: after a browser restart, group and tab ids are reused, and
// re-claiming by id could hand the agent the user's own tabs.
export async function cleanupAfterRestart() {
  await cdp.detachEverything();
  const tabIds = await sessions.allOwnedTabIds().catch(() => []);
  Promise.all(tabIds.map((tabId) => removeOverlay(tabId))).catch(() => {});
  await releaseOrphanedGroups().catch(() => {});
}

async function releaseOrphanedGroups() {
  const known = new Set((await sessions.listSessions()).map((s) => s.groupId));
  const groups = await chrome.tabGroups.query({});
  for (const group of groups) {
    if (!group.title?.startsWith('🤖 ') || known.has(group.id)) continue;
    await chrome.tabGroups.update(group.id, { title: `✓ ${group.title.slice(3)}`, color: 'grey' }).catch(() => {});
    const tabs = await chrome.tabs.query({ groupId: group.id });
    await Promise.all(tabs.map((tab) => removeOrphanedOverlay(tab.id)));
  }
}

// The previous extension instance's overlay script is dead (it cannot hear
// us), but its element is still in the page; the DOM is shared, so remove it.
async function removeOrphanedOverlay(tabId) {
  try {
    await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => document.querySelectorAll('agent-chrome-overlay').forEach((el) => el.remove()),
      }),
      OVERLAY_TIMEOUT_MS,
      'timeout',
      'overlay',
    );
  } catch {
    // Page we cannot script, or busy; nothing to clean.
  }
}
