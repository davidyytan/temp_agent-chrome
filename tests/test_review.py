"""See tests/README.md. Regression tests for the independent review's findings."""
import asyncio, json, re, sys, time
from harness import Bridge, SITE_PORT, launch_chrome, page_eval, reload_extension, shutdown, start_site, sw_eval, target_ws, CDP

SITE = f"http://127.0.0.1:{SITE_PORT}"
FAILURES = []

def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  -- {json.dumps(detail, default=str)[:700]}" if not cond else ""))
    if not cond: FAILURES.append(name)

def ref_for(snapshot, role, name):
    m = re.search(rf'- {re.escape(role)} "{re.escape(name)}"[^\n]*\[ref=(e\d+-[0-9a-z]{{4}})\]', snapshot)
    return m.group(1) if m else None

ATTACHED = "chrome.debugger.getTargets().then(ts => ts.filter(t => t.attached && t.type === 'page' && !t.url.startsWith('chrome-extension')).length)"

async def popup(message):
    if not target_ws(lambda t: "popup/popup.html" in t["url"]):
        await sw_eval("chrome.tabs.create({url: chrome.runtime.getURL('popup/popup.html'), active: false})")
        await asyncio.sleep(1)
    return await page_eval("popup/popup.html", f"chrome.runtime.sendMessage({json.dumps(message)})")

async def wait_hello(bridge, before):
    for _ in range(100):
        if bridge.hello_count > before and bridge.conn:
            return True
        await asyncio.sleep(0.2)
    return False

