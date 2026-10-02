"""See tests/README.md."""
import asyncio, json, re, sys, time
from harness import Bridge, SITE_PORT, launch_chrome, shutdown, start_site, sw_eval

SITE = f"http://127.0.0.1:{SITE_PORT}"
FAILURES = []

def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  -- {json.dumps(detail)[:700]}" if not cond else ""))
    if not cond: FAILURES.append(name)

def ref_for(snapshot, role, name):
    m = re.search(rf'- {re.escape(role)} "{re.escape(name)}"[^\n]*\[ref=(e\d+-[0-9a-z]{{4}})\]', snapshot)
    return m.group(1) if m else None

async def main():
    site = start_site(); bridge = Bridge(); await bridge.start()
    proc, profile = launch_chrome(headless="--headed" not in sys.argv)
    call = bridge.call
    try:
        await asyncio.wait_for(bridge.connected.wait(), 40)
        await sw_eval("chrome.storage.local.set({allowAllSites: false, allowedSites: ['127.0.0.1']})")
        await call("tabs_create", {"url": f"{SITE}/index.html"})
        snap = (await call("read_page"))["result"]["text"]
        name_ref, bio_ref = ref_for(snap, "textbox", "Your name"), ref_for(snap, "textbox", "Bio")

        # Two actions on one tab at once must not interleave their input.
        a, b = await asyncio.gather(
            call("type", {"ref": name_ref, "text": "Grace Hopper", "clear": True}),
            call("type", {"ref": bio_ref, "text": "Rear admiral", "clear": True}),
        )
        check("concurrent actions on one tab are serialized",
              a["ok"] and b["ok"] and a["result"].get("field_value") == "Grace Hopper" and b["result"].get("field_value") == "Rear admiral", [a, b])

        # Enter submits the form.
        r = await call("type", {"ref": name_ref, "text": "Ada", "clear": True, "submit": True})
        text = (await call("get_text"))["result"]["text"]
        check("type with submit presses Enter", r["ok"] and "Submitted: name=Ada," in text, [r, text[:300]])

        # A confirm while a page loads returns promptly instead of waiting out the load timeout.
        start = time.monotonic()
        r = await call("navigate", {"url": f"{SITE}/confirm_on_load.html"}, timeout=40)
        elapsed = time.monotonic() - start
        check("confirm during load surfaces quickly", r["ok"] and r["result"].get("dialog", {}).get("message") == "Stay on this page?" and elapsed < 8, [round(elapsed, 1), r])
        r = await call("handle_dialog", {"accept": True})
        text = (await call("get_text"))["result"]["text"] if r["ok"] else ""
        check("page continues after answering", r["ok"] and "answer: yes" in text, [r, text])

        # Same through tabs_create.
        start = time.monotonic()
        r = await call("tabs_create", {"url": f"{SITE}/confirm_on_load.html"}, timeout=40)
        elapsed = time.monotonic() - start
        check("confirm during tabs_create load surfaces quickly", r["ok"] and r["result"].get("dialog", {}).get("type") == "confirm" and elapsed < 8, [round(elapsed, 1), r])
        r = await call("handle_dialog", {"accept": False})
        text = (await call("get_text"))["result"]["text"] if r["ok"] else ""
        check("cancel reaches the page", r["ok"] and "answer: no" in text, [r, text])
        # The 30-second reconnect alarm must only reconnect, never release tabs.
        r = await call("tabs_create", {"url": f"{SITE}/index.html"})
        alarm_tab = r["result"]["tab"]["tab_id"]
        attached = "chrome.debugger.getTargets().then(ts => ts.filter(t => t.attached && t.tabId === %d).length)" % alarm_tab
        before = await sw_eval(attached)
        await sw_eval("chrome.alarms.create('agent-chrome-reconnect', {when: Date.now() + 100})")
        await asyncio.sleep(1.5)
        after = await sw_eval(attached)
        await sw_eval("chrome.alarms.create('agent-chrome-reconnect', {periodInMinutes: 0.5})")
        r = await call("scroll", {"direction": "down", "tab_id": alarm_tab})
        check("reconnect alarm leaves agent tabs attached", before == 1 and after == 1 and r["ok"], [before, after, r.get("error")])

        # Minimized agent window (only meaningful with a real window): no hangs.
        # Mouse actions refuse at once; typing, keys, scrolling, reading work.
        if "--headed" in sys.argv:
            r = await call("tabs_create", {"url": f"{SITE}/index.html"}, session={"id": "minimized", "label": "Minimized"})
            mtab = r["result"]["tab"]["tab_id"]
            win = await sw_eval(f"chrome.tabs.get({mtab}).then(t => t.windowId)")
            await sw_eval(f"chrome.windows.update({win}, {{state: 'minimized'}})")
            await asyncio.sleep(2)
            m = {"id": "minimized", "label": "Minimized"}
            snap = (await call("read_page", session=m))["result"]["text"]
            start = time.monotonic()
            r = await call("click", {"ref": ref_for(snap, "button", "Submit")}, session=m, timeout=40)
            check("minimized: click works without delay", r["ok"] and time.monotonic() - start < 3, r)
            start = time.monotonic()
            r = await call("hover", {"ref": ref_for(snap, "button", "Submit")}, session=m, timeout=40)
            check("minimized: hover refused at once", not r["ok"] and r["error"]["code"] == "window_hidden" and time.monotonic() - start < 3, r)
            start = time.monotonic()
            r = await call("scroll", {"direction": "down", "amount": 5}, session=m, timeout=40)
            check("minimized: scroll works", r["ok"] and r["result"]["page"]["scroll_y"] > 0 and time.monotonic() - start < 3, r)
            r = await call("type", {"ref": ref_for(snap, "textbox", "Your name"), "text": "while minimized", "clear": True}, session=m, timeout=40)
            check("minimized: typing into a field works", r["ok"] and r["result"].get("field_value") == "while minimized", r)
            r = await call("screenshot", session=m, timeout=40)
            check("minimized: screenshot works", r["ok"], r.get("error"))
            await call("session_end", {"close_tabs": True}, session=m)
        else:
            print("SKIP minimized-window checks (need --headed)")

        # Several agents at once: one session per agent-core UUID, each with its
        # own window and group, working in parallel without crossing over.
        agents = [{"id": f"6f1c2a4e-0000-4000-8000-00000000000{i}", "label": f"Agent {i}"} for i in (1, 2, 3)]

        async def agent_task(agent, value):
            r = await call("tabs_create", {"url": f"{SITE}/index.html"}, session=agent)
            if not r["ok"]:
                return r
            snap = (await call("read_page", session=agent))["result"]["text"]
            r = await call("type", {"ref": ref_for(snap, "textbox", "Your name"), "text": value, "clear": True}, session=agent)
            await call("click", {"ref": ref_for(snap, "button", "Submit")}, session=agent)
            text = (await call("get_text", session=agent))["result"]["text"]
            tabs = (await call("tabs_list", session=agent))["result"]["tabs"]
            return {"field": r["result"].get("field_value"), "submitted": f"name={value}," in text, "tabs": [t["tab_id"] for t in tabs]}

        results = await asyncio.gather(*(agent_task(a, f"agent-{i}") for i, a in enumerate(agents, 1)))
        check("three agents work in parallel", all(r.get("field") == f"agent-{i}" and r.get("submitted") for i, r in enumerate(results, 1)), results)
        tab_sets = [set(r.get("tabs", [])) for r in results]
        check("each agent sees only its own tab", all(len(t) == 1 for t in tab_sets) and len(set().union(*tab_sets)) == 3, results)
        groups = await sw_eval("chrome.tabGroups.query({}).then(gs => gs.map(g => g.title).filter(t => t.includes('Agent ')).sort())")
        windows = await sw_eval("chrome.windows.getAll().then(ws => ws.length)")
        check("one group and window per agent", groups == ["🤖 Agent 1", "🤖 Agent 2", "🤖 Agent 3"] and windows >= 4, [groups, windows])
        other_tab = results[1]["tabs"][0]
        r = await call("click", {"tab_id": other_tab, "coordinate": [10, 10]}, session=agents[0])
        check("an agent cannot touch another agent's tab", not r["ok"] and r["error"]["code"] == "tab_not_owned", r)
        r = await call("session_end", {"close_tabs": True}, session=agents[2])
        r2 = await call("tabs_list", session=agents[1])
        check("ending one agent leaves the others alone", r["ok"] and r2["ok"] and len(r2["result"]["tabs"]) == 1, [r, r2])
    finally:
        shutdown(proc, profile); await bridge.stop(); site.shutdown()
    print("\nFAILURES:", FAILURES or "none")

asyncio.run(main())
