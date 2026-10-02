# How Agent Chrome works

How each feature works inside the extension, and why it is built that way. For
the message contract (methods, parameters, error codes), see the
[README](../README.md#bridge-protocol-v1). For the tools agent-core should
expose on top of it, see [agent-tools.md](agent-tools.md).

```
Chrome (your profile)                      local                         agent
┌────────────────────────────┐  WebSocket  ┌─────────────────┐  calls  ┌────────────┐
│ service worker             │────────────▶│ bridge          │◀────────│ agent-core │
│  chrome.debugger (CDP)     │  requests ◀─│ (in agent-core) │         │ browser_*  │
│  tabs, tab groups, windows │  responses ─▶                 │         │ tools      │
│ overlay (content script)   │  events ───▶└─────────────────┘         └────────────┘
│ popup                      │
└────────────────────────────┘
```

- Entry point: [`background.js`](../background.js), where every `chrome.*` listener is registered.
- Methods: [`lib/methods.js`](../lib/methods.js) (dispatch and every method the bridge can call).

## Connection

An extension cannot accept connections, so it dials out ([`lib/bridge.js`](../lib/bridge.js)).

1. **Probe.** `GET http://127.0.0.1:18765/health` must answer
   `{"service":"agent-chrome-bridge"}`. A refused fetch fails quietly, while a
   refused WebSocket would log an error every retry, so the socket is only
   opened once the bridge answers.
2. **Connect.** Open `ws://127.0.0.1:18765/extension` and send `hello`. Chrome
   stamps the `Origin: chrome-extension://cbclhcbmllbpkhmpcpgiccknlodiljpe`
   header, which the bridge checks. The ID never changes because
   `manifest.json` carries a fixed `key`.
3. **Stay alive.** MV3 service workers stop after about 30 s idle. WebSocket
   traffic resets that clock (Chrome 116+), so the extension pings every 20 s.
   While no bridge runs, a 30-second `chrome.alarms` alarm wakes the worker to
   retry, and the retry backoff goes 1 s → 15 s.
4. **Disconnect.** Detach the debugger from every owned tab and remove the
   overlays. With no agent connected, Chrome's "debugging" bar goes away and
   pages look normal. Sessions survive, so a restarted bridge picks up where it
   left off.

Requests run concurrently, but act methods (anything that changes the page) on
the same tab run one at a time.

**Stopping work in flight.** Before every DevTools command, a guard
(`guardTab` in [`lib/control.js`](../lib/control.js)) checks that work may
continue: the bridge is connected, the tab is still the agent's, and the
acting session is not paused or ended. So an action halfway through (typing
5 000 characters, a drag, `key` with `repeat`) stops at its next step when any
of these change. Commands already waiting are interrupted at once. Nothing
re-attaches to a tab the agent no longer has.

**Cleanup.** On disconnect, Cancel, or End, tabs are detached first, in
parallel, through calls the browser answers itself, so a tab frozen by a
dialog cannot hold up the rest. Overlay removal is best effort, with short
timeouts. A restarted service worker starts from "no agent connected": it
detaches anything the previous worker held and clears stale overlays.

**What survives a service-worker restart:** sessions, tab ownership, screenshot
scales and pending site requests are kept in `chrome.storage.session`. Console
and network logs, and the "agent is acting" timing, live in memory and start
over.

**Reloading or updating the extension** clears `chrome.storage.session` too,
so sessions start over:
- Their old groups are marked released (`✓ name`, grey) and the dead overlays
  on those pages are removed.
- Groups are not re-claimed by id, because group and tab ids are reused after
  a browser restart. Re-claiming them could hand the agent your own tabs.

## Sessions, windows and tab groups

Code: [`lib/sessions.js`](../lib/sessions.js).

- **Sessions.** Every request names a session (`{id, label}`), and the first
  request with a new id creates it. One agent-core session (or sub-agent) maps
  to one extension session.
- **Its own window.** The session's first tab opens in a new, unfocused
  1280×860 window, so the agent never takes over the window you are using.
- **Ownership is the tab group.** The window gets a colored group titled
  `🤖 <label>`, and the session may use exactly the tabs in it. Every tab
  method checks this.
  - Drag a tab out of the group to take it away from the agent.
  - Drag a tab in, or use **Share this tab** in the popup, to hand it over.
- **Tabs the page opens join the session.** `tabs.onCreated` records each
  new tab's opener. If the opener belongs to a session (and the agent is in
  charge, not you after taking over; new-tab pages are never adopted):
  - a normal tab (`target=_blank`, `window.open`) is put into the group;
  - a popup window (e.g. "Sign in with Google") cannot hold a group, so it is
    owned by tab id (`popupTabIds`) instead.

  The action that opened it reports it in `opened_tabs`, and the newest one
  becomes the session's current tab.