async def main():
    site = start_site(); bridge = Bridge(); await bridge.start()
    proc, profile = launch_chrome(headless="--headed" not in sys.argv)
    call = bridge.call
    try:
        await asyncio.wait_for(bridge.connected.wait(), 40)
        await sw_eval("chrome.storage.local.set({allowAllSites: false, allowedSites: ['127.0.0.1']})")

        # Concurrent first tabs share one window and group.
        a, b = await asyncio.gather(call("tabs_create", {"url": f"{SITE}/index.html"}), call("tabs_create", {"url": f"{SITE}/page2.html"}))
        groups = await sw_eval("chrome.tabGroups.query({}).then(gs => gs.length)")
        tabs = (await call("tabs_list"))["result"]["tabs"]
        check("two first tabs share one group", a["ok"] and b["ok"] and groups == 1 and len(tabs) == 2, [groups, tabs])
        tab1 = a["result"]["tab"]["tab_id"]

        # Console and network keep nothing from unapproved sites.
        await call("console", {"tab_id": tab1}); await call("network", {"tab_id": tab1})
        snap = (await call("read_page", {"tab_id": tab1}))["result"]["text"]
        r = await call("click", {"ref": ref_for(snap, "link", "Leak test")})
        check("unapproved site blocked", not r["ok"] and r["error"]["code"] == "site_not_allowed", r)
        await asyncio.sleep(0.5)
        await call("navigate", {"action": "back"})
        c = await call("console"); n = await call("network")
        leaked = "SECRET" in json.dumps(c) + json.dumps(n)
        check("no console/network leak from unapproved site", c["ok"] and n["ok"] and not leaked and (c["result"]["hidden"] + n["result"]["hidden"]) > 0, [c, n])

        # Pause from the popup stops a long action mid-way.
        snap = (await call("read_page"))["result"]["text"]
        name_ref = ref_for(snap, "textbox", "Your name")
        long_text = "x" * 5000
        task = asyncio.create_task(call("type", {"ref": name_ref, "text": long_text, "clear": True, "slowly": True}, timeout=60))
        await asyncio.sleep(0.6)
        await popup({"type": "popup:pause", "sessionId": "test-session"})
        r = await task
        typed = await page_eval("index.html", "document.getElementById('name').value.length")
        check("pause stops a running action", not r["ok"] and r["error"]["code"] == "paused" and 0 < typed < 5000, [r.get("error"), typed])
        await popup({"type": "popup:resume", "sessionId": "test-session"})

        # Disconnect stops a running action and leaves nothing attached.
        task = asyncio.create_task(call("type", {"ref": name_ref, "text": long_text, "clear": True, "slowly": True}, timeout=60))
        await asyncio.sleep(0.6)
        before = bridge.hello_count
        await bridge.conn.close()
        try:
            await asyncio.wait_for(task, 2)
        except Exception:
            pass
        await asyncio.sleep(1.0)
        typed_a = await page_eval("index.html", "document.getElementById('name').value.length")
        await asyncio.sleep(1.0)
        typed_b = await page_eval("index.html", "document.getElementById('name').value.length")
        attached = await sw_eval(ATTACHED)
        check("disconnect stops typing", typed_a == typed_b and typed_b < 5000, [typed_a, typed_b])
        check("nothing attached after disconnect", attached == 0, attached)
        check("reconnected", await wait_hello(bridge, before))

        # A confirm left open across a reconnect: calls fail fast instead of hanging.
        snap = (await call("read_page"))["result"]["text"]
        r = await call("click", {"ref": ref_for(snap, "button", "Delete item")}, timeout=40)
        before = bridge.hello_count
        await bridge.conn.close()
        await asyncio.sleep(0.5)
        check("reconnected again", await wait_hello(bridge, before))
        start = time.monotonic()
        r = await call("read_page", timeout=40)
        elapsed = time.monotonic() - start
        check("blocked page fails fast", not r["ok"] and r["error"]["code"] == "page_blocked" and elapsed < 12, [round(elapsed, 1), r])
        # The other tab is unaffected.
        tab2 = [t["tab_id"] for t in tabs if t["tab_id"] != tab1][0]
        r = await call("get_text", {"tab_id": tab2})
        check("other tabs keep working", r["ok"] and "Second page" in r["result"]["text"], r)
        # The agent's way out: close the frozen tab (closing is handled by the browser).
        r = await call("tabs_close", {"tab_id": tab1}, timeout=20)
        r2 = await call("tabs_list")
        check("frozen tab can be closed", r["ok"] and all(t["tab_id"] != tab1 for t in r2["result"]["tabs"]), [r, r2])

        # A session the user ended from the popup comes back paused.
        await popup({"type": "popup:endSession", "sessionId": "test-session"})
        r = await call("tabs_create", {"url": f"{SITE}/page2.html"})
        check("ended session returns paused", not r["ok"] and r["error"]["code"] == "paused" and r["error"]["data"]["reason"] == "user_ended", r)
        await popup({"type": "popup:resume", "sessionId": "test-session"})
        r = await call("tabs_create", {"url": f"{SITE}/page2.html"})
        check("resumed after user ok", r["ok"], r)

        # Reloading the extension (as after an update) wipes its session memory:
        # the old group is marked released, its stale overlay removed, and the
        # agent starts fresh with working overlay and takeover detection.
        r = await call("tabs_create", {"url": f"{SITE}/index.html"})
        old_tab = r["result"]["tab"]["tab_id"]
        await call("scroll", {"direction": "down", "amount": 1})
        before = bridge.hello_count
        await reload_extension()
        check("reconnected after extension reload", await wait_hello(bridge, before))
        await asyncio.sleep(1)
        await sw_eval("chrome.storage.local.set({allowAllSites: false, allowedSites: ['127.0.0.1']})")
        title = await sw_eval(f"chrome.tabs.get({old_tab}).then(t => chrome.tabGroups.get(t.groupId)).then(g => g.title + ':' + g.color)")
        stale = await page_eval("index.html", "document.querySelectorAll('agent-chrome-overlay').length")
        check("old group released and stale overlay removed", title == "✓ Test agent:grey" and stale == 0, [title, stale])
        r = await call("tabs_create", {"url": f"{SITE}/page2.html"})
        new_tab = r["result"]["tab"]["tab_id"] if r["ok"] else None
        r = await call("scroll", {"direction": "down", "amount": 1, "tab_id": new_tab})
        hosts = await page_eval("page2.html", "document.querySelectorAll('agent-chrome-overlay').length")
        check("fresh tab with one overlay after reload", r["ok"] and hosts == 1, [r.get("error"), hosts])
        await asyncio.sleep(2)
        ws = target_ws(lambda t: t["type"] == "page" and t["url"].endswith("/page2.html"))
        async with CDP(ws) as page:
            for kind in ("mousePressed", "mouseReleased"):
                await page.send("Input.dispatchMouseEvent", {"type": kind, "x": 300, "y": 300, "button": "left", "buttons": 1, "clickCount": 1})
        await asyncio.sleep(1)
        r = await call("session_info")
        check("takeover detected after reload", r["ok"] and r["result"]["session"]["paused"], r)
        await popup({"type": "popup:resume", "sessionId": "test-session"})

        # Session ids are validated.
        r = await call("session_info", session={"id": "__proto__", "label": "x"})
        check("bad session id rejected", not r["ok"] and r["error"]["code"] == "bad_request", r)

        # Bridge URL must stay on this machine.
        r = await popup({"type": "popup:setSetting", "key": "bridgeUrl", "value": "ws://evil.example:18765/extension"})
        check("remote bridge URL refused", r and not r.get("ok"), r)
    finally:
        shutdown(proc, profile); await bridge.stop(); site.shutdown()
    print("\nFAILURES:", FAILURES or "none")

asyncio.run(main())
