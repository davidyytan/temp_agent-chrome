import { AgentError, badRequest } from './errors.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function withTimeout(promise, ms, code, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new AgentError(code, message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`Expected a number, got ${JSON.stringify(value)}`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Case-insensitive regex when `pattern` compiles, substring match otherwise.
export function textMatcher(pattern) {
  if (!pattern) return () => true;
  try {
    const re = new RegExp(pattern, 'i');
    return (text) => re.test(text);
  } catch {
    const needle = String(pattern).toLowerCase();
    return (text) => text.toLowerCase().includes(needle);
  }
}
