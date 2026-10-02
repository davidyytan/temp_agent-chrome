// Agent sessions and the tabs they own.
//
// Ownership is the tab group: a session may use exactly the tabs in its group.
// Dragging a tab out of the group takes it away from the agent; dragging one
// in hands it over. Popup windows (e.g. "Sign in with Google") cannot hold tab
// groups, so a popup opened from an agent tab is owned by id instead. State
// lives in chrome.storage.session so it survives service-worker restarts and
// is cleared when the browser restarts.

import { AGENT_WINDOW_HEIGHT, AGENT_WINDOW_WIDTH, GROUP_COLORS } from './constants.js';
import { AgentError, badRequest } from './errors.js';
import { oneLine, truncate } from './util.js';

const STORE_KEY = 'agentSessions';
const SCALES_KEY = 'screenshotScales';
const NO_GROUP = -1;
const SESSION_ID = /^[\w.:@-]{1,128}$/;
// Sessions are stored as keys of a plain object, where these names would
// reach the object's prototype instead of creating an entry.
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);

let statePromise = null;
let loadedState = null;
const groupCreation = new Map();

function loadState() {
  statePromise ??= chrome.storage.session
    .get({ [STORE_KEY]: {}, nextColor: 0, [SCALES_KEY]: {}, tabOwners: {}, endedSessions: [], stopAll: false })
    .then((stored) => {
      loadedState = {
        sessions: stored[STORE_KEY] || {},
        nextColor: stored.nextColor || 0,
        scales: stored[SCALES_KEY] || {},
        // tab id -> session id, so a closed tab can still be traced to its agent.
        tabOwners: stored.tabOwners || {},
        // Sessions the user ended from the popup; they come back paused.
        endedSessions: stored.endedSessions || [],
        // The user pressed Cancel on Chrome's debugging bar: every session,
        // including new ones, stays stopped until the user resumes one.
        stopAll: Boolean(stored.stopAll),
      };
      return loadedState;
    });
  return statePromise;
}

async function save() {
  const state = await loadState();
  await chrome.storage.session.set({
    [STORE_KEY]: state.sessions,
    nextColor: state.nextColor,
    [SCALES_KEY]: state.scales,
    tabOwners: state.tabOwners,
    endedSessions: state.endedSessions,
    stopAll: state.stopAll,
  });
}

function has(object, key) {
  return Object.hasOwn(object, key);
}

// Synchronous read for per-command checks; null before the first load.
export function peekSession(id) {
  return loadedState && has(loadedState.sessions, id) ? loadedState.sessions[id] : null;
}

export async function setStopAll(value) {
  const state = await loadState();
  state.stopAll = Boolean(value);
  await save();
}

export async function stopAllActive() {
  return (await loadState()).stopAll;
}

function cleanLabel(label, fallback) {
  return truncate(oneLine(label) || fallback, 40);
}

export function groupTitle(session) {
  return `🤖 ${session.label}`;
}

export async function ensureSession(info) {
  if (!info || typeof info.id !== 'string' || !SESSION_ID.test(info.id.trim()) || RESERVED_IDS.has(info.id.trim())) {
    throw badRequest('Request needs session.id: 1-128 letters, digits, or . _ : @ -');
  }
  const state = await loadState();
  const id = info.id.trim();
  const label = cleanLabel(info.label, id);
  let session = has(state.sessions, id) ? state.sessions[id] : null;
  if (!session) {
    const ended = state.endedSessions.includes(id);
    session = {
      id,
      label,
      color: GROUP_COLORS[state.nextColor % GROUP_COLORS.length],
      groupId: null,
      windowId: null,
      currentTabId: null,
      popupTabIds: [],
      // A session the user ended, or any session after Cancel, starts paused:
      // the user, not the agent, decides when it may use the browser again.
      paused: state.stopAll || ended,
      pausedReason: state.stopAll ? 'debugger_canceled' : ended ? 'user_ended' : null,
      createdAt: Date.now(),
    };
    state.endedSessions = state.endedSessions.filter((sessionId) => sessionId !== id);
    state.nextColor += 1;
    state.sessions[id] = session;
    await save();
  } else if (info.label && label !== session.label) {
    session.label = label;
    await save();
    if (session.groupId !== null) {
      await chrome.tabGroups.update(session.groupId, { title: groupTitle(session) }).catch(() => {});
    }
  }
  return session;
}

export async function getSession(id) {
  const state = await loadState();
  return has(state.sessions, id) ? state.sessions[id] : null;
}

