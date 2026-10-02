// Shared constants for the service worker. The bridge implements the other
// side of PROTOCOL_VERSION; see README.md for the message contract.

export const PROTOCOL_VERSION = 1;
export const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:18765/extension';
export const BRIDGE_SERVICE_NAME = 'agent-chrome-bridge';

// MV3 service workers stop after ~30s idle; WebSocket traffic inside that
// window keeps them alive (Chrome 116+), so ping well under it.
export const PING_INTERVAL_MS = 20_000;
export const KEEPALIVE_ALARM = 'agent-chrome-reconnect';
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 15_000;

// Matches agent-core's IMAGE_MAX_DIMENSION so screenshots arrive at the size
// the model is shown and coordinates need no second rescale.
export const DEFAULT_SCREENSHOT_MAX_DIMENSION = 1288;

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;

// Default agent window size: wide enough for desktop layouts, short enough to
// fit a laptop screen.
export const AGENT_WINDOW_WIDTH = 1280;
export const AGENT_WINDOW_HEIGHT = 860;

export const GROUP_COLORS = ['blue', 'purple', 'green', 'orange', 'pink', 'cyan', 'red', 'yellow'];
export const GROUP_COLOR_HEX = {
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
