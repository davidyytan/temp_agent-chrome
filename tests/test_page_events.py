"""See tests/README.md."""
import asyncio, base64, json, re, sys
from harness import Bridge, SITE_PORT, launch_chrome, shutdown, start_site, sw_eval

SITE = f"http://127.0.0.1:{SITE_PORT}"
FAILURES = []

def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  -- {json.dumps(detail)[:900]}" if not cond else ""))
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
        r = await call("tabs_create", {"url": f"{SITE}/index.html"}); tab1 = r["result"]["tab"]["tab_id"]
        snap = (await call("read_page"))["result"]["text"]
        refs = {k: ref_for(snap, "button", k) for k in ["Show alert", "Delete item", "Ask city", "Arm leave warning", "Open popup window", "Upload files"]}
        refs["newtab"] = ref_for(snap, "link", "Open page two in new tab")
        refs["drop"] = ref_for(snap, "region", "Drop zone")
        check("refs", all(refs.values()), refs)

        async def result_text():
            t = (await call("get_text"))["result"]["text"]
            return re.search(r"(no dialog yet|after alert|confirmed|cancelled|prompt: [^\n]*|leave warning armed)", t).group(1)

        # alert: auto-dismissed and reported
        r = await call("click", {"ref": refs["Show alert"]})
        check("alert auto-dismissed + reported", r["ok"] and r["result"].get("dialogs_shown", [{}])[0].get("message") == "Hello from alert", r)
        check("page continued after alert", await result_text() == "after alert")

        # confirm: click succeeds with dialog; page blocked until answered
        r = await call("click", {"ref": refs["Delete item"]}, timeout=40)
        check("confirm surfaces as dialog", r["ok"] and r["result"].get("dialog", {}).get("type") == "confirm" and r["result"]["dialog"]["message"] == "Delete the item?", r)
        r = await call("screenshot")
        check("other calls refused while dialog open", not r["ok"] and r["error"]["code"] == "dialog_open", r)
        r = await call("tabs_list")
        check("tabs_list shows dialog", r["ok"] and r["result"]["tabs"][0].get("dialog", {}).get("type") == "confirm", r)
        r = await call("handle_dialog", {"accept": False})
        check("handle_dialog cancel", r["ok"] and r["result"]["answered"]["accept"] is False, r)
        check("page saw cancel", await result_text() == "cancelled")
        r = await call("click", {"ref": refs["Delete item"]}, timeout=40)
        r = await call("handle_dialog", {"accept": True})
        check("page saw confirm", r["ok"] and await result_text() == "confirmed", r)
        r = await call("handle_dialog", {"accept": True})
        check("handle_dialog without dialog", not r["ok"] and r["error"]["code"] == "no_dialog", r)

        # prompt with text
        r = await call("click", {"ref": refs["Ask city"]}, timeout=40)
        check("prompt surfaces with default", r["ok"] and r["result"].get("dialog", {}).get("default_prompt") == "Paris", r)
        r = await call("handle_dialog", {"accept": True, "prompt_text": "Lisbon"})
        check("prompt answered", r["ok"] and await result_text() == "prompt: Lisbon", r)

        # beforeunload during agent navigation: accepted, reported
        await call("click", {"ref": refs["Arm leave warning"]})
        r = await call("navigate", {"url": f"{SITE}/page2.html"}, timeout=40)
        check("beforeunload accepted on agent navigation", r["ok"] and r["result"]["tab"]["title"] == "Page Two" and any(d["type"] == "beforeunload" for d in r["result"].get("dialogs_shown", [])), r)
        await call("navigate", {"url": f"{SITE}/index.html"})
        snap = (await call("read_page"))["result"]["text"]
        refs = {k: ref_for(snap, "button", k) for k in ["Open popup window", "Upload files"]}
        refs["newtab"] = ref_for(snap, "link", "Open page two in new tab")
        refs["drop"] = ref_for(snap, "region", "Drop zone")

        # target=_blank: adopted into group, becomes current
        r = await call("click", {"ref": refs["newtab"]})
        opened = r["result"].get("opened_tabs", []) if r["ok"] else []
        check("new tab reported", len(opened) == 1 and opened[0]["title"] == "Page Two" and opened[0]["current"], r)
        r = await call("tabs_list")
        check("new tab in group + current", r["ok"] and len(r["result"]["tabs"]) == 2 and any(t["current"] and t["title"] == "Page Two" for t in r["result"]["tabs"]), r)
        newtab_id = opened[0]["tab_id"] if opened else None
        r = await call("read_page")
        check("agent reads the new tab by default", r["ok"] and "Second page" in r["result"]["text"], r)
        await call("tabs_close", {"tab_id": newtab_id})

        # popup window (window.open with features): owned by id
        r = await call("click", {"ref": refs["Open popup window"], "tab_id": tab1})
        opened = r["result"].get("opened_tabs", []) if r["ok"] else []
        check("popup window reported", len(opened) == 1 and opened[0]["title"] == "Page Two", r)
        popup_id = opened[0]["tab_id"] if opened else None
        wtype = await sw_eval(f"chrome.tabs.get({popup_id}).then(t => chrome.windows.get(t.windowId)).then(w => w.type)") if popup_id else None
        check("popup is a popup window", wtype == "popup", wtype)
        r = await call("get_text", {"tab_id": popup_id})
        check("agent can read popup", r["ok"] and "Second page" in r["result"]["text"], r)
        r = await call("session_info")
        check("popup listed in session tabs", r["ok"] and any(t["tab_id"] == popup_id for t in r["result"]["tabs"]), r)
        await call("tabs_close", {"tab_id": popup_id})
        r = await call("session_info")
        check("closed popup forgotten", r["ok"] and len(r["result"]["tabs"]) == 1, r)

        # file chooser interception + upload
        r = await call("click", {"ref": refs["Upload files"], "tab_id": tab1})
        fc = r["result"].get("file_chooser") if r["ok"] else None
        check("file chooser intercepted", fc and fc["ref"] and fc["multiple"] is True, r)
        files = [
            {"name": "hello.txt", "mime": "text/plain", "data": base64.b64encode(b"hello world").decode()},
            {"name": "data.csv", "mime": "text/csv", "data": base64.b64encode(b"a,b\n1,2").decode()},
        ]
        r = await call("upload_file", {"ref": fc["ref"] if fc else "e1-0000", "files": files})
        t = (await call("get_text"))["result"]["text"]
        check("upload via file input", r["ok"] and r["result"]["via"] == "file input" and "files: hello.txt(11 bytes, text/plain): hello world | data.csv(7 bytes, text/csv): a,b" in t, [r, t[-400:]])
        r = await call("upload_file", {"ref": refs["drop"], "files": files[:1]})
        t = (await call("get_text"))["result"]["text"]
        check("upload via drop zone", r["ok"] and r["result"]["via"] == "drop" and "files: hello.txt(11 bytes, text/plain): hello world" in t.split("nothing dropped")[0] + t[t.find("Drop files here"):], [r, t[-300:]])

        # find_text
        r = await call("find_text", {"query": "filler paragraph 7"})
        check("find_text literal", r["ok"] and r["result"]["total"] == 11 and r["result"]["matches"][0]["match"] == "Filler paragraph 7", r)
        r = await call("find_text", {"query": r"paragraph \d+", "regex": True, "max_results": 3})
        check("find_text regex", r["ok"] and r["result"]["total"] == 80 and len(r["result"]["matches"]) == 3 and r["result"]["truncated"], r)

        # takeover turns file chooser interception off
        await sw_eval("(async () => { await chrome.storage.session.get(); })()")
    finally:
        shutdown(proc, profile); await bridge.stop(); site.shutdown()
    print("\nFAILURES:", FAILURES or "none")

asyncio.run(main())
