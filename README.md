# Agent Chrome

A Chrome extension that lets an agent-core agent see and drive browser tabs.
Each agent works only in its own tab group, and you can watch it or take over
at any moment.

```
Chrome + this extension  ──WebSocket──▶  agent-chrome bridge (local)  ◀──  agent-core tools
```

An extension cannot accept connections, so it dials out to a small local bridge
at `ws://127.0.0.1:18765/extension`. The agent talks to the bridge, never to
Chrome directly. Until the bridge is running, the popup shows "Bridge not
running" and the extension retries every few seconds.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder (`agent-chrome-extension/`).
3. Pin the extension (puzzle icon → pin) so its status and requests stay in view.

The extension ID is always `cbclhcbmllbpkhmpcpgiccknlodiljpe` (fixed by the
`key` in `manifest.json`); the bridge only accepts that ID. After editing the
code, press the reload icon on the extension's card.

Then, in agent-cli, run `/browser on`. It starts the bridge (also `agent
browser start`, or `python -m agent_core.browser start` without the CLI) and
gives that session the browser tools. The popup's status turns to connected
within a few seconds. See agent-core
[`docs/browser.md`](../agent-core/docs/browser.md).

Reloading releases every agent's tabs. Their groups turn grey (`✓ name`), and
an agent that asks again gets a fresh window.

## What you see

- **A window and tab group per agent.** An agent's first tab opens a new,
  unfocused window with a colored group titled `🤖 <agent name>`. The agent can
  use exactly the tabs in its group:
  - Drag a tab out of the group to take it away from the agent.
  - Drag a tab in, or use **Share this tab** in the popup, to hand it over.
  - Tabs and popup windows the page opens from an agent tab (links with
    `target=_blank`, "Sign in with Google" popups) become the agent's too,
    unless you opened them yourself while you had control.
- **An overlay on agent tabs.** A colored frame plus a pill, `Agent: <name>`,
  in the corner. While the agent acts, the frame pulses and the pill reads
  `<name> is working…`. The overlay is hidden from the agent's screenshots and
  page reads.
- **Chrome's "Agent Chrome started debugging this browser" bar.** Chrome shows
  it whenever an extension drives tabs, and extensions cannot hide it. It goes
  away when the bridge disconnects. Anything the agent was doing stops then
  too.

### Taking over

- **Click or type in an agent's tab** (or press **Take over** on the pill, or
  **Pause** in the popup). The agent pauses, including any action already
  under way.
  - It can still look, but every click, keystroke and navigation is refused
    until you press **Hand back** on the pill, or **Resume** in the popup.
- **Press Cancel on Chrome's debugging bar.** Every agent stops, including
  looking, and so does any new agent that connects, until you resume one in
  the popup.
- **Press End in the popup.** The agent's tabs are released and left open. If
  that agent asks for the browser again, it comes back paused, waiting for you.

### Site access

By default the agent has to ask before using each site. When it tries a site
you haven't allowed:

1. Its tool call fails with "Site access needed".
2. The extension icon shows a red count.
3. The popup lists the site with **Allow** / **Dismiss**.

- **Allow** approves exactly that site (`example.com` covers `www.example.com`
  too), on any port.
- **+ subdomains** approves `*.example.com`, i.e. every subdomain. This is
  never implied: allowing a Google search does not hand over
  `mail.google.com`. You can also type `*.example.com` into the allowed-sites
  box.
- **Share this tab** approves that tab's site.
- **Allow every site** turns asking off.

The agent never gets `chrome://` pages, the Chrome Web Store, or non-http(s)
URLs. If a click takes it onto an unapproved site, it stops there and can only
navigate back or away.

### Dialogs and file pickers

- **`alert()`** only informs: it is closed automatically and reported to the
  agent.
- **`confirm()` and `prompt()`** are decisions. They stay open, on your screen
  too, and the agent answers them with `handle_dialog`, which agent-core
  approves like any other action. While a dialog is open, the page is frozen
  and the agent's other calls on that tab are refused.
- **"Leave site?"** prompts are accepted when the agent itself is navigating
  away.
- **File pickers.** When the agent clicks an upload button, the OS file picker
  does not open on your screen. The agent is told which input asked and fills
  it with `upload_file`. This only happens during the agent's own actions:
  your clicks always open the real picker.
