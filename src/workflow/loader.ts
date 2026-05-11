import fs from 'node:fs';
import yaml from 'js-yaml';

import type { WorkflowDefinition, ValidationError } from './types.js';

/**
 * Parse a WORKFLOW.md file into { config, prompt_template }.
 *
 * Spec §5.2:
 *   - File starts with `---` → parse YAML front matter until next `---`
 *   - Remaining lines = prompt body (trimmed)
 *   - No front matter → entire file is prompt body, config = {}
 *   - Front matter MUST decode to a map; non-map is an error
 */
export function loadWorkflowFile(path: string): WorkflowDefinition | ValidationError {
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    return {
      code: 'missing_workflow_file',
      path,
      message: `Cannot read WORKFLOW.md at ${path}: ${(err as Error).message}`,
    };
  }
  return parseWorkflowSource(raw);
}

export function parseWorkflowSource(raw: string): WorkflowDefinition | ValidationError {
  const text = raw.replace(/^﻿/, '');
  if (!text.startsWith('---')) {
    return { config: {}, prompt_template: text.trim() };
  }
  const rest = text.slice(3);
  const startIdx = rest.indexOf('\n');
  if (startIdx < 0) {
    return {
      code: 'workflow_parse_error',
      message: 'Workflow front matter opened with `---` but contained no newline',
    };
  }
  const afterOpen = rest.slice(startIdx + 1);
  const closeMatch = afterOpen.match(/(^|\n)---[ \t]*(\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    return {
      code: 'workflow_parse_error',
      message: 'Workflow front matter opened with `---` but never closed',
    };
  }
  const closeStart = closeMatch.index + (closeMatch[1] === '\n' ? 1 : 0);
  const yamlBody = afterOpen.slice(0, closeStart);
  const closeLineEnd = closeMatch.index + closeMatch[0].length;
  const promptBody = afterOpen.slice(closeLineEnd);

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlBody);
  } catch (err) {
    return {
      code: 'workflow_parse_error',
      message: `YAML front matter parse error: ${(err as Error).message}`,
    };
  }
  if (parsed === null || parsed === undefined) {
    return { config: {}, prompt_template: promptBody.trim() };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      code: 'workflow_front_matter_not_a_map',
      message: 'Workflow front matter must decode to a YAML mapping (object)',
    };
  }
  return {
    config: parsed as Record<string, unknown>,
    prompt_template: promptBody.trim(),
  };
}

export function isValidationError(
  result: WorkflowDefinition | ValidationError,
): result is ValidationError {
  return (result as ValidationError).code !== undefined;
}
