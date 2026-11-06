#!/usr/bin/env python3
"""Hive 截图：Playwright + 系统 Chrome（CDP 直连在本机网络受限，Playwright 正常）。"""
import json
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4400"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/screenshots")
OUT.mkdir(parents=True, exist_ok=True)


def login() -> str:
    req = urllib.request.Request(
        f"{BASE}/api/auth/login",
        data=json.dumps({"email": "lin.wei@hive.dev", "password": "hive-demo"}).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)["token"]


PAGES = [
    ("/login", "01-login", False),
    ("/", "02-dashboard", True),
    ("/projects", "03-projects", True),
    ("/projects/prj_orion", "04-project-overview", True),
    ("/projects/prj_orion/agents", "05-project-agents", True),
    ("/projects/prj_orion/tasks", "06-project-tasks", True),
    ("/projects/prj_orion/tasks?task=tsk_orion_running", "07-task-drawer", True),
    ("/projects/prj_orion/activity", "08-project-activity", True),
    ("/projects/prj_orion/automations", "09-project-automations", True),
    ("/projects/prj_orion/memory", "10-project-memory", True),
    ("/projects/prj_orion/settings", "11-project-settings", True),
    ("/teams", "12-teams", True),
    ("/teams/tm_rnd", "13-team-detail", True),
    ("/agents", "14-agents", True),
    ("/agents/agt_orion_coder", "15-agent-detail", True),
    ("/instances", "16-instances", True),
    ("/tasks", "17-tasks", True),
]

token = login()
with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    for path, name, authed in PAGES:
        context = browser.new_context(viewport={"width": 1600, "height": 1000}, device_scale_factor=1)
        if authed:
            context.add_init_script(f"localStorage.setItem('hive.token', {json.dumps(token)})")
        page = context.new_page()
        errors = []
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        try:
            page.goto(f"{BASE}{path}", wait_until="domcontentloaded", timeout=20000)
            page.wait_for_timeout(1400)
            page.wait_for_function("document.body.innerText.length > 200", timeout=8000)
            if name == "10-project-memory":
                field = page.locator('input[placeholder*="搜索项目记忆"]')
                field.fill("幂等")
                field.press("Enter")
                page.wait_for_timeout(1400)
            page.screenshot(path=str(OUT / f"{name}.png"), full_page=False)
            print(f"  ✓ {name}")
        except Exception as exc:  # noqa: BLE001
            print(f"  ✗ {name}: {exc}")
        if errors:
            print(f"    console errors: {errors[:2]}")
        context.close()
    browser.close()
print(f"完成：{OUT}")
