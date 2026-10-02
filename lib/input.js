// Real mouse and keyboard input through DevTools. Pages receive these as
// trusted events, the same as a person's clicks and keystrokes.

import * as cdp from './cdp.js';
import { badRequest } from './errors.js';
import { keyDefinition, macEditingCommands, MODIFIER_BITS, modifierMask, parseCombo } from './keys.js';
import { sleep } from './util.js';

const BUTTON_BITS = { left: 1, right: 2, middle: 4 };
const TEXT_SUPPRESSING = MODIFIER_BITS.Control | MODIFIER_BITS.Alt | MODIFIER_BITS.Meta;

export const IS_MAC = /Macintosh|Mac OS X/i.test(navigator.userAgent);
export const PLATFORM = IS_MAC ? 'mac' : /Windows/i.test(navigator.userAgent) ? 'windows' : 'linux';
export const SELECT_ALL_COMBO = IS_MAC ? 'Meta+a' : 'Control+a';

export function parseModifiers(list) {
  if (list === undefined || list === null) return 0;
  const names = Array.isArray(list) ? list : String(list).split(/[+,\s]+/).filter(Boolean);
  return modifierMask(parseCombo([...names, 'x'].join('+')).modifiers);
}

export async function mouseMove(tabId, x, y, modifiers = 0) {
  await cdp.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
}

// `hover: false` skips the move onto the target. On a page Chrome is not
// painting (hidden window), a mouse move waits about 5 s for a frame, while a
// press and release are delivered at once, so hidden pages click without it.
export async function click(tabId, x, y, { button = 'left', clickCount = 1, modifiers = 0, hover = true } = {}) {
  const bit = BUTTON_BITS[button];
  if (!bit) throw badRequest(`button must be left, right or middle (got ${button})`);
  if (hover) await mouseMove(tabId, x, y, modifiers);
  for (let i = 1; i <= clickCount; i++) {
    await cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons: bit,
      clickCount: i,
      modifiers,
    });
    await cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount: i,
      modifiers,
    });
  }
}

// Press at `from`, move in steps to `to`, release. Sliders, sortable lists and
// drawing follow those mouse moves. Pages using the browser's own drag and
// drop (draggable="true") never see a drop from mouse moves alone, so drags are
// intercepted: once Chrome reports one started, the rest of the gesture goes
// through Input.dispatchDragEvent with the drag's data.
export async function drag(tabId, from, to, { steps = 12, modifiers = 0 } = {}) {
  await cdp.send(tabId, 'Input.setInterceptDrags', { enabled: true });
  cdp.takeDragData(tabId);
  let data = null;
  let released = false;
  try {
    await mouseMove(tabId, from.x, from.y, modifiers);
    await cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      modifiers,
    });
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      if (data) {
        await cdp.send(tabId, 'Input.dispatchDragEvent', { type: 'dragOver', x, y, data, modifiers });
        continue;
      }
      await cdp.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, modifiers });
      // Give a native drag time to start and be reported.
      await sleep(20);
      data = cdp.takeDragData(tabId);
      if (data) await cdp.send(tabId, 'Input.dispatchDragEvent', { type: 'dragEnter', x, y, data, modifiers });
    }
    if (data) {
      await cdp.send(tabId, 'Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data, modifiers });
    } else {
      await cdp.send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: to.x,
        y: to.y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
        modifiers,
      });
      released = true;
    }
  } finally {
    // Unchecked, so it happens even if a dialog or a takeover interrupted the
    // gesture: drag interception off (or the user's own drags would be
    // swallowed), and the mouse button up.
    await cdp.sendUnchecked(tabId, 'Input.setInterceptDrags', { enabled: false });
    if (!released) {
      await cdp.sendUnchecked(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: to.x,
        y: to.y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
        modifiers,
      });
    }
  }
  return { nativeDrag: Boolean(data) };
}

export async function pressCombo(tabId, combo) {
  const { key, modifiers } = parseCombo(combo);
  const def = keyDefinition(key, modifiers);
  const mask = modifierMask(modifiers);
  const text = mask & TEXT_SUPPRESSING ? undefined : def.text;
  const base = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers: mask,
    location: def.location || 0,
  };
  await cdp.send(tabId, 'Input.dispatchKeyEvent', {
    ...base,
    type: text ? 'keyDown' : 'rawKeyDown',
    text,
    unmodifiedText: text,
    commands: IS_MAC ? macEditingCommands(def.key, mask) : undefined,
  });
  await cdp.send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

// One key event per character, for inputs that react to keystrokes
// (autocomplete, key handlers) rather than to inserted text.
export async function typeSlowly(tabId, text) {
  for (const ch of text) {
    if (ch === '\n') {
      await pressCombo(tabId, 'Enter');
      continue;
    }
    await cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
    await cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
}

export async function insertText(tabId, text) {
  await cdp.send(tabId, 'Input.insertText', { text });
}