- **Current tab.** Tab methods default to the session's current tab: the last
  one it created, used, or had opened for it.
- **Ending.** `session_end` (or **End** in the popup) detaches from the
  session's tabs and greys out the group (`✓ <label>`). With `close_tabs`, it
  closes them instead.

Background tabs and minimized windows still work: screenshots, reads, clicks
and typing were all tested on a minimized window. The agent never needs to
bring its window to the front.

## Seeing the page

### Screenshot

Code: [`lib/screenshot.js`](../lib/screenshot.js).

1. Hide the overlay and wait for that to paint.
2. Capture with `Page.captureScreenshot`.
3. Show the overlay again.

The image is resized to **CSS pixels**: a Retina 2× capture becomes 1×. It is
then capped at `max_dimension`, by default 1288, which matches agent-core's
image cap.

The result carries `scale` (image pixels per CSS pixel), and the extension
stores it per tab. When the agent later clicks at `[x, y]` in that image, the
extension divides by the scale. So the agent always speaks in the pixels of the
picture it saw.

### read_page: the page outline

Code: [`lib/snapshot.js`](../lib/snapshot.js).

Chrome's own accessibility tree (`Accessibility.getFullAXTree`) is turned into
indented text:

```
- heading "Agent Test Page" [level=1] [ref=e17-28d2]
- form [ref=e2-28d2]
  - textbox "Your name" [value="old value"] [ref=e3-28d2]
  - combobox "Favourite colour" [collapsed, value="Red"] [ref=e5-28d2]
    - option "Red" [selected] [ref=e39-28d2]
  - button "Submit" [ref=e51-28d2]
- text: Not submitted
```

**Why the accessibility tree:**
- Chrome already computes each element's real name (labels, `aria-label`,
  `aria-labelledby`), its role, and its state.
- It reaches inside shadow DOM.
- It skips hidden content.
- It is the only way a text-only model can "see" a page.

**What gets shown:**
- Generic wrappers are flattened away.
- Interactive elements always get a ref.
- Text from separate blocks stays on separate lines.
- `filter: "interactive"` gives a flat list of just the controls.
- `ref` reads one subtree.
- `max_chars` (default 25 000) truncates, with a hint for how to narrow.

**Refs are tied to the page load.** A ref is `e<backendDOMNodeId>-<tag>`,
where the tag is the first 4 characters of the main frame's `loaderId`. Node
ids restart when a navigation lands in a new renderer process. Without the
tag, a ref from the old page could silently hit a different element on the
new one; with it, the old ref fails as `stale_ref`. Refs need no
extension-side state.

The overlay's own elements are `aria-hidden`, so the agent never sees them.

### Text, search and waiting

- **`get_text`** returns the page's visible text (`innerText`).
- **`find_text`** greps that text, plain or regex, and returns each match with
  surrounding context.
- **`wait_for`** polls for text to appear or disappear, or just sleeps.

All three run in the extension's isolated world (`chrome.scripting`), so page
scripts cannot fake what they read.

### Console and network

Attaching enables only the `Page` domain, which is all dialogs, file pickers
and navigation need. Pages can detect an enabled `Runtime` domain, and bot
checks on real accounts look for it. So `Runtime`, `Log` and `Network` are
enabled on the first `console` or `network` call for that tab.

From then on, the extension keeps per tab the last 300 console messages (logs,
exceptions, browser warnings) and 400 requests (method, URL, type, status,
failure):
- **Earlier output:** console messages logged before capture are replayed;
  network requests are not, so the agent reloads to see a page's load traffic.
- **Site filtering:** every entry remembers the page it came from. Entries from
  sites the agent may not use are dropped when read, and counted in `hidden`.
  This covers a page the agent clicked into and was refused, and anything you
  visited in that tab while you had control.

## Acting on the page

Code: [`lib/input.js`](../lib/input.js), [`lib/keys.js`](../lib/keys.js).

All input goes through DevTools `Input.*`, so pages receive **trusted**
events, indistinguishable from a person's. React, Vue and similar frameworks
behave as they do for real clicks.

