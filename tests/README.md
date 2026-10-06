# Extension tests

## Fast unit checks (no browser or bridge)

From the extension root, with Python 3 and Node on `PATH`:

```sh
python3 -B tests/test_units.py
```

No third-party Python packages are required for this check. A failed
expectation or Node execution returns a nonzero exit status for CI.

## End-to-end tests

End-to-end suites that drive the real extension:
- **Browser:** Chrome for Testing with the unpacked extension loaded, in a
  throwaway profile.
- **Bridge:** a stand-in that sends real protocol requests.
- **Pages:** the local test site in `site/`.

```sh
# from agent-chrome/tests (uses agent-core's venv for `websockets`)
uv run --project ../../agent-core python run_all.py            # headless
uv run --project ../../agent-core python run_all.py --headed   # visible window
```

## Before you run

**Needs Chrome for Testing**, because branded Google Chrome ignores
`--load-extension`. The harness finds the one Playwright installs under
`~/Library/Caches/ms-playwright`, or uses `$CHROME_FOR_TESTING`.

**Uses fixed ports:**
- 18765: the bridge, which is also the extension's default
- 18799: the test site
- 9333: DevTools, used by the harness to inspect pages and the service worker

Stop a real bridge before running. On Linux or Windows, or when using a
browser outside the macOS Playwright cache, set the executable explicitly:

```sh
# From agent-chrome/tests; use your installed Chrome for Testing executable.
CHROME_FOR_TESTING=/absolute/path/to/chrome \
  uv run --project ../../agent-core python run_all.py
```

`CHROME_FOR_TESTING` is a path to the executable, not the browser's directory.
The Python environment needs `websockets`; Node must also be on `PATH` for
the unit suite. The harness creates temporary output and launches local
services and a throwaway browser profile; these are integration tests, not
read-only checks. Do not expose the test bridge to other machines.

## Suites

| Suite | Covers |
|---|---|
| `test_core.py` | Site gate, tab groups, `read_page` and refs, typing/select/click/keys, coordinate clicks, scroll, `wait_for`, console/network, `evaluate` toggle, stale refs, ownership and session isolation, takeover, pause and resume via the popup, disconnect and reconnect |
| `test_page_events.py` | alert/confirm/prompt/beforeunload, tabs and popup windows the page opens, file-chooser interception and uploads (input and drop zone), `find_text` |
| `test_drag.py` | Native HTML5 drag and drop, pointer-driven slider, range input, coordinate drag |
| `test_robustness.py` | Concurrent actions on one tab, Enter-to-submit, dialogs that open while a page loads, several agents working in parallel |
| `test_review.py` | Fixes from the code review: one group for concurrent first tabs, no console/network leak from unapproved sites, pause and disconnect stop running actions, nothing left attached, frozen tabs fail fast and can be closed, ended sessions return paused, session-id and bridge-URL validation |
| `test_units.py` | Site rules, URL normalization and key parsing, in Node |

Screenshots the suites save go to `$TMPDIR/agent-chrome-tests/`.