export async function listSessions() {
  const state = await loadState();
  return Object.values(state.sessions).sort((a, b) => a.createdAt - b.createdAt);
}

export async function updateSession(id, patch) {
  const state = await loadState();
  if (!has(state.sessions, id)) return null;
  const session = state.sessions[id];
  Object.assign(session, patch);
  await save();
  return session;
}

export async function deleteSession(id, { endedByUser = false } = {}) {
  const state = await loadState();
  delete state.sessions[id];
  if (endedByUser && !state.endedSessions.includes(id)) state.endedSessions = [...state.endedSessions.slice(-49), id];
  await save();
}

export async function noteTabOwner(tabId, sessionId) {
  const state = await loadState();
  if (state.tabOwners[tabId] === sessionId) return;
  state.tabOwners[tabId] = sessionId;
  await save();
}

// The session a now-closed tab belonged to; forgets the tab.
export async function takeTabOwner(tabId) {
  const state = await loadState();
  const owner = has(state.tabOwners, String(tabId)) ? state.tabOwners[tabId] : null;
  if (owner !== null) {
    delete state.tabOwners[tabId];
    await save();
  }
  return owner;
}

export async function sessionForGroup(groupId) {
  if (groupId === undefined || groupId === null || groupId === NO_GROUP) return null;
  const state = await loadState();
  return Object.values(state.sessions).find((s) => s.groupId === groupId) || null;
}

// The session that owns `tab`: by tab group, or as a popup it opened.
export async function ownerOf(tab) {
  if (!tab) return null;
  const byGroup = await sessionForGroup(tab.groupId);
  if (byGroup) return byGroup;
  const state = await loadState();
  return Object.values(state.sessions).find((s) => (s.popupTabIds || []).includes(tab.id)) || null;
}

export async function sessionForTabId(tabId) {
  try {
    return await ownerOf(await chrome.tabs.get(tabId));
  } catch {
    return null;
  }
}

function owns(session, tab) {
  return (session.groupId !== null && tab.groupId === session.groupId) || (session.popupTabIds || []).includes(tab.id);
}

export async function forgetGroup(groupId) {
  const session = await sessionForGroup(groupId);
  if (session) await updateSession(session.id, { groupId: null, windowId: null, currentTabId: null });
}

// The session's group if it still exists in the browser.
export async function liveGroup(session) {
  if (session.groupId === null) return null;
  try {
    return await chrome.tabGroups.get(session.groupId);
  } catch {
    // A popup the session still owns stays its current tab.
    const keepCurrent = (session.popupTabIds || []).includes(session.currentTabId);
    await updateSession(session.id, {
      groupId: null,
      windowId: null,
      currentTabId: keepCurrent ? session.currentTabId : null,
    });
    return null;
  }
}

export async function sessionTabs(session) {
  const group = await liveGroup(session);
  const tabs = group ? await chrome.tabs.query({ groupId: group.id }) : [];
  for (const tabId of session.popupTabIds || []) {
    try {
      tabs.push(await chrome.tabs.get(tabId));
    } catch {
      // Popup already closed; forgetTabState cleans the id up.
    }
  }
  return tabs.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
}

export async function allOwnedTabIds() {
  const ids = [];
  for (const session of await listSessions()) {
    for (const tab of await sessionTabs(session)) ids.push(tab.id);
  }
  return ids;
}

// A tab the session may use: `tabId` when given, else its current tab.
export async function resolveTab(session, tabId) {
  if (tabId !== undefined && tabId !== null && tabId !== '') {
    let tab;
    try {
      tab = await chrome.tabs.get(Number(tabId));
    } catch {
      throw new AgentError('tab_not_found', `Tab ${tabId} does not exist (it may have been closed). Call tabs_list.`);
    }
    if (!owns(session, tab)) {
      throw new AgentError(
        'tab_not_owned',
        `Tab ${tabId} is not in this agent's tab group. The agent can only use its own tabs; open one with tabs_create.`,
      );
    }
    await noteTabOwner(tab.id, session.id);
    return tab;
  }
  const tabs = await sessionTabs(session);
  if (!tabs.length) {
    throw new AgentError('no_tab', 'This agent has no tabs yet. Open one with tabs_create.');
  }
  const tab = tabs.find((t) => t.id === session.currentTabId) || tabs.find((t) => t.active) || tabs[0];
  await noteTabOwner(tab.id, session.id);
  return tab;
}

export async function setCurrentTab(session, tabId) {
  if (session.currentTabId !== tabId) await updateSession(session.id, { currentTabId: tabId });
}

