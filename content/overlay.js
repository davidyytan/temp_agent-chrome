// Injected into agent-owned tabs only (top frame, isolated world). Draws the
// "agent is here" frame and pill, and reports the user's own clicks and keys
// so the service worker can pause the agent when the user takes over.
(() => {
  // Injected again only when the service worker got no answer from this tab,
  // which also happens after the extension reloads (the old copy's messaging
  // is dead). So any earlier copy is torn down rather than trusted.
  globalThis.__agentChromeOverlay?.teardown();
  // A copy from before an extension reload lives in a world we cannot reach,
  // but its element is in the shared DOM.
  document.querySelectorAll('agent-chrome-overlay').forEach((el) => el.remove());

  const host = document.createElement('agent-chrome-overlay');
  // Keep our own controls out of the accessibility tree read_page reads.
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'all: initial !important; position: fixed !important; inset: 0 !important; ' +
    'pointer-events: none !important; z-index: 2147483647 !important; display: block !important;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .frame { position: fixed; inset: 0; pointer-events: none; border: 2px solid var(--c);
        box-shadow: inset 0 0 10px color-mix(in srgb, var(--c) 40%, transparent); opacity: .5;
        transition: opacity .2s ease; }
      .frame.acting { opacity: 1; border-width: 3px; animation: pulse 1.2s ease-in-out infinite; }
      .frame.paused, .frame.stopped { opacity: .85; border-style: dashed; }
      .frame.stopped { border-color: #9aa0a6; }
      .pill.stopped button { display: none; }
      @keyframes pulse { 50% { box-shadow: inset 0 0 26px color-mix(in srgb, var(--c) 70%, transparent); } }
      .pill { position: fixed; right: 12px; bottom: 12px; display: flex; align-items: center; gap: 8px;
        max-width: min(420px, 70vw); padding: 5px 5px 5px 10px; border-radius: 999px;
        background: rgba(32, 33, 36, .94); color: #fff; box-shadow: 0 2px 10px rgba(0, 0, 0, .35);
        font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        pointer-events: auto; }
      .pill.acting, .pill.acting * { pointer-events: none; }
      .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
      .acting .dot { animation: blink 1s ease-in-out infinite; }
      @keyframes blink { 50% { opacity: .3; } }
      .label { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      button { all: unset; flex: none; cursor: pointer; padding: 4px 10px; border-radius: 999px;
        background: rgba(255, 255, 255, .16); font-weight: 600; }
      button:hover { background: rgba(255, 255, 255, .28); }
      button:focus-visible { outline: 2px solid #8ab4f8; }
    </style>
    <div class="frame"></div>
    <div class="pill"><span class="dot"></span><span class="label"></span><button type="button"></button></div>`;

  const frame = root.querySelector('.frame');
  const pill = root.querySelector('.pill');
  const label = root.querySelector('.label');
  const button = root.querySelector('button');

  let state = null;
  let hidden = false;
  let lastReport = 0;

  function mount() {
    if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
  }

  function render() {
    if (!state) {
      host.remove();
      return;
    }
    mount();
    host.style.setProperty('display', hidden ? 'none' : 'block', 'important');
    host.style.setProperty('--c', state.color);
    frame.className = `frame ${state.mode}`;
    pill.className = `pill ${state.mode}`;
    if (state.mode === 'stopped') {
      label.textContent = `${state.label} is stopped · resume it from the Agent Chrome extension`;
    } else if (state.mode === 'paused') {
      label.textContent = `You have control · ${state.label} is paused`;
      button.textContent = 'Hand back';
      button.title = 'Let the agent continue';
    } else {
      label.textContent = state.mode === 'acting' ? `${state.label} is working…` : `Agent: ${state.label}`;
      button.textContent = 'Take over';
      button.title = 'Pause the agent so you can use this tab';
    }
  }

  // Resolve after the hidden state has painted, so a screenshot taken next
  // does not include the overlay.
  function afterPaint(callback) {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        callback();
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 120);
  }

  function onMessage(message, _sender, sendResponse) {
    if (message?.type === 'agent-chrome:overlay') {
      state = message.state;
      render();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'agent-chrome:overlay-visibility') {
      hidden = Boolean(message.hidden);
      render();
      if (hidden) {
        afterPaint(() => sendResponse({ ok: true }));
        return true;
      }
      sendResponse({ ok: true });
      return false;
    }
    return false;
  }
  chrome.runtime.onMessage.addListener(onMessage);

  function notify(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // Extension reloaded; this script is orphaned.
    }
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    // Page scripts can call .click() on anything they reach; only a person counts.
    if (!event.isTrusted || !state) return;
    notify({ type: 'agent-chrome:overlay-button', action: state.mode === 'paused' ? 'resume' : 'pause' });
  });

  // A person's input. The agent's own input is trusted too, so the service
  // worker discards reports that land while the agent is acting.
  function reportInput(event) {
    if (!event.isTrusted || !state || state.mode !== 'idle') return;
    if (event.composedPath().includes(host)) return;
    const now = Date.now();
    if (now - lastReport < 500) return;
    lastReport = now;
    notify({ type: 'agent-chrome:user-input', kind: event.type });
  }
  const INPUT_EVENTS = ['mousedown', 'keydown', 'touchstart'];
  for (const type of INPUT_EVENTS) {
    window.addEventListener(type, reportInput, { capture: true, passive: true });
  }

  globalThis.__agentChromeOverlay = {
    teardown() {
      for (const type of INPUT_EVENTS) window.removeEventListener(type, reportInput, { capture: true });
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {
        // Orphaned context.
      }
      host.remove();
      state = null;
    },
  };

  try {
    chrome.runtime
      .sendMessage({ type: 'agent-chrome:hello' })
      .then((initial) => {
        if (initial && !state) {
          state = initial;
          render();
        }
      })
      .catch(() => {});
  } catch {
    // Extension reloaded.
  }
})();
