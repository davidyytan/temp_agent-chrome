// Key combos ("Enter", "ctrl+a", "cmd+shift+z", "Shift+Tab") to DevTools
// Input.dispatchKeyEvent fields.

import { badRequest } from './errors.js';

export const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const MODIFIER_ALIASES = {
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  ctrl: 'Control',
  control: 'Control',
  shift: 'Shift',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  super: 'Meta',
  win: 'Meta',
};

const SPECIAL_KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Insert: { code: 'Insert', keyCode: 45 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  Shift: { code: 'ShiftLeft', keyCode: 16, location: 1 },
  Control: { code: 'ControlLeft', keyCode: 17, location: 1 },
  Alt: { code: 'AltLeft', keyCode: 18, location: 1 },
  Meta: { code: 'MetaLeft', keyCode: 91, location: 1 },
};

const KEY_ALIASES = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  esc: 'Escape',
  escape: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  up: 'ArrowUp',
  arrowup: 'ArrowUp',
  down: 'ArrowDown',
  arrowdown: 'ArrowDown',
  left: 'ArrowLeft',
  arrowleft: 'ArrowLeft',
  right: 'ArrowRight',
  arrowright: 'ArrowRight',
  space: ' ',
  spacebar: ' ',
  shift: 'Shift',
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
};

const PUNCTUATION = {
  '-': ['Minus', 189],
  '=': ['Equal', 187],
  '[': ['BracketLeft', 219],
  ']': ['BracketRight', 221],
  '\\': ['Backslash', 220],
  ';': ['Semicolon', 186],
  "'": ['Quote', 222],
  ',': ['Comma', 188],
  '.': ['Period', 190],
  '/': ['Slash', 191],
  '`': ['Backquote', 192],
};

export function parseCombo(combo) {
  const raw = String(combo ?? '').trim();
  if (!raw) throw badRequest('Empty key combo');
  const parts = raw.split('+');
  let key = parts.pop();
  // "ctrl++" and "+" name the plus key itself.
  if (key === '' && parts.length && parts[parts.length - 1] === '') {
    parts.pop();
    key = '+';
  }
  if (!key) throw badRequest(`Bad key combo "${raw}"`);
  const modifiers = parts.map((part) => {
    const name = MODIFIER_ALIASES[part.trim().toLowerCase()];
    if (!name) throw badRequest(`Unknown modifier "${part}" in "${raw}". Use ctrl, alt, shift or cmd/meta.`);
    return name;
  });
  return { key, modifiers };
}

export function modifierMask(modifiers) {
  return modifiers.reduce((mask, name) => mask | (MODIFIER_BITS[name] || 0), 0);
}

export function keyDefinition(rawKey, modifiers) {
  const shift = modifiers.includes('Shift');
  const alias = KEY_ALIASES[rawKey.toLowerCase()];
  const named = alias ?? (SPECIAL_KEYS[rawKey] ? rawKey : null);
  if (named !== null) return { key: named, ...SPECIAL_KEYS[named] };

  const fn = /^f([1-9]|1[0-2])$/i.exec(rawKey);
  if (fn) {
    const n = Number(fn[1]);
    return { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };
  }

  if ([...rawKey].length === 1) {
    const ch = rawKey;
    if (/[a-z]/i.test(ch)) {
      const upper = ch.toUpperCase();
      const key = shift ? upper : ch;
      return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
    }
    if (/[0-9]/.test(ch)) {
      return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
    }
    if (PUNCTUATION[ch]) {
      const [code, keyCode] = PUNCTUATION[ch];
      return { key: ch, code, keyCode, text: ch };
    }
    return { key: ch, code: '', keyCode: 0, text: ch };
  }
  throw badRequest(`Unknown key "${rawKey}". Use names like Enter, Tab, Escape, Backspace, ArrowDown, F5, or a single character.`);
}

// On macOS, editing shortcuts are handled by the native menu, not the page,
// so DevTools needs the editing command spelled out for cmd+a/c/x/v/z.
export function macEditingCommands(key, mask) {
  if (!(mask & MODIFIER_BITS.Meta) || mask & (MODIFIER_BITS.Control | MODIFIER_BITS.Alt)) return undefined;
  switch (key.toLowerCase()) {
    case 'a':
      return ['selectAll'];
    case 'c':
      return ['copy'];
    case 'x':
      return ['cut'];
    case 'v':
      return ['paste'];
    case 'z':
      return mask & MODIFIER_BITS.Shift ? ['redo'] : ['undo'];
    default:
      return undefined;
  }
}
