// Connection to the local bridge. An extension cannot accept connections, so
// it dials out: probe GET /health, then open the WebSocket, then answer the
// bridge's requests. See README.md for the message contract.

import {
  BRIDGE_SERVICE_NAME,
  PING_INTERVAL_MS,
  PROTOCOL_VERSION,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
} from './constants.js';
import { toErrorPayload } from './errors.js';
import { getSettings } from './settings.js';

let socket = null;
let connecting = false;
let pingTimer = null;
let reconnectTimer = null;
let backoffMs = RECONNECT_MIN_MS;
let handlers = { onRequest: null, onDisconnected: null };
// Startup cleanup releases tabs a previous worker held. No agent may connect
// before it finishes, or a late cleanup would detach tabs the agent is using.
let ready = Promise.resolve();

export function connectAfter(promise) {
  ready = promise.catch(() => {});
}
let status = { connected: false, url: null, last_error: null, connected_at: null, bridge: null };

export function configureBridge(next) {
  handlers = { ...handlers, ...next };
}

export function bridgeStatus() {
  return { ...status };
}

function setStatus(patch) {
  status = { ...status, ...patch };
  chrome.storage.session.set({ bridgeStatus: status }).catch(() => {});
}

export function healthUrl(wsUrl) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/health';
  url.search = '';
  return url.toString();
}

async function bridgeIsUp(wsUrl) {
  try {
    const response = await fetch(healthUrl(wsUrl), { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.service === BRIDGE_SERVICE_NAME;
  } catch {
    return false;
  }
}

export async function connect() {
  if (connecting) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  connecting = true;
  clearTimeout(reconnectTimer);
  try {
    await ready;
    const { bridgeUrl } = await getSettings();
    // A refused WebSocket logs an error on every retry; a refused fetch to the
    // health endpoint stays quiet, so only open the socket once it answers.
    if (!(await bridgeIsUp(bridgeUrl))) {
      setStatus({ connected: false, url: bridgeUrl, last_error: 'Bridge is not running' });
      scheduleReconnect();
      return;
    }
    openSocket(bridgeUrl);
  } finally {
    connecting = false;
  }
}

export function reconnectNow() {
  backoffMs = RECONNECT_MIN_MS;
  if (socket) {
    try {
      socket.close(1000, 'reconnect requested');
    } catch {
      // Already closing.
    }
    socket = null;
    clearInterval(pingTimer);
    if (status.connected) {
      setStatus({ connected: false });
      handlers.onDisconnected?.();
    }
  }
  return connect();
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
}

function openSocket(url) {
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    if (socket !== ws) return;
    backoffMs = RECONNECT_MIN_MS;
    setStatus({ connected: true, url, last_error: null, connected_at: new Date().toISOString() });
    send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      extension: { id: chrome.runtime.id, version: chrome.runtime.getManifest().version },
      browser: { user_agent: navigator.userAgent },
    });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping', ts: Date.now() }), PING_INTERVAL_MS);
  };
  ws.onmessage = (event) => {
    if (socket === ws) handleMessage(event.data);
  };
  ws.onerror = () => {
    // onclose follows with the details.
  };
  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = null;
    clearInterval(pingTimer);
    const wasConnected = status.connected;
    setStatus({ connected: false, last_error: event.reason || `Connection closed (${event.code})` });
    if (wasConnected) handlers.onDisconnected?.();
    scheduleReconnect();
  };
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

export function emitEvent(event, payload = {}) {
  send({ type: 'event', event, ...payload, time: new Date().toISOString() });
}

async function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  switch (message?.type) {
    case 'ping':
      send({ type: 'pong', ts: message.ts });
      return;
    case 'welcome':
      setStatus({ bridge: message.bridge || null });
      return;
    case 'request':
      await answer(message);
      return;
    default:
      return;
  }
}

async function answer(message) {
  try {
    const result = await handlers.onRequest(message);
    send({ type: 'response', id: message.id, ok: true, result: result ?? {} });
  } catch (err) {
    send({ type: 'response', id: message.id, ok: false, error: toErrorPayload(err) });
  }
}
