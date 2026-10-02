# Agent tools for the browser

The extension exposes 24 bridge methods. The model should not see 24 tools. This
is the proposed tool surface for agent-core: **three tools**, split by what
they do to the world.

| Tool | Purpose | Permission |
|---|---|---|
| `browser_look` | See the page | read: never asks |
| `browser_navigate` | Choose which page | asks in `user` mode (except `list`) |
| `browser_act` | Change the page | asks in `user` mode |

## Why three

- **One tool per permission level.** agent-core's approval gate classifies
  tools by name (`tool_risk` in
  [`permissions.py`](../../agent-core/agent_core/session/permissions.py)).
  - Everything in `browser_look` is safe to run without asking.
  - Everything in `browser_act` changes a real, logged-in page.
  - Navigation sits between: it can't change a page's data, but a URL can
    carry data out.

  Splitting on that line keeps the rule simple: look runs freely, the other two
  ask.
- **Fewer schemas in every prompt.** Every tool's schema is sent with every
  model call. 24 separate tools would cost several thousand tokens per turn,
  and give the model 24 names to choose between. Three action-enum tools cost
  roughly a third of that.
- **It's a proven shape.** Computer-use tools work the same way: one tool with
  an `action` enum, used reliably by current models.
- **Why not one tool.** A single `browser` tool mixing reads and actions would
  either ask approval for every screenshot, or need argument-level rules for
  everything. Its parameter list would be the union of all 24 methods.

## The tools

All three take an optional `tab_id`. It defaults to the agent's current tab: the
last one it opened or used, or the newest one a page opened for it.

### `browser_look`: see the page (read)

| `what` | Extra params | Bridge method | Returns |
|---|---|---|---|
| `page` (default) | `filter` (`all`/`interactive`), `ref` (one subtree), `max_chars` | `read_page` | Outline with refs |
| `screenshot` | `max_dimension` | `screenshot` | Image (attached as pixels) + `scale` |
| `text` | `max_chars` | `get_text` | Visible text |
| `find` | `query`, `regex` | `find_text` | Matches with context |
| `wait` | `text` / `text_gone` / `seconds`, `timeout_ms` | `wait_for` | Found or timed out |
| `console` | `query`, `level`, `clear` | `console` | Recent messages (capture starts on first use) |
| `network` | `query`, `clear` | `network` | Recent requests (reload to see a page's load) |

**How screenshots reach the model:** agent-core writes the PNG to the session
scratchpad. It then attaches it the way `view_image` results are attached
today: `build_pull_image_message` in both sister `graph/*/common.py` files
(line 532) learns to recognize `browser_look` with `what == "screenshot"`.
Text-only models use `page`.

### `browser_navigate`: choose which page

| `action` | Params | Bridge method |
|---|---|---|
| `list` | — | `tabs_list` (read: never asks) |
| `goto` | `url` | `navigate` |
| `back` / `forward` / `reload` | — | `navigate` |
| `open` | `url` | `tabs_create` (new tab, becomes current) |
| `switch` | `tab_id` | `tabs_select` |
| `close` | `tab_id` | `tabs_close` |

### `browser_act`: change the page

| `action` | Params | Bridge method |
|---|---|---|
| `click` | `ref` or `coordinate`, `button`, `double`, `modifiers` | `click` |
| `type` | `text`, `ref`, `clear`, `submit`, `slowly` | `type` |
| `key` | `keys` (`"Enter"`, `"cmd+a"`, `"Down Down Enter"`) | `key` |
| `scroll` | `direction`, `amount`, `ref` or `coordinate` | `scroll` |
| `hover` | `ref` or `coordinate` | `hover` |
| `drag` | `ref`/`coordinate` → `to_ref`/`to_coordinate` | `drag` |
| `select` | `ref`, `values` | `select_option` |
| `upload` | `ref`, `paths` | `upload_file`; agent-core reads the files and sends base64 |
| `dialog` | `accept`, `prompt_text` | `handle_dialog` |
| `js` | `code` | `evaluate` (also needs the extension's JavaScript toggle) |

The result of every act tells the model what happened: whether the action
navigated, alerts it closed, a confirm it opened, new tabs (and which one is
now current), and a file picker's ref.

## Not tools

- **`session_info`.** Paused state, pending dialogs and site requests already
  come back as errors and notes on the call that hits them.
- **`session_end`.** agent-core calls it when the agent session ends.
- **Events:** `session.paused`, `dialog.opened`, `tab.opened` and the rest. The
  bridge can surface them on the agent's next browser call, or in the CLI.

## How agent-core builds it

All of the above is implemented; agent-core's
[`docs/browser.md`](../../agent-core/docs/browser.md) is the reference.

1. **The bridge** (`agent_core/browser/`): one process per machine, so it
   outlives any one session and serves dispatched runs too. It serves
   `/health` and `/extension`, checks the extension's origin, and takes agent
   calls on `POST /v1/call` with a bearer token (requests carrying an `Origin`
   header are refused, so web pages cannot use it). Events are queued per
   session and returned with that session's next call. `/browser on` in
   agent-cli, `agent browser start`, or `python -m agent_core.browser start`
   starts it.
2. **The three tools** (`agent_core/tools/browser.py`). They join the static
   toolset while `AGENT_BROWSER_ENABLED` is on, read at every graph build like
   `WEB_TOOLS_PROVIDER`. That reaches the interactive and autonomous graphs
   alike, which `_session_scoped_tools` would not have (it is
   interactive-only). Off, nothing about the agent changes: no tools, no prompt
   text. The how-to above lives in the tool descriptions, so there is no
   separate skill.
3. **Approvals.** As proposed: `browser_look` and `browser_navigate list` are
   `read`; the rest is `browser`, which asks in `user` mode. `browser_act js`
   has its own session-approval key.
4. **Screenshot attachment.** As proposed, in both sister `graph/*/common.py`.
   A model that cannot see images is shown `browser_look` without the
   screenshot mode.
5. **Short result text.** Done; bridge method names in the extension's
   messages are translated to tool terms.
6. **Sessions.** One extension session per agent, named by its uuid (session,
   run or sub-agent), so each gets its own window. Its tabs are released when
   the run ends, the CLI exits, or on `/browser off`.
7. **Docker.** The client is plain HTTP. agent-cli forwards
   `AGENT_BROWSER_ENABLED`, `AGENT_BROWSER_TOKEN` and `AGENT_BROWSER_BRIDGE_URL`
   to runs; sub-agents inherit them; a loopback bridge URL is redirected to
   `host.docker.internal` inside a container.
