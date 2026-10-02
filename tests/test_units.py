"""See tests/README.md. Pure-logic checks (site rules, URLs, keys), run in Node."""
import json, subprocess, sys
from pathlib import Path

SCRIPT = r"""
globalThis.chrome = { storage: { onChanged: { addListener() {} }, local: { get: async (d) => d } } };
const s = await import('./lib/settings.js');
const p = await import('./lib/policy.js');
const k = await import('./lib/keys.js');
const rules = { allowAllSites: false, allowedSites: ['google.com', '*.github.com', '127.0.0.1'] };
const out = {
  normalize: ['www.google.com', '*.google.com', 'https://www.google.com/x', 'Example.COM.', 'localhost:3000', 'bad host'].map(s.normalizeSite),
  allowed: ['https://www.google.com/search', 'https://google.com', 'https://mail.google.com', 'https://github.com',
            'https://api.github.com', 'https://evilgithub.com', 'http://127.0.0.1:9/', 'http://localhost:1/',
            'chrome://settings', 'https://chromewebstore.google.com/x', 'about:blank'].map(u => p.checkUrl(u, rules).ok),
  urls: ['example.com', 'localhost:3000', '127.0.0.1:8000/x', 'example.com:8080/a', 'about:blank'].map(p.normalizeUrl),
  keys: ['ctrl++', 'cmd+shift+z', 'Down', 'space'].map(c => { const x = k.parseCombo(c); return [x.key, x.modifiers, k.keyDefinition(x.key, x.modifiers).code]; }),
};
console.log(JSON.stringify(out));
"""
EXPECTED = {
  "normalize": ["google.com", "*.google.com", "google.com", "example.com", "localhost", ""],
  "allowed": [True, True, False, True, True, False, True, False, False, False, True],
  "urls": ["https://example.com", "http://localhost:3000", "http://127.0.0.1:8000/x", "https://example.com:8080/a", "about:blank"],
  "keys": [["+", ["Control"], ""], ["z", ["Meta", "Shift"], "KeyZ"], ["Down", [], "ArrowDown"], ["space", [], "Space"]],
}

ext = Path(__file__).resolve().parent.parent
proc = subprocess.run(["node", "--input-type=module", "-e", SCRIPT], cwd=ext, capture_output=True, text=True)
if proc.returncode:
    print("FAIL node:", proc.stderr.strip()[-500:]); sys.exit(1)
got = json.loads(proc.stdout)
failed = False
for key, want in EXPECTED.items():
    ok = got[key] == want
    failed |= not ok
    print(("PASS " if ok else "FAIL ") + key + ("" if ok else f"  -- got {got[key]}"))
print("\nFAILURES:", "some" if failed else "none")