- **Dialogs from sites you haven't allowed** reach the agent without their
  text.

Under **Advanced**: whether the agent may run JavaScript in pages (off by
default), the bridge URL, and Reconnect.

## Bridge protocol (v1)

This is the contract the bridge in agent-core
([`agent_core/browser/server.py`](../agent-core/agent_core/browser/server.py))
implements.

### Connection

- The extension first probes `GET http://127.0.0.1:18765/health`. It needs a
  JSON body with `"service": "agent-chrome-bridge"` (e.g.
  `{"service": "agent-chrome-bridge", "version": "…"}`). Only then does it open
  the WebSocket at `/extension`.
- The bridge should reject a handshake whose `Origin` is not
  `chrome-extension://cbclhcbmllbpkhmpcpgiccknlodiljpe`.
- The extension pings every 20 s. This also keeps its MV3 service worker alive.
- If the connection drops, the extension detaches from every tab, removes its
  overlays, and reconnects with backoff (1 s, doubling to 15 s).

### Messages

All messages are JSON text frames.

| Direction | Message |
|---|---|
| ext → bridge | `{"type":"hello","protocol":1,"extension":{"id","version"},"browser":{"user_agent"}}` |
| bridge → ext | `{"type":"welcome","bridge":{...}}` (optional) |
| bridge → ext | `{"type":"request","id":"r1","method":"click","params":{...},"session":{"id":"…","label":"…"}}` |
| ext → bridge | `{"type":"response","id":"r1","ok":true,"result":{...}}` |
| ext → bridge | `{"type":"response","id":"r1","ok":false,"error":{"code":"…","message":"…","data":{...}}}` |
| ext → bridge | `{"type":"event","event":"session.paused","session_id":"…","data":{...},"time":"…"}` |
| both | `{"type":"ping","ts":…}` / `{"type":"pong","ts":…}` |

- **Requests:** the extension answers them concurrently.
- **`session`:** required on every request. The first request with a new `id`
  creates the agent session. `label` names its tab group and pill.
- **`error.message`:** written for the model to read and act on.

**Events:**
- `session.paused` (`reason`: `user_input` | `user_button` | `debugger_canceled`)
- `session.resumed`
- `site_access.requested` (`site`)
- `tab.closed` (`tab_id`)
- `tab.shared` (`tab`)
- `tab.opened` (`tab`, `opener_tab_id`): the page opened a tab or popup
- `dialog.opened` (`tab_id`, `dialog`): a confirm/prompt is waiting for an answer

### Methods

Tab methods take an optional `tab_id`. It defaults to the session's current
tab, which is the last tab it created or used.

Every tab result includes `tab: {tab_id, url, title, status, active, current}`.

