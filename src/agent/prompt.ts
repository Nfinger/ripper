import { Liquid } from 'liquidjs';

import type { Issue } from '../workflow/types.js';

export type PromptError =
  | { code: 'template_parse_error'; message: string }
  | { code: 'template_render_error'; message: string };

export type PromptResult = { ok: true; value: string } | { ok: false; error: PromptError };

export interface PromptInputs {
  issue: Issue;
  attempt: number | null;
  turn?: number;
}

const liquidEngine = new Liquid({
  strictVariables: true,
  strictFilters: true,
  ownPropertyOnly: false,
});

/**
 * Spec §5.4 / §12.2 — strict variable + filter checking. `attempt` is `null`
 * for first run, integer for retry/continuation.
 */
export async function renderPrompt(template: string, inputs: PromptInputs): Promise<PromptResult> {
  let parsed;
  try {
    parsed = liquidEngine.parse(template);
  } catch (err) {
    const message = (err as Error).message;
    const code: PromptError['code'] = /filter\s|undefined filter/i.test(message)
      ? 'template_render_error'
      : 'template_parse_error';
    return { ok: false, error: { code, message } };
  }
  try {
    const out = await liquidEngine.render(parsed, {
      issue: issueAsTemplateInput(inputs.issue),
      attempt: inputs.attempt,
      ...(inputs.turn !== undefined ? { turn: inputs.turn } : {}),
    });
    return { ok: true, value: typeof out === 'string' ? out : String(out) };
  } catch (err) {
    return {
      ok: false,
      error: { code: 'template_render_error', message: (err as Error).message },
    };
  }
}

function issueAsTemplateInput(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branch_name,
    url: issue.url,
    labels: [...issue.labels],
    blocked_by: issue.blocked_by.map((b) => ({ ...b })),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}
