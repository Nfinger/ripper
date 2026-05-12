#!/usr/bin/env python3
"""Run a Rhema-only Symphony daemon using the live onecli MCP proxy env.

This intentionally avoids storing Rhema's Linear token. It discovers the local
mcp-linear process whose proxy resolves to the Rhema Linear org, copies only the
proxy/CA environment, sets LINEAR_API_KEY=onecli-managed, and execs Symphony for
clients/rhema.WORKFLOW.md.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / "clients" / "rhema.WORKFLOW.md"
DIST = ROOT / "dist" / "index.js"

ENV_KEYS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "DENO_CERT",
    "NODE_USE_ENV_PROXY",
]


def candidate_pids() -> list[str]:
    out = subprocess.check_output(["ps", "auxww"], text=True)
    pids: list[str] = []
    for line in out.splitlines():
        if "mcp-linear" in line and "node" in line and "grep" not in line:
            parts = line.split(None, 2)
            if len(parts) >= 2:
                pids.append(parts[1])
    return pids


def env_from_pid(pid: str) -> dict[str, str]:
    out = subprocess.check_output(["ps", "eww", "-p", pid], text=True)
    env: dict[str, str] = {}
    for key in ENV_KEYS:
        m = re.search(r"(?:^|\s)" + re.escape(key) + r"=([^\s]+)", out)
        if m:
            env[key] = m.group(1)
    return env


def is_rhema_proxy(env: dict[str, str]) -> bool:
    if "HTTPS_PROXY" not in env and "HTTP_PROXY" not in env:
        return False
    script = """
const query = `query { organization { urlKey } teams(first:10) { nodes { key } } }`;
const res = await fetch('https://api.linear.app/graphql', {method:'POST', headers:{'Content-Type':'application/json', Authorization: 'onecli-managed'}, body: JSON.stringify({query})});
const json = await res.json();
if (json.errors) process.exit(2);
if (json.data?.organization?.urlKey === 'rhema-healthcare' && json.data?.teams?.nodes?.some(t => t.key === 'RMA')) process.exit(0);
process.exit(1);
"""
    runenv = os.environ.copy()
    runenv.update(env)
    runenv["LINEAR_API_KEY"] = "onecli-managed"
    res = subprocess.run(["/opt/homebrew/bin/node", "-e", script], env=runenv)
    return res.returncode == 0


def main() -> None:
    if not DIST.exists():
        print("dist/index.js missing; run pnpm build first", file=sys.stderr)
        sys.exit(1)
    for pid in candidate_pids():
        env = env_from_pid(pid)
        if is_rhema_proxy(env):
            runenv = os.environ.copy()
            runenv.update(env)
            runenv["LINEAR_API_KEY"] = "onecli-managed"
            runenv.setdefault("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/homebase/.local/bin")
            os.chdir(ROOT)
            args = [
                "/opt/homebrew/bin/node",
                str(DIST),
                str(PROFILE),
                "--port",
                "4323",
            ]
            if "--dry-run" in sys.argv[1:]:
                args.append("--dry-run")
            os.execve("/opt/homebrew/bin/node", args, runenv)
    print("No live onecli mcp-linear proxy for Rhema found", file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