| Method | Params | Result | Kind |
|---|---|---|---|
| `session_info` | — | `session`, `tabs`, `platform` (`mac`/`windows`/`linux`), `settings` | read |
| `session_end` | `close_tabs?` | `ended`, `closed_tabs` | — |
| `tabs_list` | — | `tabs` | read |
| `tabs_create` | `url?`, `active?` (true), `timeout_ms?` | `tab`, `timed_out` (with `url`) | act |
| `tabs_select` | `tab_id` | `tab` | act |
| `tabs_close` | `tab_id` | `closed` | act |
| `navigate` | `url` or `action` (`back`/`forward`/`reload`), `timeout_ms?` | `tab`, `timed_out` | act |
| `screenshot` | `format?` (`png`/`jpeg`), `quality?`, `max_dimension?` (1288) | `image: {data (base64), mime, width, height}`, `viewport`, `scale` | read |
| `read_page` | `filter?` (`all`/`interactive`), `ref?`, `max_chars?` (25000) | `text`, `node_count`, `truncated` | read |
| `get_text` | `max_chars?` (20000) | `title`, `text`, `truncated`, `total_chars` | read |
| `find_text` | `query`, `regex?`, `max_results?` (20), `context_chars?` (80) | `total`, `matches` (`match`, `context`, `position`), `truncated` | read |
| `wait_for` | `text?`, `text_gone?`, `seconds?`, `timeout_ms?` (30000) | `found`, `waited_ms` / `timed_out` | read |
| `console` | `pattern?`, `level?` (`debug`/`log`/`warn`/`error` = at least), `limit?`, `clear?` | `entries` (`level`, `text`, `url`, `page`, `time`), `total`, `hidden` | read |
| `network` | `pattern?`, `limit?`, `clear?` | `entries` (`method`, `url`, `type`, `status`, `failed`, `page`, …), `total`, `hidden` | read |
| `click` | `ref` or `coordinate: [x, y]`, `button?`, `click_count?`, `modifiers?` | `clicked`, `navigated?` | act |
| `hover` | `ref` or `coordinate` | `hovered` | act |
| `drag` | from `ref`/`coordinate` to `to_ref`/`to_coordinate`, `steps?` (12), `modifiers?` | `dragged`, `native_drag` | act |
| `type` | `text`, `ref?`, `clear?`, `submit?`, `slowly?` | `typed_chars`, `field_value?` | act |
| `key` | `keys` (e.g. `"Enter"`, `"cmd+a"`, `"Down Down Enter"`), `repeat?` | `pressed` | act |
| `scroll` | `direction` + `amount?` (×100px) at `ref`/`coordinate`/center, or just `ref` to scroll it into view | `page` (scroll position, sizes) | act |
| `select_option` | `ref` (a `<select>`), `values` (values or labels) | `selected` | act |
| `handle_dialog` | `accept` (true = OK), `prompt_text?` | `answered` | act |
| `upload_file` | `ref` (file input or drop zone), `files: [{name, mime?, data (base64)}]` (25 MB total) | `uploaded`, `via` (`file input`/`drop`) | act |
| `evaluate` | `expression` (needs "run JavaScript" on) | `result` | act |

**Act methods** fail with `paused` while the user has control. An action
already running when the user takes over, the bridge disconnects, or the tab
leaves the agent stops at its next step.

**Reads** check the site before and after reading. A redirect to an unapproved
site in between fails the call with `site_not_allowed` instead of returning the
other site's content. Their results
also report how the page reacted, when it did:

| Field | Meaning |
|---|---|
| `dialog` | The action opened a confirm/prompt; answer it with `handle_dialog` |
| `dialogs_shown` | Alerts closed (or "Leave site?" accepted) during the action |
| `opened_tabs` | Tabs or popups the action opened; the newest becomes the current tab |
| `file_chooser` | `{ref, multiple}`: the page asked for a file; pass the ref to `upload_file` |
| `navigated` | The action changed the page URL |
| `note` | The above, in a sentence for the model |

While a page shows a dialog, every tab method except `handle_dialog`,
`tabs_select` and `tabs_close` fails with `dialog_open`. `tabs_list` shows the
dialog on its tab.

**Refs** come from `read_page` and look like `e123-ab12`. The suffix ties the
ref to one page load: after the page navigates, an old ref fails with
`stale_ref` instead of hitting an unrelated element.

**Drag** presses, moves in steps and releases, which is what sliders, sortable
lists and drawing need. When the page uses the browser's built-in drag and drop
(`draggable="true"`), Chrome's own drag is intercepted and finished with a real
drop (`native_drag: true`). Both ends must be on screen together; scroll first
if they are far apart.

**Coordinates** are pixels in the most recent screenshot of that tab. The
extension converts them back to page pixels using that screenshot's `scale`.
Screenshots are viewport-only and sized in CSS pixels, then capped at
`max_dimension`.

**Error codes:**

