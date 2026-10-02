// read_page: the page's accessibility tree as compact text with element refs.
//
// Chrome computes the tree (names, roles, states, shadow DOM), so this is how
// a text-only model "sees" a page. A ref is "e" + the DOM node's backend id
// + a tag of the page load (see documentTag), so refs need no extension-side
// state and go stale exactly when the page changes.

import * as cdp from './cdp.js';
import { AgentError, badRequest } from './errors.js';
import { oneLine, truncate } from './util.js';

const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'MenuListOption',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

// Shown even without a name, because they give the page its shape.
const STRUCTURAL_ROLES = new Set([
  'alert',
  'alertdialog',
  'article',
  'banner',
  'cell',
  'columnheader',
  'complementary',
  'contentinfo',
  'dialog',
  'figure',
  'form',
  'grid',
  'gridcell',
  'heading',
  'Iframe',
  'image',
  'img',
  'list',
  'listitem',
  'main',
  'menu',
  'menubar',
  'navigation',
  'radiogroup',
  'region',
  'row',
  'rowheader',
  'search',
  'status',
  'table',
  'tablist',
  'tabpanel',
  'toolbar',
  'tree',
]);

// Their name already says everything their text children would.
const NAME_COVERS_CHILDREN = new Set([
  'button',
  'checkbox',
  'heading',
  'image',
  'img',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'MenuListOption',
  'option',
  'radio',
  'searchbox',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

// Never emitted, and their names are redundant even when set.
const TRANSPARENT_ROLES = new Set(['generic', 'none', 'presentation', 'paragraph', 'LabelText', 'Section']);
const DROPPED_ROLES = new Set(['InlineTextBox', 'LineBreak', 'ListMarker']);
// Text inside these flows with its surroundings; any other element starts a
// new text line, so separate paragraphs and divs never merge.
const INLINE_ROLES = new Set([
  'abbr',
  'code',
  'deletion',
  'emphasis',
  'insertion',
  'mark',
  'strong',
  'subscript',
  'superscript',
  'time',
]);
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'slider', 'spinbutton']);
const MAX_NAME = 150;
const MAX_TEXT = 500;

// A backend node id is only unique within one renderer process, and a
// navigation can land in a fresh process whose ids restart at 1. So every ref
// carries a tag of the document it came from: a ref from an old page then
// fails as stale instead of hitting whatever element reuses its id.
export async function documentTag(tabId) {
  const { frameTree } = await cdp.send(tabId, 'Page.getFrameTree');
  const loaderId = String(frameTree?.frame?.loaderId || '').replace(/[^0-9a-z]/gi, '');
  return (loaderId.slice(0, 4) || '0000').toLowerCase();
}

export function parseRef(ref) {
  const match = /^(?:ref=)?e(\d+)-([0-9a-z]{4})$/i.exec(String(ref ?? '').trim());
  if (!match) throw badRequest(`Bad ref "${ref}". Refs look like e123-ab12 and come from read_page.`);
  return { backendNodeId: Number(match[1]), tag: match[2].toLowerCase() };
}

// The backend node id for `ref`, if it belongs to the tab's current page.
export async function resolveRef(tabId, ref) {
  const { backendNodeId, tag } = parseRef(ref);
  if (tag !== (await documentTag(tabId))) throw staleRef(ref);
  return backendNodeId;
}

export function staleRef(ref) {
  return new AgentError(
    'stale_ref',
    `Ref ${ref} no longer points at an element on the page (it changed or navigated). Call read_page again.`,
  );
}

function propertiesOf(node) {
  const props = {};
  for (const p of node.properties || []) props[p.name] = p.value?.value;
  return props;
}

function stateTags(role, props) {
  const tags = [];
  if (props.level !== undefined && role === 'heading') tags.push(`level=${props.level}`);
  if (props.checked === 'true' || props.checked === true) tags.push('checked');
  else if (props.checked === 'mixed') tags.push('checked=mixed');
  if (props.pressed === 'true' || props.pressed === true) tags.push('pressed');
  if (props.selected === true) tags.push('selected');
  if (props.expanded === true) tags.push('expanded');
  else if (props.expanded === false) tags.push('collapsed');
  if (props.disabled === true) tags.push('disabled');
  if (props.required === true) tags.push('required');
  if (props.readonly === true) tags.push('readonly');
  if (props.focused === true) tags.push('focused');
  if (props.invalid && props.invalid !== 'false') tags.push('invalid');
  return tags;
}

