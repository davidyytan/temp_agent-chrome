import asyncio, json, re, sys
from harness import Bridge, SITE_PORT, launch_chrome, shutdown, start_site, sw_eval

SITE = f"http://127.0.0.1:{SITE_PORT}"
FAILURES = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  -- {json.dumps(detail)[:700]}" if not cond else ""))
    if not cond: FAILURES.append(name)
def ref_for(snapshot, role, name):
    m = re.search(rf'- {re.escape(role)} "{re.escape(name)}"[^\n]*\[ref=(e\d+-[0-9a-z]{{4}})\]', snapshot)
    return m.group(1) if m else None
def find(text, pattern):
    m = re.search(pattern, text); return m.group(0) if m else None

async def main():
    site = start_site(); bridge = Bridge(); await bridge.start()
    proc, profile = launch_chrome(headless="--headed" not in sys.argv)
    call = bridge.call
    try:
        await asyncio.wait_for(bridge.connected.wait(), 40)
        await sw_eval("chrome.storage.local.set({allowedSites: ['127.0.0.1']})")
        await call("tabs_create", {"url": f"{SITE}/index.html"})
        await call("scroll", {"direction": "down", "amount": 4})
        snap = (await call("read_page"))["result"]["text"]
        refs = {"card": ref_for(snap, "button", "Drag card"), "target": ref_for(snap, "region", "Drop target"),
                "thumb": ref_for(snap, "slider", "Volume"), "loud": ref_for(snap, "image", "Loud"),
                "bright": ref_for(snap, "slider", "Brightness"), "sun": ref_for(snap, "image", "Bright")}
        check("refs", all(refs.values()), refs)

        r = await call("drag", {"ref": refs["card"], "to_ref": refs["target"]})
        text = (await call("get_text"))["result"]["text"]
        check("native HTML5 drag and drop", r["ok"] and r["result"]["native_drag"] is True and "dropped: card-1" in text, [r, find(text, r"(not dropped|dropped: \S+)")])

        r = await call("drag", {"ref": refs["thumb"], "to_ref": refs["loud"]})
        text = (await call("get_text"))["result"]["text"]
        check("pointer-driven slider drag", r["ok"] and r["result"]["native_drag"] is False and "volume 100" in text and "(moving)" not in find(text, r"volume[^\n]*"), [r, find(text, r"volume[^\n]*")])

        r = await call("drag", {"ref": refs["bright"], "to_ref": refs["sun"]})
        text = (await call("get_text"))["result"]["text"]
        check("native range slider drag", r["ok"] and "brightness 100" in text, [r, find(text, r"brightness \d+")])

        # Coordinate drag: slider back to the start, using screenshot pixels.
        shot = await call("screenshot", {"max_dimension": 1000})
        scale = shot["result"]["scale"]
        await sw_eval("chrome.storage.local.set({allowJavaScript: true})")
        rect = json.loads((await call("evaluate", {"expression": "JSON.stringify([document.getElementById('thumb').getBoundingClientRect(), document.getElementById('track').getBoundingClientRect()].map(r => [r.x, r.y, r.width, r.height]))"}))["result"]["result"])
        (tx, ty, tw, th), (kx, ky, kw, kh) = rect
        r = await call("drag", {"coordinate": [(tx + tw / 2) * scale, (ty + th / 2) * scale], "to_coordinate": [(kx - 30) * scale, (ky + kh / 2) * scale]})
        text = (await call("get_text"))["result"]["text"]
        check("coordinate drag", r["ok"] and "volume 0" in text, [r, find(text, r"volume[^\n]*")])

        # The page still takes normal clicks after drags (no stuck mouse button).
        r = await call("click", {"ref": ref_for(snap, "button", "Show alert")})
        check("clicks still work after drags", r["ok"] and r["result"].get("dialogs_shown"), r)

        r = await call("drag", {"ref": refs["card"]})
        check("drag needs a target", not r["ok"] and r["error"]["code"] == "bad_request", r)
    finally:
        shutdown(proc, profile); await bridge.stop(); site.shutdown()
    print("\nFAILURES:", FAILURES or "none")
asyncio.run(main())
