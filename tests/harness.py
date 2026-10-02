"""Test harness: a stand-in bridge, a local test site, and Chrome for Testing
with the extension loaded, to exercise the extension end to end.

Branded Google Chrome no longer honors --load-extension, so this uses Chrome
for Testing: set CHROME_FOR_TESTING, or install one with
`npx @playwright/test install chromium` (found under ~/Library/Caches/ms-playwright).
"""

import asyncio
import base64
import glob
import http.server
import itertools
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import urllib.request
from pathlib import Path

from websockets.asyncio.client import connect as ws_connect
from websockets.asyncio.server import serve
from websockets.http11 import Response
from websockets.datastructures import Headers

TESTS_DIR = Path(__file__).resolve().parent
EXT_DIR = TESTS_DIR.parent
OUTPUT_DIR = Path(tempfile.gettempdir()) / "agent-chrome-tests"
OUTPUT_DIR.mkdir(exist_ok=True)
EXT_ID = "cbclhcbmllbpkhmpcpgiccknlodiljpe"


def find_chrome():
    configured = os.environ.get("CHROME_FOR_TESTING")
    if configured:
        return configured
    pattern = os.path.expanduser(
        "~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    )
    found = sorted(glob.glob(pattern), key=lambda p: int(re.search(r"chromium-(\d+)", p).group(1)))
    if not found:
        raise SystemExit("Chrome for Testing not found: set CHROME_FOR_TESTING (see harness.py docstring).")
    return found[-1]


CHROME = find_chrome()
BRIDGE_PORT = 18765
SITE_PORT = 18799
DEBUG_PORT = 9333


def start_site():
    site_dir = TESTS_DIR / "site"

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(site_dir), **kw)

        def do_GET(self):
            if self.path.startswith("/api/ping"):
                body = b'{"pong": "hello from test api"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            super().do_GET()

        def log_message(self, *a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", SITE_PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class Bridge:
    def __init__(self):
        self.conn = None
        self.hello = None
        self.hello_count = 0
        self.connected = asyncio.Event()
        self.pending = {}
        self.events = []
        self.ids = itertools.count(1)
        self.origins = []
        self.server = None

    async def start(self):
        async def process_request(connection, request):
            if request.path == "/health":
                body = json.dumps({"service": "agent-chrome-bridge", "version": "test"}).encode()
                return Response(200, "OK", Headers([("Content-Type", "application/json"), ("Content-Length", str(len(body)))]), body)
            if request.path != "/extension":
                return connection.respond(404, "not found\n")
            origin = request.headers.get("Origin")
            self.origins.append(origin)
            if origin != f"chrome-extension://{EXT_ID}":
                return connection.respond(403, "wrong origin\n")
            return None

        async def handler(conn):
            self.conn = conn
            async for raw in conn:
                msg = json.loads(raw)
                t = msg.get("type")
                if t == "hello":
                    self.hello = msg
                    self.hello_count += 1
                    await conn.send(json.dumps({"type": "welcome", "bridge": {"version": "test"}}))
                    self.connected.set()
                elif t == "response":
                    fut = self.pending.pop(msg["id"], None)
                    if fut and not fut.done():
                        fut.set_result(msg)
                elif t == "event":
                    self.events.append(msg)
                    print("  [event]", msg.get("event"), json.dumps(msg.get("data")))
            self.conn = None
            self.connected.clear()

        self.server = await serve(handler, "127.0.0.1", BRIDGE_PORT, process_request=process_request, max_size=64 * 1024 * 1024)

    async def call(self, method, params=None, session=None, timeout=60):
        req_id = f"r{next(self.ids)}"
        fut = asyncio.get_running_loop().create_future()
        self.pending[req_id] = fut
        await self.conn.send(json.dumps({
            "type": "request",
            "id": req_id,
            "method": method,
            "params": params or {},
            "session": session or {"id": "test-session", "label": "Test agent"},
        }))
        return await asyncio.wait_for(fut, timeout)

    async def stop(self):
        self.server.close()
        await self.server.wait_closed()


class CDP:
    """Minimal DevTools client for the harness's own inspection."""

    def __init__(self, ws_url):
        self.ws_url = ws_url
        self.ids = itertools.count(1)

    async def __aenter__(self):
        self.ws = await ws_connect(self.ws_url, max_size=64 * 1024 * 1024)
        return self

    async def __aexit__(self, *exc):
        await self.ws.close()

    async def send(self, method, params=None):
        msg_id = next(self.ids)
        await self.ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == msg_id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg["result"]

    async def eval(self, expression):
        res = await self.send("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
        if "exceptionDetails" in res:
            raise RuntimeError(res["exceptionDetails"])
        return res["result"].get("value")


def targets():
    with urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/list") as r:
        return json.load(r)


def target_ws(predicate):
    for t in targets():
        if predicate(t):
            return t["webSocketDebuggerUrl"]
    return None


async def sw_eval(expression):
    url = None
    for _ in range(50):
        url = target_ws(lambda t: t["type"] == "service_worker" and EXT_ID in t["url"])
        if url:
            break
        await asyncio.sleep(0.2)
    async with CDP(url) as c:
        return await c.eval(expression)


async def page_eval(url_substring, expression):
    url = target_ws(lambda t: t["type"] == "page" and url_substring in t["url"])
    async with CDP(url) as c:
        return await c.eval(expression)


def launch_chrome(headless=True):
    profile = tempfile.mkdtemp(prefix="agent-chrome-test-")
    args = [
        CHROME,
        f"--user-data-dir={profile}",
        f"--load-extension={EXT_DIR}",
        f"--disable-extensions-except={EXT_DIR}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-search-engine-choice-screen",
        f"--remote-debugging-port={DEBUG_PORT}",
        "--window-size=1280,860",
    ]
    if headless:
        args.append("--headless=new")
    args.append("about:blank")
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return proc, profile


async def reload_extension():
    """Reload the extension the way its reload button on chrome://extensions
    does. Developer mode must be on (as it is for anyone who loaded it
    unpacked); otherwise Chrome disables the reloaded copy."""
    await sw_eval("chrome.tabs.create({url: 'chrome://extensions', active: false})")
    await asyncio.sleep(1.5)
    ws = target_ws(lambda t: t["url"].startswith("chrome://extensions"))
    async with CDP(ws) as page:
        await page.eval("chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true})")
        return await page.eval(
            f"chrome.developerPrivate.reload('{EXT_ID}', {{failQuietly: true}}).then(() => 'ok', e => 'err ' + e)"
        )


def save_image(result, name):
    img = result["image"]
    ext = "png" if img["mime"] == "image/png" else "jpg"
    path = OUTPUT_DIR / f"{name}.{ext}"
    path.write_bytes(base64.b64decode(img["data"]))
    return path


def shutdown(proc, profile):
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
    shutil.rmtree(profile, ignore_errors=True)
