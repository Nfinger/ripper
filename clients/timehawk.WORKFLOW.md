---
# TimeHawk — Jira project TH at https://timehawk.atlassian.net.
# Repo at github.com:Timehawk-LLC/timehawk requires the nfinger-verveit SSH
# key, accessed via the `github-verveit` host alias in ~/.ssh/config.
tracker:
  kind: jira
  endpoint: https://timehawk.atlassian.net
  email: $TIMEHAWK_JIRA_EMAIL
  api_key: $TIMEHAWK_JIRA_TOKEN
  project_slug: TH
  active_states: ["To Do", "In Progress"]
  terminal_states: ["Done", "Cancelled", "Closed"]

polling:
  interval_ms: 60000

workspace:
  root: ../workspaces/timehawk

hooks:
  after_create: |
    set -euo pipefail
    git clone --depth 50 git@github-verveit:Timehawk-LLC/timehawk.git .
    git config user.email "symphony@local"
    git config user.name "symphony"
  before_run: |
    set -euo pipefail
    git fetch origin main --depth 50 || true
  after_run: |
    git status --porcelain | head -50 || true

agent:
  max_concurrent_agents: 1
  max_turns: 1
  max_retry_attempts: 1
  max_total_tokens_per_daemon: 200000

agent_runtime:
  kind: codex
  command: HOME=/Users/homebase/.hermes/profiles/home/home codex exec --json --dangerously-bypass-approvals-and-sandbox -m gpt-5.5
  permission_mode:
  turn_timeout_ms: 3600000
  stall_timeout_ms: 600000
---
You are working on a TimeHawk issue from Jira project **TH** (`https://timehawk.atlassian.net`).

## Issue
- **{{ issue.identifier }} — {{ issue.title }}**
- State: `{{ issue.state }}` · Priority: `{{ issue.priority }}`
{% if issue.labels.size > 0 %}- Labels: {% for l in issue.labels %}`{{ l }}`{% unless forloop.last %}, {% endunless %}{% endfor %}{% endif %}
{% if issue.blocked_by.size > 0 %}- Blocked by: {% for b in issue.blocked_by %}{{ b.identifier }} ({{ b.state }}){% unless forloop.last %}, {% endunless %}{% endfor %}{% endif %}

## Description
{{ issue.description }}

## Working agreement
- CWD is the `timehawk` git workspace (cloned via the `github-verveit` SSH alias). Stay inside it.
- {% if attempt %}Attempt {{ attempt }} — review the workspace state before redoing.{% else %}First attempt.{% endif %}
- Branch off `origin/main` using `nate/{{ issue.identifier | downcase }}-<short-slug>`.
- Implement, run tests, commit with atomic messages.
- Handoff: push, open a draft PR linking back to https://timehawk.atlassian.net/browse/{{ issue.identifier }} with a summary, transition the Jira issue to a review status (TimeHawk's workflow — `In Review` is the typical name).
- Stop on handoff or unresolvable. Don't modify infra, secrets, or anything outside the workspace.

## Visual proof (REQUIRED before Human Review handoff for any UI-touching change)

For any change that affects what someone sees in a browser, you MUST attach visual proof to the Jira ticket so Nate can review without having to run the code himself. Symphony auto-uploads anything in `.symphony/artifacts/` after each turn.

You have two ways to produce proof:

1. **Playwright MCP** (`mcp__playwright__*`) — for interactive exploration, navigation, screenshots. Save screenshots into `.symphony/artifacts/<descriptive-name>.png`. Multiple screenshots tell a story; use `01-`, `02-`, `03-` prefixes so they sort correctly.
2. **Screen recording** (preferred when there's any motion / interaction) — write a short JSON config and run the recorder:
   ```bash
   cat > .symphony/record.json <<'EOF'
   {
     "url": "http://localhost:3000/your-feature",
     "viewport": [1280, 720],
     "output": ".symphony/artifacts/<feature>-demo.webm",
     "default_wait_ms": 600,
     "headless": true,
     "steps": [
       { "type": "wait", "ms": 1500 },
       { "type": "click", "selector": "[data-testid=open]" },
       { "type": "wait", "ms": 2000 }
     ]
   }
   EOF
   node /Users/homebase/ai/symphony/clients/_shared/playwright-record.mjs .symphony/record.json
   ```
   See `/Users/homebase/ai/symphony/clients/_shared/playwright-record.example.json` for the full schema (navigate, click, fill, press, hover, scroll, screenshot, wait_for, wait).

Don't add visual proof for changes that have no UI surface (DB migrations, internal refactors, infra). For those, save a brief markdown summary or test-output capture into `.symphony/artifacts/` instead — anything Nate would want to see while reviewing.