| Code | Meaning |
|---|---|
| `bad_request` | Bad or missing parameters |
| `unknown_method` | No such method |
| `paused` | The user has control |
| `site_not_allowed` | `data.site` is waiting for approval |
| `blocked_url` | URL is never allowed (chrome://, Web Store, non-http(s)) |
| `invalid_url` | Not a valid URL |
| `tab_not_found` | No tab with that id |
| `tab_not_owned` | Tab is not in this session's group |
| `no_tab` | Session has no tabs yet |
| `tab_closed` | Tab closed during the call |
| `page_blocked` | The tab is not responding, most likely a dialog left open from before a reconnect. The user has to close it; `tabs_close` still works |
| `disconnected` | The bridge went away while the call ran |
| `session_ended` | The session was ended while the call ran |
| `stale_ref` | Ref is from an older page load |
| `window_hidden` | `hover`/`drag` on a page Chrome is not painting (minimized window, another desktop, fully covered) |
| `dialog_open` | The page shows a dialog; `data.dialog` says which |
| `no_dialog` | `handle_dialog` with no dialog open |
| `not_visible` | Element has no visible box |
| `navigation_failed` | Back/forward/reload failed |
| `javascript_disabled` | "Run JavaScript" is off |
| `js_error` | Page JavaScript threw |
| `debugger_busy` | DevTools or another extension holds the tab |
| `debugger_attach_failed` | Chrome refused to attach to the tab |
| `cdp_error` | A DevTools command failed |
| `timeout` | A DevTools command timed out |
| `internal_error` | Unexpected extension error |

## Security notes

- **Untrusted page text.** The agent acts in your real, logged-in browser, and
  anything a page says flows into the model's context. A page can try to talk
  the agent into doing things. The site allowlist, the agent-only tab group,
  and agent-core's approval prompts for act tools are the guard rails. Keep
  "Allow every site" off unless you trust what the agent will browse.
- **Connections.** The bridge listens on loopback only. The extension only
  answers a bridge whose `/health` identifies itself, and the bridge only
  accepts this extension's origin. A malicious program already running as your
  user could impersonate the bridge, but it could also rewrite this unpacked
  extension, so that is out of scope.
- **Page scripts.** They cannot reach the extension: the overlay lives in a
  closed shadow root, its buttons ignore synthetic clicks, and popup commands
  are accepted only from the extension's own popup page.

## Limits

- Iframe contents (cross-origin ones especially) are not in `read_page`. Use
  `screenshot` and coordinates for them.
- Screenshots cover the visible viewport, not the full page. Scroll to see more.
- **Hidden agent window** (minimized, on another desktop, behind a full-screen
  app): Chrome does not paint it, and mouse *movement* to an unpainted page
  waits about 5 s per move. So:
  - clicks there skip the hover move, and still take about 0.4 s;
  - typing, keys, scrolling, reading and screenshots work as usual;
  - `hover` and `drag`, which are nothing but movement, return
    `window_hidden` at once.
- `scroll` moves the page (or the scrollable box under the point) directly, not
  with a synthetic mouse wheel. Pages that only react to wheel events, such as
  some maps and carousels, need keys or `drag` instead.
- Console and network capture start on the agent's first `console` or
  `network` call for a tab, not before: pages can detect the DevTools
  `Runtime` domain, and bot checks on real accounts look for it. Console
  messages logged earlier are replayed when capture starts; network requests
  are not, so reload the page to see them. Entries from pages on sites the
  agent may not use are dropped, and counted in `hidden`.
- A site rule covers that host on any port (`localhost` covers every local dev
  server).
- A hostile page can hide its own clicks from takeover detection, by stopping
  events before the overlay script sees them. **Pause** in the popup always
  works.
- Typing uses inserted text by default. Pass `slowly: true` for fields that
  listen to individual keystrokes.
- `upload_file` sets files from page JavaScript. That works for file inputs and
  ordinary drop zones, but not for sites that only accept files from a real OS
  drag.
- Downloads go to your usual Downloads folder, and the agent isn't told about
  them yet.

## Layout

```
manifest.json        MV3 manifest (permissions, fixed key)
background.js        service worker entry; all chrome.* listeners
lib/bridge.js        WebSocket client, hello/ping/request/response
lib/methods.js       every method the bridge can call
lib/sessions.js      sessions ↔ tab groups, ownership, screenshot scale
lib/control.js       overlay, acting window, pause/resume
lib/snapshot.js      read_page (accessibility tree → text with refs)
lib/screenshot.js    viewport capture and scaling
lib/cdp.js           chrome.debugger wrapper, console/network buffers
lib/input.js         mouse and keyboard through DevTools
lib/keys.js          key combo parsing
lib/policy.js        URL normalization and site allowlist checks
lib/settings.js      settings and pending site requests
lib/popup-api.js     popup requests
content/overlay.js   injected overlay and user-input detection
popup/               toolbar popup
```
