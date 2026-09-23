"""Exercise the shared Arena screens against a staged or deployed release.

Run with uv tool run --from playwright python scripts/verify_release_browser.py URL OUTPUT_DIR.
"""

import json
import re
import sys
import subprocess
import time
from pathlib import Path
from urllib.parse import urlencode
from playwright.sync_api import sync_playwright

base, target = sys.argv[1:]
base = base.rstrip("/") + "/"
out = Path(target)
out.mkdir(parents=True, exist_ok=True)
release = json.loads(
    subprocess.check_output(
        ["curl", "--fail", "--silent", "--show-error", "-L", base + "data/release.json"]
    )
)
square = next(t for t in release["tasks"] if t["id"] == "square_d2")
block = next(b for b in square["blocks"] if b["round"] == "R5")
policy = next(p for p in square["policies"] if p["round"] == "R5" and p["arm"] == "final_iql")
errors, requests, checks = [], [], []
with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path="/usr/bin/google-chrome",
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
        timeout=60000,
    )
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("request", lambda r: requests.append({"url": r.url, "method": r.method}))

    def go(params):
        page.goto(base + "?" + urlencode(params), wait_until="domcontentloaded")
        page.get_by_role("heading", name="Policy Arena", exact=True).wait_for()

    def shot(name):
        page.screenshot(path=str(out / (name + ".png")), animations="disabled")

    def wait_videos(count, exact=False):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            rows = page.locator("video").evaluate_all(
                "vs => vs.map(v => ({ready:v.readyState, width:v.videoWidth, error:v.error?.message}))"
            )
            enough = len(rows) == count if exact else len(rows) >= count
            if enough and all(
                r["ready"] >= 2 and r["width"] > 0 and not r.get("error") for r in rows
            ):
                return
            page.wait_for_timeout(250)
        raise AssertionError(f"Video readiness timed out: {rows}")

    go({"env": "square_d2", "round": "5"})
    page.get_by_text("72.0%", exact=False).first.wait_for()
    assert page.get_by_role("button", name="Labeling Lab", exact=True).count() == 0
    assert page.get_by_role("button", name="Sign in with Hugging Face").count() == 0
    page.wait_for_timeout(1200)
    shot("leaderboard")
    go({"env": "square_d2", "round": "5", "policy": policy["id"]})
    page.get_by_role("heading", name="Published success rate: 72.0%").wait_for()
    shot("policy-detail")
    checks.append("Canonical Square R5 result and policy drilldown")
    go({"tab": "sessions", "task": "square_d2", "session": block["id"]})
    page.get_by_role("button", name=re.compile("^Round 1 ")).first.click()
    wait_videos(3, exact=True)
    shot("session-videos")
    media = page.locator("video").evaluate_all(
        "(vs)=>vs.map(v=>({url:v.currentSrc,width:v.videoWidth,ready:v.readyState}))"
    )
    assert all("/resolve/" + block["revision"] + "/" in v["url"] for v in media)
    page.get_by_role("button", name="Play", exact=True).click()
    page.wait_for_timeout(1200)
    assert page.locator("video").evaluate_all("(vs)=>vs.every(v=>!v.paused && !v.error)")
    checks.append("Pinned three-arm synchronized evaluation video playback")
    go(
        {
            "tab": "pairings",
            "env": "square_d2",
            "policyA": square["policies"][-3]["id"],
            "policyB": policy["id"],
        }
    )
    page.get_by_text("50 total", exact=True).wait_for()
    shot("pairings")
    checks.append("Pairings filtered to selected policies")
    pair = square["blocks"][:2]
    go({"tab": "sessions", "view": "join", "join": ",".join(b["id"] for b in pair)})
    page.wait_for_timeout(1500)
    assert "Loading" not in page.locator("body").inner_text()
    shot("joined-sessions")
    checks.append("Joined-session comparison")
    go({"tab": "explorer", "dataset": block["dataset"], "episode": "0"})
    wait_videos(2)
    shot("data-explorer")
    checks.append("Multi-camera episode explorer")
    go(
        {
            "tab": "explorer",
            "dataset": "mulligan/real-marker-d2-c00-teleop-baseline",
            "episode": "0",
        }
    )
    wait_videos(2)
    checks.append("Pinned training dataset metadata and videos fetched from HF")
    sim = next(t for t in release["tasks"] if t["domain"] == "sim")
    point = sim["policies"][0]
    go({"env": sim["id"], "policy": point["id"]})
    page.get_by_text("Per-state evidence ↗", exact=True).first.wait_for()
    assert page.get_by_text("Per-state evidence ↗", exact=True).count() == 5
    shot("simulation")
    checks.append("Five simulation seeds and artifact links")
    go({"tab": "coverage"})
    page.get_by_text("Stage annotation coverage at release export", exact=False).wait_for()
    shot("coverage")
    checks.append("Scoped annotation coverage")
    page.set_viewport_size({"width": 390, "height": 844})
    go({"env": "square_d2", "round": "5"})
    page.wait_for_timeout(1200)
    shot("mobile")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    checks.append("Mobile layout without page overflow")
    assert not errors, errors
    assert not [r for r in requests if "convex.cloud" in r["url"] or "convex.site" in r["url"]], (
        "Live backend request"
    )
    assert not [r for r in requests if r["method"] not in ("GET", "HEAD")], (
        "Unexpected browser write"
    )
    checks.append("No live backend traffic or write requests")
    report = {"url": base, "checks": checks, "errors": errors, "media": media}
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)
    browser.close()