// New tab in the session's group. The first tab opens a new, unfocused window
// so the agent works beside the user instead of inside their window.
export async function createSessionTab(session, { active = true } = {}) {
  let group = await liveGroup(session);
  let tab;
  if (!group) {
    // Two first tabs requested at once must share one window and group.
    if (!groupCreation.has(session.id)) {
      groupCreation.set(session.id, createWindowAndGroup(session).finally(() => groupCreation.delete(session.id)));
      tab = await groupCreation.get(session.id);
    } else {
      await groupCreation.get(session.id);
      group = await liveGroup(session);
    }
  }
  if (!tab) {
    if (!group) throw new AgentError('internal_error', "Could not create the agent's tab group.");
    tab = await chrome.tabs.create({ windowId: group.windowId, url: 'about:blank', active });
    await chrome.tabs.group({ tabIds: [tab.id], groupId: group.id });
  }
  await updateSession(session.id, { currentTabId: tab.id });
  await noteTabOwner(tab.id, session.id);
  return chrome.tabs.get(tab.id);
}

async function createWindowAndGroup(session) {
  const win = await chrome.windows.create({
    url: 'about:blank',
    focused: false,
    type: 'normal',
    width: AGENT_WINDOW_WIDTH,
    height: AGENT_WINDOW_HEIGHT,
  });
  const tab = win.tabs?.[0] || (await chrome.tabs.query({ windowId: win.id }))[0];
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: win.id } });
  await chrome.tabGroups.update(groupId, { title: groupTitle(session), color: session.color, collapsed: false });
  await updateSession(session.id, { groupId, windowId: win.id });
  return tab;
}

// A tab the page opened from one of the session's tabs (target=_blank,
// window.open). Normal tabs join the group; popup windows are owned by id.
export async function adoptOpenedTab(session, tab) {
  if (owns(session, tab)) return tab;
  await noteTabOwner(tab.id, session.id);
  const win = await chrome.windows.get(tab.windowId);
  if (win.type !== 'normal') {
    await updateSession(session.id, { popupTabIds: [...(session.popupTabIds || []), tab.id] });
    return tab;
  }
  const group = await liveGroup(session);
  if (group) {
    if (tab.windowId !== group.windowId) await chrome.tabs.move(tab.id, { windowId: group.windowId, index: -1 });
    await chrome.tabs.group({ tabIds: [tab.id], groupId: group.id });
  }
  return chrome.tabs.get(tab.id);
}

// Move a tab the user chose into the session's group.
export async function adoptTab(session, tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (owns(session, tab)) return tab;
  const owner = await ownerOf(tab);
  if (owner) throw badRequest(`That tab already belongs to agent "${owner.label}".`);
  const group = await liveGroup(session);
  if (group) {
    if (tab.windowId !== group.windowId) await chrome.tabs.move(tabId, { windowId: group.windowId, index: -1 });
    await chrome.tabs.group({ tabIds: [tabId], groupId: group.id });
  } else {
    const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: groupTitle(session), color: session.color, collapsed: false });
    await updateSession(session.id, { groupId, windowId: tab.windowId });
  }
  await updateSession(session.id, { currentTabId: tabId });
  await noteTabOwner(tabId, session.id);
  return chrome.tabs.get(tabId);
}

export function tabInfo(tab, session = null) {
  if (!tab) return null;
  const info = {
    tab_id: tab.id,
    url: tab.url || tab.pendingUrl || '',
    title: tab.title || '',
    status: tab.status || 'unknown',
    active: Boolean(tab.active),
  };
  if (session) info.current = tab.id === session.currentTabId;
  return info;
}

// --- Screenshot scale -------------------------------------------------------
// Coordinates the agent sends are in the pixels of the last screenshot of that
// tab; this remembers the image-pixels-per-CSS-pixel factor to undo.

export async function setScale(tabId, scale) {
  const state = await loadState();
  state.scales[tabId] = scale;
  await save();
}

export async function getScale(tabId) {
  const state = await loadState();
  return state.scales[tabId] ?? null;
}

export async function forgetTabState(tabId) {
  const state = await loadState();
  let changed = false;
  if (tabId in state.scales) {
    delete state.scales[tabId];
    changed = true;
  }
  for (const session of Object.values(state.sessions)) {
    if (session.currentTabId === tabId) {
      session.currentTabId = null;
      changed = true;
    }
    if ((session.popupTabIds || []).includes(tabId)) {
      session.popupTabIds = session.popupTabIds.filter((id) => id !== tabId);
      changed = true;
    }
  }
  if (changed) await save();
}
