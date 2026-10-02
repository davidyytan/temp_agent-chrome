// Toolbar popup. Page titles and URLs are untrusted, so everything is built
// with textContent, never innerHTML.

const COLOR_HEX = {
  grey: '#5f6368',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#f9ab00',
  green: '#1e8e3e',
  pink: '#d01884',
  purple: '#9334e6',
  cyan: '#007b83',
  orange: '#fa903e',
};

const PAUSE_REASONS = {
  user_input: 'you clicked or typed in its tab',
  user_button: 'paused by you',
  user_ended: 'you ended it; it waits until you resume it',
  debugger_canceled: 'stopped with Cancel on Chrome’s debugging bar',
};

let lastRendered = '';
let bridgeConnected = false;

const $ = (id) => document.getElementById(id);

async function call(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || 'No response from the extension');
  return response.result;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'onClick') node.addEventListener('click', value);
    else if (key === 'className') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function showError(err) {
  const box = $('error');
  box.textContent = err ? String(err.message || err) : '';
  box.hidden = !err;
}

function action(type, payload) {
  return async () => {
    try {
      showError(null);
      await call(type, payload);
      await refresh();
    } catch (err) {
      showError(err);
    }
  };
}

function renderStatus(bridge) {
  const box = $('status');
  box.className = `status ${bridge.connected ? 'connected' : 'disconnected'}`;
  $('status-text').textContent = bridge.connected ? 'Agent bridge connected' : 'Bridge not running';
  box.title = bridge.connected ? bridge.url || '' : bridge.last_error || '';
}

function renderPending(pending) {
  $('pending-section').hidden = pending.length === 0;
  $('pending').replaceChildren(
    ...pending.map((site) =>
      el('li', {}, [
        el('span', { className: 'name', text: site, title: site }),
        el('span', { className: 'actions' }, [
          el('button', { text: 'Allow', title: `Allow ${site} only`, onClick: action('popup:allowSite', { site }) }),
          el('button', {
            className: 'secondary',
            text: '+ subdomains',
            title: `Allow ${site} and every subdomain (*.${site})`,
            onClick: action('popup:allowSite', { site: `*.${site}` }),
          }),
          el('button', { className: 'secondary', text: 'Dismiss', onClick: action('popup:dismissSite', { site }) }),
        ]),
      ]),
    ),
  );
}

function renderSessions(sessions) {
  $('no-sessions').hidden = sessions.length > 0;
  $('sessions').replaceChildren(...sessions.map(renderSession));
}

function renderSession(session) {
  let status;
  if (session.paused) {
    status = el('span', {
      className: 'badge paused',
      text: session.paused_reason === 'debugger_canceled' ? 'Stopped' : 'Paused',
      title: PAUSE_REASONS[session.paused_reason] || session.paused_reason || '',
    });
  } else if (!bridgeConnected) {
    status = el('span', { className: 'badge offline', text: 'Offline', title: 'No agent is connected right now.' });
  } else {
    status = el('span', { className: 'badge', text: 'Active' });
  }
  const dot = el('span', { className: 'dot' });
  dot.style.background = COLOR_HEX[session.color] || COLOR_HEX.blue;

  const tabs = session.tabs.length
    ? el(
        'ul',
        { className: 'tabs' },
        session.tabs.map((tab) =>
          el('li', {}, [
            el(
              'button',
              { className: 'tab-link', title: tab.url, onClick: action('popup:focusTab', { tabId: tab.tab_id }) },
              [document.createTextNode(`${tab.title || 'Untitled'} `), el('span', { className: 'url', text: shortUrl(tab.url) })],
            ),
          ]),
        ),
      )
    : el('p', { className: 'hint', text: 'No open tabs.' });

  const controls = [
    session.paused
      ? el('button', { text: 'Resume', onClick: action('popup:resume', { sessionId: session.id }) })
      : el('button', { className: 'secondary', text: 'Pause', onClick: action('popup:pause', { sessionId: session.id }) }),
    el('button', {
      className: 'secondary',
      text: 'Share this tab',
      title: 'Move the tab you are looking at into this agent’s group',
      onClick: shareCurrentTab(session.id),
    }),
    el('button', {
      className: 'secondary',
      text: 'End',
      title: 'Release the agent’s tabs and leave them open',
      onClick: action('popup:endSession', { sessionId: session.id }),
    }),
  ];

  return el('li', { className: 'session' }, [
    el('div', { className: 'session-head' }, [dot, el('span', { className: 'label', text: session.label }), status]),
    session.paused
      ? el('p', { className: 'hint', text: `Paused: ${PAUSE_REASONS[session.paused_reason] || session.paused_reason}.` })
      : '',
    tabs,
    el('div', { className: 'session-actions' }, controls),
  ]);
}

function shareCurrentTab(sessionId) {
  return async () => {
    try {
      showError(null);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('No active tab to share.');
      await call('popup:shareTab', { sessionId, tabId: tab.id });
      await refresh();
    } catch (err) {
      showError(err);
    }
  };
}

function shortUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch {
    return url || '';
  }
}

function renderSettings(settings) {
  $('allow-all').checked = settings.allowAllSites;
  $('allow-js').checked = settings.allowJavaScript;
  if (document.activeElement !== $('bridge-url')) $('bridge-url').value = settings.bridgeUrl;
  $('allowed').replaceChildren(
    ...settings.allowedSites.map((site) =>
      el('li', {}, [
        el('span', {
          className: 'name',
          text: site,
          title: site.startsWith('*.') ? `${site.slice(2)} and every subdomain` : `${site} (and www.${site})`,
        }),
        el('span', { className: 'actions' }, [
          el('button', { className: 'secondary', text: 'Remove', onClick: action('popup:removeAllowedSite', { site }) }),
        ]),
      ]),
    ),
  );
}

// Redraw only when something changed: redrawing replaces the buttons, and a
// redraw between mouse-down and mouse-up swallows the click.
async function refresh() {
  try {
    const state = await call('popup:getState');
    const snapshot = JSON.stringify(state);
    if (snapshot === lastRendered) return;
    lastRendered = snapshot;
    bridgeConnected = Boolean(state.bridge.connected);
    renderStatus(state.bridge);
    renderPending(state.pendingSites);
    renderSessions(state.sessions);
    renderSettings(state.settings);
  } catch (err) {
    showError(err);
  }
}

$('allow-all').addEventListener('change', (event) =>
  action('popup:setSetting', { key: 'allowAllSites', value: event.target.checked })(),
);
$('allow-js').addEventListener('change', (event) =>
  action('popup:setSetting', { key: 'allowJavaScript', value: event.target.checked })(),
);
$('add-site').addEventListener('submit', async (event) => {
  event.preventDefault();
  const site = $('site-input').value.trim();
  if (!site) return;
  await action('popup:allowSite', { site })();
  $('site-input').value = '';
});
$('bridge-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    showError(null);
    await call('popup:setSetting', { key: 'bridgeUrl', value: $('bridge-url').value });
    await call('popup:reconnect');
    await refresh();
  } catch (err) {
    showError(err);
  }
});
$('reconnect').addEventListener('click', action('popup:reconnect'));
$('extension-id').textContent = `Extension ID: ${chrome.runtime.id}`;

chrome.storage.onChanged.addListener((changes) => {
  // Screenshot scales change on every screenshot and do not show here.
  if (Object.keys(changes).some((key) => key !== 'screenshotScales')) refresh();
});
setInterval(refresh, 2000);
refresh();
