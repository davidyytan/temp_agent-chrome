// User settings (chrome.storage.local, survive restarts) and pending site
// requests (chrome.storage.session, cleared when the browser restarts).

import { DEFAULT_BRIDGE_URL } from './constants.js';
import { badRequest } from './errors.js';

export const SETTING_DEFAULTS = Object.freeze({
  bridgeUrl: DEFAULT_BRIDGE_URL,
  allowAllSites: false,
  allowedSites: [],
  allowJavaScript: false,
});

let cached = null;

export async function getSettings() {
  const stored = await chrome.storage.local.get({ ...SETTING_DEFAULTS });
  cached = {
    ...stored,
    allowedSites: Array.isArray(stored.allowedSites) ? stored.allowedSites : [],
  };
  return cached;
}

// The last settings read, for checks that must not wait (null until the
// first read, which counts as "nothing allowed").
export function cachedSettings() {
  return cached;
}

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') getSettings().catch(() => {});
});
getSettings().catch(() => {});

export async function setSetting(key, value) {
  if (!(key in SETTING_DEFAULTS) || key === 'allowedSites') throw badRequest(`Unknown setting: ${key}`);
  if (key === 'bridgeUrl') {
    const url = String(value || '').trim() || DEFAULT_BRIDGE_URL;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw badRequest('Not a valid URL.');
    }
    // The bridge drives the browser, so it must run on this machine.
    if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
      throw badRequest('The bridge URL must be ws://127.0.0.1, ws://localhost or ws://[::1] (with a port).');
    }
    await chrome.storage.local.set({ bridgeUrl: url });
    return;
  }
  await chrome.storage.local.set({ [key]: Boolean(value) });
}

// Site rules. "example.com" allows example.com and www.example.com, which are
// the same site in practice, and nothing else. "*.example.com" also allows
// every subdomain, which has to be asked for explicitly: allowing a Google
// search must not hand over mail.google.com. Ports are ignored, so
// "localhost" covers every local dev server.
export function normalizeSite(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  const wildcard = s.startsWith('*.');
  if (wildcard) s = s.slice(2);
  if (s.includes('://')) {
    try {
      s = new URL(s).hostname;
    } catch {
      return '';
    }
  }
  s = s.replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\./, '');
  if (!s || !/^[a-z0-9.\-[\]:]+$/.test(s)) return '';
  return wildcard ? `*.${s}` : s;
}

// The site a hostname belongs to, as pending requests and exact rules name it.
export function hostSite(hostname) {
  return normalizeSite(hostname).replace(/^\*\./, '');
}

export function siteMatches(rule, hostname) {
  const site = hostSite(hostname);
  if (rule.startsWith('*.')) {
    const base = rule.slice(2);
    return site === base || site.endsWith(`.${base}`);
  }
  return site === rule;
}

export async function allowSite(site) {
  const normalized = normalizeSite(site);
  if (!normalized) throw badRequest(`Not a valid site: ${site}`);
  const { allowedSites } = await getSettings();
  if (!allowedSites.includes(normalized)) {
    await chrome.storage.local.set({ allowedSites: [...allowedSites, normalized].sort() });
  }
  // Clear every pending request the new rule covers.
  const pending = (await getPendingSites()).filter((site) => !siteMatches(normalized, site));
  await chrome.storage.session.set({ pendingSites: pending });
  await updateBadge(pending.length);
  return normalized;
}

export async function removeAllowedSite(site) {
  const { allowedSites } = await getSettings();
  await chrome.storage.local.set({ allowedSites: allowedSites.filter((s) => s !== site) });
}

export async function getPendingSites() {
  const { pendingSites } = await chrome.storage.session.get({ pendingSites: [] });
  return Array.isArray(pendingSites) ? pendingSites : [];
}

export async function addPendingSite(site) {
  const pending = await getPendingSites();
  if (!pending.includes(site)) {
    pending.push(site);
    await chrome.storage.session.set({ pendingSites: pending });
  }
  await updateBadge(pending.length);
}

export async function removePendingSite(site) {
  const pending = (await getPendingSites()).filter((s) => s !== site);
  await chrome.storage.session.set({ pendingSites: pending });
  await updateBadge(pending.length);
}

async function updateBadge(count) {
  await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
}
