---
# Rhema — Linear team MFL, repo voice-health-vbc.
# Issues with prefix MFL-* are picked up here.
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  team_key: MFL
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled, Canceled, Duplicate, Closed]

polling:
  interval_ms: 60000

workspace:
  # Resolves relative to this WORKFLOW.md (clients/) → ./workspaces/rhema
  root: ../workspaces/rhema

hooks:
  after_create: |
    set -euo pipefail
    git clone --depth 50 git@github.com:davidclarkmoore/voice-health-vbc.git .
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
You are working on a Rhema (voice-health-vbc) issue from Linear team **MFL**.

## Issue
- **{{ issue.identifier }} — {{ issue.title }}**
- State: `{{ issue.state }}` · Priority: `{{ issue.priority }}` · URL: {{ issue.url }}
{% if issue.branch_name %}- Suggested git branch: `{{ issue.branch_name }}`{% endif %}
{% if issue.labels.size > 0 %}- Labels: {% for l in issue.labels %}`{{ l }}`{% unless forloop.last %}, {% endunless %}{% endfor %}{% endif %}
{% if issue.blocked_by.size > 0 %}- Blocked by: {% for b in issue.blocked_by %}{{ b.identifier }} ({{ b.state }}){% unless forloop.last %}, {% endunless %}{% endfor %}{% endif %}

## Description
{{ issue.description }}

## Working agreement
- Your CWD is the `voice-health-vbc` git workspace. Stay inside it.
- {% if attempt %}This is retry/continuation **attempt {{ attempt }}**. Inspect the workspace state before redoing work.{% else %}First attempt for this issue.{% endif %}
- Branch: use the suggested branch above if present; otherwise create `nate/{{ issue.identifier | downcase }}-<short-slug>` off `origin/main`.
- For research/assessment tickets (ERD remaps, codebase audits, cleanup plans), write the deliverable as markdown into `docs/` and treat the markdown PR as the handoff.
- For code change tickets, implement, run tests where they exist, commit with atomic messages.
- Handoff: push the branch, open a draft PR linking back to {{ issue.url }} with a clear summary, and move the Linear issue to `Human Review` (use the `linear_graphql` tool if advertised, otherwise leave a marked TODO line in the PR body).
- Stop when handed off to Human Review or when the issue can't be done autonomously (and explain why).
- Don't modify shared infra, secrets, or anything outside this workspace.

## Visual proof (REQUIRED before Human Review handoff for any UI-touching change)

For any change that affects what someone sees in a browser, you MUST attach visual proof to the Linear ticket so Nate can review without having to run the code himself. Symphony auto-uploads anything in `.symphony/artifacts/` after each turn.

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

