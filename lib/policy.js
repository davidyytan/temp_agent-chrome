// Which pages the agent may open, read and act on. Every tab method checks the
// tab's current URL, so a click that lands on an unapproved site stops the
// agent there instead of letting it read the page.

import { AgentError, badRequest } from './errors.js';
import { addPendingSite, hostSite, siteMatches } from './settings.js';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i;

// Accept what a model naturally writes ("example.com/path", "localhost:3000").
export function normalizeUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw badRequest('url is required');
  if (LOCAL_HOST.test(text)) return `http://${text}`;
  if (SCHEME.test(text) && !/^[\w.-]+:\d+/.test(text)) return text;
  return `https://${text}`;
}

export function checkUrl(url, settings) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: 'invalid_url', message: `Not a valid URL: ${url}` };
  }
  if (parsed.href === 'about:blank') return { ok: true, site: null };
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'blocked_url',
      message: `The agent can only use http(s) pages, not ${parsed.protocol} URLs.`,
    };
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'chromewebstore.google.com' || (host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))) {
    return { ok: false, code: 'blocked_url', message: 'The Chrome Web Store is off-limits to the agent.' };
  }
  const site = hostSite(host);
  if (settings.allowAllSites) return { ok: true, site };
  if (settings.allowedSites.some((rule) => siteMatches(rule, host))) return { ok: true, site };
  return {
    ok: false,
    code: 'site_not_allowed',
    site,
    message:
      `Site access needed: the user has not allowed the agent on "${site}". ` +
      `Ask the user to click the Agent Chrome extension icon and allow "${site}", then retry.`,
  };
}

// Synchronous yes/no for filtering, against the cached settings. Unknown
// (settings not loaded yet) means no.
export function urlAllowed(url, settings) {
  if (!settings) return false;
  return checkUrl(url || 'about:blank', settings).ok;
}

// Throws when `url` is off-limits; an unapproved site is queued for the user
// to approve in the popup and announced through `onPending`.
export async function requireAllowed(url, settings, onPending, extraData = {}) {
  const verdict = checkUrl(url, settings);
  if (verdict.ok) return verdict;
  if (verdict.code === 'site_not_allowed') {
    await addPendingSite(verdict.site);
    onPending?.(verdict.site);
    throw new AgentError(verdict.code, verdict.message, { site: verdict.site, ...extraData });
  }
  throw new AgentError(verdict.code, verdict.message, Object.keys(extraData).length ? extraData : undefined);
}
