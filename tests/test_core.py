import asyncio
import json
import re
import sys

from harness import (
    CDP, Bridge, SITE_PORT, launch_chrome, page_eval, save_image, shutdown, start_site, sw_eval, target_ws,
)

SITE = f"http://127.0.0.1:{SITE_PORT}"
FAILURES = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  -- {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


def ref_for(snapshot, role, name):
    m = re.search(rf'- {re.escape(role)} "{re.escape(name)}"[^\n]*\[ref=(e\d+-[0-9a-z]{{4}})\]', snapshot)
    return m.group(1) if m else None


async def main():
    site = start_site()
    bridge = Bridge()
    await bridge.start()
    proc, profile = launch_chrome(headless="--headed" not in sys.argv)
    call = bridge.call
    try:
        await asyncio.wait_for(bridge.connected.wait(), 40)
        await sw_eval("chrome.storage.local.set({allowAllSites: false, allowedSites: ['127.0.0.1']})")

        r = await call("tabs_create", {"url": f"{SITE}/index.html"})
        check("tabs_create", r["ok"] and r["result"]["tab"]["title"] == "Agent Test Page", r)
        tab1 = r["result"]["tab"]["tab_id"]

        # Tab group exists with our title and color.
        groups = await sw_eval("chrome.tabGroups.query({}).then(gs => gs.map(g => ({title: g.title, color: g.color})))")
        check("tab group created", groups == [{"title": "🤖 Test agent", "color": "blue"}], groups)

        r = await call("read_page")
        snap = r["result"]["text"]
        check("overlay not in read_page", "Take over" not in snap, snap[-300:])
        check("paragraphs not merged", "- text: Not submitted\n" in snap + "\n" and "Filler paragraph 1\n" in snap + "\n", snap[:1500])
        check("inline text merged", "This page exercises the Agent Chrome extension." in snap, snap[:400])
        overlay_present = await page_eval("index.html", "!!document.querySelector('agent-chrome-overlay')")
        check("overlay injected", overlay_present is True)

        name_ref = ref_for(snap, "textbox", "Your name")
        bio_ref = ref_for(snap, "textbox", "Bio")
        color_ref = ref_for(snap, "combobox", "Favourite colour")
        sub_ref = ref_for(snap, "checkbox", "Subscribe")
        submit_ref = ref_for(snap, "button", "Submit")
        editor_ref = ref_for(snap, "generic", "Notes editor")
        link_ref = ref_for(snap, "link", "Go to page two")
        ext_ref = ref_for(snap, "link", "External link")
        check("refs found", all([name_ref, bio_ref, color_ref, sub_ref, submit_ref, editor_ref, link_ref, ext_ref]))

        r = await call("type", {"ref": name_ref, "text": "Ada Lovelace", "clear": True})
        check("type clear", r["ok"] and r["result"].get("field_value") == "Ada Lovelace", r)
        r = await call("type", {"ref": name_ref, "text": " Jr"})
        check("type append", r["ok"] and r["result"].get("field_value") == "Ada Lovelace Jr", r)
        r = await call("type", {"ref": bio_ref, "text": "Line one\nLine two", "slowly": True})
        check("type slowly with newline", r["ok"] and r["result"].get("field_value") == "Line one\nLine two", r)
        r = await call("select_option", {"ref": color_ref, "values": ["Blue"]})
        check("select_option", r["ok"] and r["result"].get("selected") == ["Blue"], r)
        r = await call("click", {"ref": sub_ref})
        check("click checkbox", r["ok"], r)
        r = await call("click", {"ref": submit_ref})
        check("click submit", r["ok"], r)
        r = await call("get_text")
        text = r["result"]["text"]
        check("form submitted", "Submitted: name=Ada Lovelace Jr, color=b, subscribed=true, bio=Line one Line two" in text, text[:500])

        r = await call("type", {"ref": editor_ref, "text": "Replaced notes", "clear": True})
        check("contenteditable clear+type", r["ok"] and r["result"].get("field_value") == "Replaced notes", r)

        r = await call("key", {"keys": "Escape"})
        r2 = await call("get_text")
        check("key Escape", r["ok"] and "Last key: Escape" in r2["result"]["text"], r)
        r = await call("key", {"keys": "cmd+a"})
        r2 = await call("get_text")
        check("key cmd+a", r["ok"] and "Last key: a +meta" in r2["result"]["text"], r2["result"]["text"][:300])
        r = await call("key", {"keys": "bogus+x"})
        check("bad key rejected", not r["ok"] and r["error"]["code"] == "bad_request", r)

        # Coordinate click: needs a screenshot first for the scale.
        r = await call("screenshot", {"max_dimension": 1000})
        check("screenshot scaled", r["ok"] and r["result"]["image"]["width"] == 1000, r.get("error"))
        scale = r["result"]["scale"]
        save_image(r["result"], "shot_scaled")
        # #coordbtn is at left 700, top 120, 160x50 CSS px (page not scrolled yet).
        cx, cy = (700 + 80) * scale, (120 + 25) * scale
        r = await call("click", {"coordinate": [cx, cy]})
        r2 = await call("get_text")
        check("coordinate click", r["ok"] and "Coordinate click worked" in r2["result"]["text"], r)

        r = await call("scroll", {"direction": "down", "amount": 5})
        check("scroll down", r["ok"] and r["result"]["page"]["scroll_y"] > 0, r)
        r = await call("scroll", {"ref": submit_ref})
        check("scroll ref into view", r["ok"], r)

        r = await call("wait_for", {"text": "Late content arrived", "timeout_ms": 5000})
        check("wait_for text", r["ok"] and r["result"]["found"], r)
        r = await call("wait_for", {"text": "never appears", "timeout_ms": 1000})
        check("wait_for timeout", r["ok"] and r["result"]["found"] is False, r)

        r = await call("console")
        check("capture starts on first console call", r["ok"] and "Capture started" in r["result"].get("note", ""), r)
        msgs = [e["text"] for e in r["result"]["entries"]] if r["ok"] else []
        check("console captured", any("page loaded" in m for m in msgs) and any("deliberate test error" in m for m in msgs), msgs)
        r = await call("console", {"level": "error"})
        check("console level filter", r["ok"] and all(e["level"] == "error" for e in r["result"]["entries"]) and r["result"]["entries"], r)
        await call("navigate", {"action": "reload"})
        r = await call("network", {"pattern": "api/ping"})
        check("network captured after reload", r["ok"] and r["result"]["entries"] and r["result"]["entries"][0]["status"] == 200, r)

        r = await call("evaluate", {"expression": "1+1"})
        check("evaluate disabled by default", not r["ok"] and r["error"]["code"] == "javascript_disabled", r)
        await sw_eval("chrome.storage.local.set({allowJavaScript: true})")
        r = await call("evaluate", {"expression": "document.title + ' / ' + (6*7)"})
        check("evaluate enabled", r["ok"] and r["result"]["result"] == "Agent Test Page / 42", r)

        # External link: site not allowed stops the agent on that page.
        r = await call("read_page", {"filter": "interactive"})
        ext_ref = ref_for(r["result"]["text"], "link", "External link")
        r = await call("click", {"ref": ext_ref})
        check("navigation to unapproved site blocked", (not r["ok"]) and r["error"]["code"] == "site_not_allowed" and r["error"]["data"]["site"] == "example.org", r)
        r = await call("read_page")
        check("reads refused on unapproved site", (not r["ok"]) and r["error"]["code"] == "site_not_allowed", r)
        r = await call("navigate", {"action": "back"})
        check("navigate back allowed from unapproved site", r["ok"] and r["result"]["tab"]["url"].endswith("/index.html"), r)

        r = await call("read_page")
        link_ref = ref_for(r["result"]["text"], "link", "Go to page two")
        r = await call("click", {"ref": link_ref})
        check("click link navigates", r["ok"] and r["result"].get("navigated") and r["result"]["tab"]["title"] == "Page Two", r)
        r = await call("click", {"ref": submit_ref})
        check("stale ref detected", not r["ok"] and r["error"]["code"] == "stale_ref", r)
        r = await call("navigate", {"url": f"{SITE}/index.html"})
        check("navigate url", r["ok"] and r["result"]["tab"]["title"] == "Agent Test Page", r)

        # Second tab, opened in the background.
        r = await call("tabs_create", {"url": f"{SITE}/page2.html", "active": False})
        check("second tab", r["ok"], r)
        tab2 = r["result"]["tab"]["tab_id"]
        r = await call("tabs_list")
        check("tabs_list two tabs", r["ok"] and len(r["result"]["tabs"]) == 2, r)
        r = await call("screenshot", {"tab_id": tab2})
        check("background tab screenshot", r["ok"], r.get("error"))
        if r["ok"]:
            save_image(r["result"], "shot_background_tab")

        # Ownership: a tab outside the group is refused.
        other = await sw_eval(f"chrome.tabs.create({{url: '{SITE}/page2.html'}}).then(t => t.id)")
        r = await call("read_page", {"tab_id": other})
        check("foreign tab refused", not r["ok"] and r["error"]["code"] == "tab_not_owned", r)

        # User takeover: a trusted click from outside the agent pauses it.
        await asyncio.sleep(2)  # let the acting window lapse
        ws = target_ws(lambda t: t["type"] == "page" and t["url"].endswith("/index.html"))
        async with CDP(ws) as page:
            for kind in ("mousePressed", "mouseReleased"):
                await page.send("Input.dispatchMouseEvent", {"type": kind, "x": 400, "y": 400, "button": "left", "buttons": 1, "clickCount": 1})
        await asyncio.sleep(1)
        r = await call("session_info")
        check("user click pauses session", r["ok"] and r["result"]["session"]["paused"] and r["result"]["session"]["paused_reason"] == "user_input", r)
        r = await call("click", {"ref": "e2", "tab_id": tab1})
        check("act refused while paused", not r["ok"] and r["error"]["code"] == "paused", r)
        r = await call("screenshot", {"tab_id": tab1})
        check("reads allowed while paused", r["ok"], r.get("error"))
        check("paused event emitted", any(e["event"] == "session.paused" for e in bridge.events))
        # Resume through the real popup message path (popup page opened as a tab).
        await sw_eval("chrome.tabs.create({url: chrome.runtime.getURL('popup/popup.html')}).then(t => t.id)")
        await asyncio.sleep(1)
        resumed = await page_eval("popup/popup.html", "chrome.runtime.sendMessage({type: 'popup:resume', sessionId: 'test-session'})")
        check("popup resume message", resumed and resumed.get("ok") and resumed.get("result") is True, resumed)
        state = await page_eval("popup/popup.html", "chrome.runtime.sendMessage({type: 'popup:getState'})")
        check("popup state", state["ok"] and len(state["result"]["sessions"]) == 1 and not state["result"]["sessions"][0]["paused"], state)
        # A web page's content script context cannot use popup messages.
        spoof = await page_eval("index.html", "typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage ? 'reachable' : 'unreachable'")
        check("web page cannot message extension", spoof == "unreachable", spoof)
        r = await call("scroll", {"direction": "down", "tab_id": tab1})
        check("act works after resume", r["ok"], r)

        # Second session gets its own group and color.
        r = await call("tabs_create", {"url": f"{SITE}/page2.html"}, session={"id": "other", "label": "Other agent"})
        groups = await sw_eval("chrome.tabGroups.query({}).then(gs => gs.map(g => g.title + ':' + g.color).sort())")
        check("second session own group", r["ok"] and groups == ["🤖 Other agent:purple", "🤖 Test agent:blue"], groups)
        r = await call("read_page", {"tab_id": tab1}, session={"id": "other", "label": "Other agent"})
        check("session isolation", not r["ok"] and r["error"]["code"] == "tab_not_owned", r)

        r = await call("tabs_close", {"tab_id": tab2})
        r2 = await call("tabs_list")
        check("tabs_close", r["ok"] and len(r2["result"]["tabs"]) == 1, r2)

        r = await call("session_end", {"close_tabs": True}, session={"id": "other", "label": "Other agent"})
        check("session_end closes tabs", r["ok"] and r["result"]["closed_tabs"] == 1, r)

        # Bridge goes away: the extension detaches and clears overlays.
        overlay_before = await page_eval("index.html", "!!document.querySelector('agent-chrome-overlay')")
        check("overlay present before disconnect", overlay_before is True)
        hellos_before = bridge.hello_count
        await bridge.conn.close()
        await asyncio.sleep(0.8)
        overlay_after = await page_eval("index.html", "!!document.querySelector('agent-chrome-overlay')")
        check("overlay removed on disconnect", overlay_after is False)

        # And reconnects on its own.
        for _ in range(200):
            if bridge.hello_count > hellos_before and bridge.conn:
                break
            await asyncio.sleep(0.2)
        check("reconnected", bridge.hello_count > hellos_before)
        r = await call("tabs_list")
        check("reconnect keeps session", r["ok"] and len(r["result"]["tabs"]) == 1, r)
    finally:
        shutdown(proc, profile)
        await bridge.stop()
        site.shutdown()
    print("\nFAILURES:", FAILURES if FAILURES else "none")


asyncio.run(main())
