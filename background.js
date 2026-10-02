// Service worker entry. MV3 only delivers events to listeners registered
// synchronously at the top level, so every chrome.* listener lives here.

import { configureBridge, connect, connectAfter, emitEvent } from './lib/bridge.js';
import * as cdp from './lib/cdp.js';
import { KEEPALIVE_ALARM } from './lib/constants.js';
import * as control from './lib/control.js';
import { dispatch } from './lib/methods.js';
import { handlePopupMessage } from './lib/popup-api.js';
import * as sessions from './lib/sessions.js';

cdp.setHooks({ onDialog: control.handleDialogOpened, guard: control.guardTab });

configureBridge({
  onRequest: dispatch,
  // No agent connected: stop running work and release every tab, so Chrome's
  // debugging bar and our overlays go away until the agent comes back.
  onDisconnected: () => control.handleDisconnect(),
});

chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());

// Wakes the worker to retry while no bridge is running (alarms fire at most
// every 30s; an open WebSocket keeps the worker alive on its own).
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) connect();
});

chrome.debugger.onEvent.addListener(cdp.handleDebuggerEvent);

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  cdp.markDetached(source.tabId);
  // The user pressed Cancel on Chrome's debugging bar: stop every agent until
  // they resume one, rather than silently re-attaching.
  if (reason === 'canceled_by_user') control.handleDebuggerCanceled();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  cdp.forgetTab(tabId);
  control.forgetTab(tabId);
  await sessions.forgetTabState(tabId);
  const ownerId = await sessions.takeTabOwner(tabId);
  if (ownerId) emitEvent('tab.closed', { session_id: ownerId, data: { tab_id: tabId } });
});

chrome.tabs.onCreated.addListener((tab) => control.noteTabCreated(tab));

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' && changeInfo.groupId === undefined) return;
  const owner = await sessions.ownerOf(tab);
  if (owner) {
    if (changeInfo.groupId !== undefined) {
      control.unrevokeTab(tabId);
      await sessions.noteTabOwner(tabId, owner.id);
    }
    await control.refreshOverlay(tabId, owner);
    return;
  }
  // Out of every agent group (dragged out, or never in one): whatever the
  // agent was doing on it stops, and it is released. Harmless for tabs the
  // agent never had.
  if (changeInfo.groupId !== undefined) await control.releaseTab(tabId);
});

chrome.tabGroups.onRemoved.addListener((group) => sessions.forgetGroup(group.id));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type.startsWith('agent-chrome:') && sender.tab && !isPopupPage(sender.url)) {
    handleContentMessage(message, sender.tab).then(sendResponse, () => sendResponse(null));
    return true;
  }

  // Extension's own popup page only (also when opened in a tab); content
  // scripts report the web page's URL here, never an extension URL.
  if (message.type.startsWith('popup:') && sender.id === chrome.runtime.id && isPopupPage(sender.url)) {
    handlePopupMessage(message).then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
    );
    return true;
  }
  return false;
});

function isPopupPage(url) {
  return typeof url === 'string' && url.startsWith(chrome.runtime.getURL('popup/'));
}

async function handleContentMessage(message, tab) {
  switch (message.type) {
    case 'agent-chrome:hello': {
      const owner = await sessions.ownerOf(tab);
      return owner ? control.overlayState(owner, control.isAgentActing(tab.id) ? 'acting' : 'idle') : null;
    }
    case 'agent-chrome:user-input':
      await control.handleUserInput(tab);
      return null;
    case 'agent-chrome:overlay-button': {
      const owner = await sessions.ownerOf(tab);
      if (!owner) return null;
      if (message.action === 'resume') {
        // After Cancel on the debugging bar, resuming is a popup decision.
        if (owner.pausedReason !== 'debugger_canceled') await control.resumeSession(owner.id, 'user_button');
      } else {
        await control.pauseSession(owner.id, 'user_button', tab.id);
      }
      return null;
    }
    default:
      return null;
  }
}

// A fresh worker has no agent connected: release anything a previous one
// held, and only then let an agent connect.
connectAfter(control.cleanupAfterRestart());
connect();
