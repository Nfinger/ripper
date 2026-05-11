import { describe, expect, it } from 'vitest';

import { parseTopLevelArgs } from '../src/cli/router.js';

describe('parseTopLevelArgs', () => {
  it('routes legacy args to daemon mode', () => {
    expect(parseTopLevelArgs(['clients/market-savvy.WORKFLOW.md'])).toEqual({
      mode: 'legacy',
      argv: ['clients/market-savvy.WORKFLOW.md'],
      noInteractive: false,
    });
  });

  it('routes supervised run command', () => {
    expect(parseTopLevelArgs(['run', 'marketsavvy-codex', '--dry-run'])).toEqual({
      mode: 'supervised',
      command: 'run',
      argv: ['marketsavvy-codex', '--dry-run'],
      noInteractive: false,
    });
  });

  it('supports global --no-interactive before command', () => {
    expect(parseTopLevelArgs(['--no-interactive', 'run', 'p'])).toEqual({
      mode: 'supervised',
      command: 'run',
      argv: ['p'],
      noInteractive: true,
    });
  });
});
