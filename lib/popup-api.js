// Requests from the toolbar popup.

import { bridgeStatus, reconnectNow } from './bridge.js';
import * as control from './control.js';
import { badRequest } from './errors.js';
import { publicSession, shareTab } from './methods.js';
import * as sessions from './sessions.js';
import { allowSite, getPendingSites, getSettings, removeAllowedSite, removePendingSite, setSetting } from './settings.js';

export async function handlePopupMessage(message) {
  switch (message.type) {
    case 'popup:getState':
      return popupState();
    case 'popup:allowSite':
      return allowSite(message.site);
    case 'popup:dismissSite':
      return removePendingSite(message.site);
    case 'popup:removeAllowedSite':
      return removeAllowedSite(message.site);
    case 'popup:setSetting':
      return setSetting(message.key, message.value);
    case 'popup:pause':
      return control.pauseSession(message.sessionId, 'user_button');
    case 'popup:resume':
      return control.resumeSession(message.sessionId, 'user_button');
    case 'popup:focusTab': {
      const tab = await chrome.tabs.update(message.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return null;
    }
    case 'popup:shareTab':
      return shareTab(message.sessionId, message.tabId);
    case 'popup:endSession':
      return control.endSession(message.sessionId, { byUser: true });
    case 'popup:reconnect':
      return reconnectNow();
    default:
      throw badRequest(`Unknown popup message ${message.type}`);
  }
}

async function popupState() {
  const list = [];
  for (const session of await sessions.listSessions()) {
    const tabs = await sessions.sessionTabs(session);
    list.push({
      ...publicSession(session),
      tabs: tabs.map((t) => sessions.tabInfo(t, session)),
    });
  }
  return {
    bridge: bridgeStatus(),
    sessions: list,
    pendingSites: await getPendingSites(),
    settings: await getSettings(),
  };
}

