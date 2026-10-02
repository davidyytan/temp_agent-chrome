// Viewport screenshots scaled to CSS pixels (then capped), so one number maps
// image pixels back to the coordinates DevTools input events use.

import * as cdp from './cdp.js';
import { DEFAULT_SCREENSHOT_MAX_DIMENSION } from './constants.js';
import { setOverlayHidden } from './control.js';
import { badRequest } from './errors.js';
import { setScale } from './sessions.js';
import { base64ToBytes, bytesToBase64, clampInt } from './util.js';

export async function captureViewport(tabId, params = {}) {
  const format = params.format || 'png';
  if (!['png', 'jpeg'].includes(format)) throw badRequest('format must be "png" or "jpeg"');
  const quality = clampInt(params.quality, 80, 10, 100);
  const maxDimension = clampInt(params.max_dimension, DEFAULT_SCREENSHOT_MAX_DIMENSION, 200, 4000);

  const dpr = Number(await cdp.evaluate(tabId, 'window.devicePixelRatio')) || 1;
  await setOverlayHidden(tabId, true);
  let shot;
  try {
    shot = await cdp.send(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true }, 15_000);
  } finally {
    await setOverlayHidden(tabId, false);
  }

  const bitmap = await createImageBitmap(new Blob([base64ToBytes(shot.data)], { type: 'image/png' }));
  const cssWidth = bitmap.width / dpr;
  const cssHeight = bitmap.height / dpr;
  let width = Math.max(1, Math.round(cssWidth));
  let height = Math.max(1, Math.round(cssHeight));
  if (Math.max(width, height) > maxDimension) {
    const factor = maxDimension / Math.max(cssWidth, cssHeight);
    width = Math.max(1, Math.round(cssWidth * factor));
    height = Math.max(1, Math.round(cssHeight * factor));
  }

  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  let data;
  if (width === bitmap.width && height === bitmap.height && mime === 'image/png') {
    data = shot.data;
  } else {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: mime, quality: quality / 100 });
    data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  }
  bitmap.close();

  const scale = width / cssWidth;
  await setScale(tabId, scale);
  return {
    image: { data, mime, width, height },
    viewport: { width: Math.round(cssWidth), height: Math.round(cssHeight), device_pixel_ratio: dpr },
    scale,
  };
}