| Action | How |
|---|---|
| click | **By ref:** scroll the element into view (`DOM.scrollIntoViewIfNeeded`), then press at the center of its first visible box (`DOM.getContentQuads`, clipped to the viewport). **By coordinate:** screenshot pixels ÷ scale. Supports right/middle click, double click, and modifier keys. |
| hover | A mouse move to the point. |
| type | **With a ref:** click the field to focus it. Then either put the caret at the end (append), or select all (`clear`). Text goes in with `Input.insertText`, or key by key with `slowly`. Optional Enter to `submit`. Returns the field's new value (passwords hidden). |
| key | Combos like `Enter`, `shift+Tab`, `cmd+a`, or a sequence `"Down Down Enter"`. On macOS, cmd+a/c/x/v/z also send the matching editing command, because macOS handles those shortcuts in the native menu rather than the page. |
| scroll | Scrolls the nearest scrollable box under a ref or coordinate (or the page), directly, in 100 px steps. Or just a ref, to scroll it into view. Returns the new scroll position, and says when nothing moved. Not a synthetic mouse wheel: that needs Chrome to paint the page, which it does not for hidden windows, and a stuck wheel event blocks all later input. |
| select_option | Sets a `<select>` by option value or label, and fires `input`/`change`. |
| drag | Mouse press, moves in steps, release; that covers sliders, sortable lists and drawing. Pages using the browser's own drag and drop (`draggable="true"`) never get a drop from mouse moves alone, so `Input.setInterceptDrags` is on during the gesture. Once Chrome reports a drag started, the rest goes through `Input.dispatchDragEvent` (enter, over, drop) with the drag's real data. |
| evaluate | Runs JavaScript in the page. Off unless the user turns it on under Advanced. |

**Hidden windows.** Chrome does not paint a page it is not showing: a
minimized window, another desktop or full-screen space, a locked screen. On
such a page:
- **Mouse moves** each wait about 5 s for a frame that never comes.
- **Presses, releases and keys** are delivered at once.

So the extension checks `document.visibilityState`, and on a hidden page:
- **Clicks** skip the hover move: a real press and release, about 0.4 s.
- **Typing** focuses the field the same way.
- **`hover` and `drag`** fail at once with `window_hidden`, because they are
  nothing but mouse movement.

After an action, the extension waits about 350 ms. If the action started a
navigation, it waits for the load, so the next read sees the new page. The
result says `navigated: true`.

## What the page does back

An action can make the page show a dialog, open a tab, or ask for a file. The
action's result reports each of these (`runAction` in
[`lib/methods.js`](../lib/methods.js)).

### Dialogs

A JavaScript dialog freezes the page: every DevTools command, script and
message to that tab hangs until it closes. The extension tracks the open
dialog per tab ([`lib/cdp.js`](../lib/cdp.js)) and applies this policy
([`lib/control.js`](../lib/control.js)):

| Dialog | What happens |
|---|---|
| `alert` | Closed at once and reported in `dialogs_shown`. It only informs. |
| `beforeunload` ("Leave site?") | Accepted when the agent itself is navigating or closing. Otherwise left alone. |
| `confirm`, `prompt` | Left open. The action that caused it returns `dialog` with the message. The agent answers with `handle_dialog` (`accept`, `prompt_text`), which agent-core gates with an approval. |

While a confirm or prompt is open:
- **New calls** on that tab fail fast with `dialog_open`, except
  `handle_dialog`, `tabs_select` and `tabs_close`.
- **In-flight calls** (the click that triggered it, for instance) are
  interrupted, instead of hanging until their timeout.

Chrome also shows the dialog on screen, so the user can answer it too. While
the user has control, dialogs are theirs.

### File pickers

During the agent's own actions (and briefly after), `Page.setInterceptFileChooserDialog` is on.
Clicking an upload button does not open the macOS file picker on your screen.
Instead, the click's result carries `file_chooser: {ref, multiple}`, pointing
at the `<input type=file>` that asked, even when that input is hidden behind a
styled button.

The agent then calls `upload_file` with that ref and the files as base64:
- **On a file input:** the extension builds `File` objects in the page, sets
  `input.files`, and fires `input`/`change`.
- **On a drop zone:** it fires `dragenter`/`dragover`/`drop` with the files.

Bytes rather than paths means no `file://` permission is needed, and an agent
in Docker can upload files from its own disk. At any other time interception
is off, so your own clicks on upload buttons open the real picker.

## You and the agent

Code: [`lib/control.js`](../lib/control.js), [`content/overlay.js`](../content/overlay.js).

### The overlay

Injected only into owned tabs, in a closed shadow root:

| Mode | Looks like |
|---|---|
| idle | A thin frame in the group color, plus `Agent: <label>` with **Take over** |
| acting | A pulsing frame, plus `<label> is working…`. Ignores the mouse, so the agent's own clicks pass through to the page |
| paused | A dashed frame, plus `You have control · <label> is paused` with **Hand back** |

It is hidden during screenshots and invisible to `read_page`.

### Telling your input from the agent's

The agent's input events are trusted too, so `isTrusted` alone cannot tell
them apart. Instead:

1. The extension marks a tab as "acting" from the start of each action until
   1.2 s after it ends.
2. The overlay script reports every trusted `mousedown`, `keydown` and
   `touchstart`.
3. A report outside an acting window is you, so the session **pauses**.

### Pausing and resuming

**While paused:**
- Act methods (click, type, navigate, close, dialogs, upload…) fail with
  `paused`, and a message telling the agent to wait or ask you.
- Reads still work, so the agent can watch what you do. Logging in for the
  agent works exactly this way.

**Resuming:** **Hand back** on the pill or **Resume** in the popup. The overlay
buttons ignore synthetic clicks, so a page script cannot resume the agent.

**Cancel on Chrome's debugging bar:** detaches everything and stops every
session, including reads. Agents that connect afterwards start stopped too.
They stay stopped until you resume one in the popup; the pill shows "stopped"
with no button. The extension does not quietly re-attach after you said stop.

**End in the popup:** releases the agent's tabs. If that agent asks for the
browser again, its session is recreated paused (`user_ended`), so it cannot
quietly open a new window.

## Site access

Code: [`lib/policy.js`](../lib/policy.js), [`lib/settings.js`](../lib/settings.js).

**What is checked:**
- Every tab method checks the tab's *current* URL, and any navigation still in
  progress (`pendingUrl`).
- `navigate` and `tabs_create` also check the target URL.
- Reads check again afterwards. A redirect to another site while reading fails
  the call instead of returning that site's content.
- A click that lands on an unapproved site returns `site_not_allowed` with the
  page left loaded. The agent can then only navigate back or away.
- Dialog text from an unapproved site is replaced before the agent can see it.

**What is never allowed:** non-http(s) URLs (except `about:blank`), `chrome://`
pages, and the Chrome Web Store.

**Approving a site:**
1. An unapproved site goes into the pending list, the icon shows a red count,
   and the popup offers **Allow**, **+ subdomains** and **Dismiss**.
2. A rule `example.com` covers `example.com` and `www.example.com`, on any port.
   A rule `*.example.com` also covers every subdomain. That is never implied,
   so allowing `www.google.com` does not grant `mail.google.com`.
3. **Share this tab** approves exactly that tab's site.
4. **Allow every site** turns asking off.

The bridge URL can only point at this machine (`127.0.0.1`, `localhost` or
`[::1]`).

## The popup

Code: [`popup/`](../popup/).

The popup shows:
- the bridge status
- pending site requests
- each session's tabs (click one to focus it), with **Pause/Resume**,
  **Share this tab** and **End**
- allowed sites
- an Advanced section: JavaScript toggle, bridge URL, reconnect

Page titles and URLs are untrusted, so the popup builds everything with
`textContent`. The service worker only accepts `popup:` messages from the
extension's own popup page, never from content scripts.

## Testing

[`tests/`](../tests/) drives the extension end to end:
- Chrome for Testing loads the unpacked extension (branded Chrome no longer
  honors `--load-extension`).
- A stand-in bridge sends real protocol requests against a local test page.
- Suites run headless and with a visible window.
- They cover:
  - every method
  - takeover and resume
  - the site gate
  - dialogs, opened tabs and popup windows, uploads, drag
  - stale refs
  - disconnect and reconnect

See [tests/README.md](../tests/README.md).

## Limits

- **Iframes:** their contents are not in `read_page`. Use `screenshot` and
  coordinates for them.
- **Screenshots** cover the viewport only. Scroll to see more.
- **Console and network** capture start at the first `console`/`network`
  call for a tab.
- **A dialog left open across a reconnect** freezes its tab for the agent
  (`page_blocked`): DevTools cannot see or answer it after re-attaching. The
  user closes it, or the agent closes the tab.
- **A hostile page** can suppress takeover detection for its own events. The
  popup's Pause always works.
- **Uploads** come from page JavaScript, so sites that only accept a real OS
  drag from Finder won't take them.
- **Downloads** land in the user's Downloads folder, and the agent is not told.
- **Drag ends** must both be on screen. Scroll first for long drags.