function isInteractive(role, props, name) {
  if (INTERACTIVE_ROLES.has(role)) return true;
  // Custom widgets (div with tabindex and a label) still deserve a ref.
  return props.focusable === true && Boolean(name) && !['RootWebArea', 'WebArea', 'Iframe'].includes(role);
}

export async function readPage(tabId, { filter = 'all', ref = null, maxChars = 25000 } = {}) {
  if (!['all', 'interactive'].includes(filter)) throw badRequest('filter must be "all" or "interactive"');
  const { nodes } = await cdp.send(tabId, 'Accessibility.getFullAXTree', {}, 30_000);
  if (!nodes?.length) return { text: '(empty page)', node_count: 0, truncated: false };

  const tag = await documentTag(tabId);
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  let root;
  if (ref) {
    const backendId = await resolveRef(tabId, ref);
    root = nodes.find((n) => n.backendDOMNodeId === backendId);
    if (!root) throw staleRef(ref);
  } else {
    root = nodes.find((n) => !n.parentId) || nodes[0];
  }

  const entries = [];
  const visit = (node, depth, textGroup) => {
    const role = node.role?.value || '';
    if (DROPPED_ROLES.has(role)) return;
    const children = () => (node.childIds || []).map((id) => byId.get(id)).filter(Boolean);
    const group = INLINE_ROLES.has(role) ? textGroup : node.nodeId;
    if (node.ignored) {
      for (const child of children()) visit(child, depth, group);
      return;
    }
    const name = truncate(oneLine(node.name?.value), MAX_NAME);
    if (role === 'StaticText') {
      if (filter === 'all' && name) entries.push({ depth, text: name, group: textGroup });
      return;
    }
    const props = propertiesOf(node);
    const interactive = isInteractive(role, props, name);
    const isRootDocument = role === 'RootWebArea' || role === 'WebArea';

    if (filter === 'interactive') {
      if (interactive) entries.push(describe(node, role, name, props, 0, tag));
      for (const child of children()) visit(child, depth, group);
      return;
    }

    const emit =
      !isRootDocument &&
      (interactive || STRUCTURAL_ROLES.has(role) || (name && !TRANSPARENT_ROLES.has(role)));
    if (emit) entries.push(describe(node, role, name, props, depth, tag));
    if (emit && name && NAME_COVERS_CHILDREN.has(role)) return;
    for (const child of children()) visit(child, emit ? depth + 1 : depth, group);
  };
  visit(root, 0, root.nodeId);

  const lines = renderEntries(entries);
  let size = 0;
  let kept = 0;
  for (const line of lines) {
    if (size + line.length + 1 > maxChars) break;
    size += line.length + 1;
    kept += 1;
  }
  const truncated = kept < lines.length;
  let text = lines.slice(0, kept).join('\n') || (filter === 'interactive' ? '(no interactive elements)' : '(no content)');
  if (truncated) {
    text +=
      `\n… ${lines.length - kept} more lines not shown. Narrow with filter="interactive", ` +
      'or pass ref=<a container ref> to read one part.';
  }
  return { text, node_count: entries.length, truncated };
}

function describe(node, role, name, props, depth, tag) {
  let line = `- ${role}`;
  if (name) line += ` "${name.replace(/"/g, '\\"')}"`;
  const tags = stateTags(role, props);
  if (VALUE_ROLES.has(role) && node.value?.value !== undefined && node.value?.value !== '') {
    tags.push(`value="${truncate(oneLine(node.value.value), MAX_NAME).replace(/"/g, '\\"')}"`);
  }
  if (role === 'link' && typeof props.url === 'string' && props.url) tags.push(`url=${truncate(props.url, 120)}`);
  if (tags.length) line += ` [${tags.join(', ')}]`;
  if (node.backendDOMNodeId) line += ` [ref=e${node.backendDOMNodeId}-${tag}]`;
  return { depth, line };
}

// Adjacent text from the same block reads as one line.
function renderEntries(entries) {
  const lines = [];
  let pendingText = null;
  const flush = () => {
    if (!pendingText) return;
    lines.push(`${'  '.repeat(pendingText.depth)}- text: ${truncate(pendingText.parts.join(' '), MAX_TEXT)}`);
    pendingText = null;
  };
  for (const entry of entries) {
    if (entry.text !== undefined) {
      if (pendingText && pendingText.depth === entry.depth && pendingText.group === entry.group) {
        pendingText.parts.push(entry.text);
      } else {
        flush();
        pendingText = { depth: entry.depth, group: entry.group, parts: [entry.text] };
      }
      continue;
    }
    flush();
    lines.push(`${'  '.repeat(entry.depth)}${entry.line}`);
  }
  flush();
  return lines;
}
