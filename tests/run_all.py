"""Run every suite and summarize. Pass --headed to use a visible browser window."""

import subprocess
import sys
from pathlib import Path

SUITES = ["test_units.py", "test_core.py", "test_page_events.py", "test_drag.py", "test_robustness.py", "test_review.py"]


def main():
    here = Path(__file__).resolve().parent
    extra = sys.argv[1:]
    failed = False
    for suite in SUITES:
        proc = subprocess.run([sys.executable, str(here / suite), *extra], capture_output=True, text=True, cwd=here)
        lines = proc.stdout.splitlines()
        passes = sum(line.startswith("PASS ") for line in lines)
        failures = [line for line in lines if line.startswith("FAIL ")]
        ok = proc.returncode == 0 and not failures and passes > 0
        failed |= not ok
        print(f"{'ok  ' if ok else 'FAIL'} {suite}: {passes} passed, {len(failures)} failed")
        for line in failures:
            print("     " + line[:300])
        if proc.returncode != 0:
            print("     " + (proc.stderr.strip().splitlines() or ["(no stderr)"])[-1])
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
