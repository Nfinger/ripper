import { describe, expect, it } from 'vitest';

import { dispatchSupervisedCommand } from '../src/supervised/command.js';
import { EXIT_CONFIG_OR_SCHEMA } from '../src/supervised/exit-codes.js';

describe('dispatchSupervisedCommand', () => {
  it('returns schema/config exit for unknown profiles subcommand', async () => {
    const result = await dispatchSupervisedCommand({
      command: 'profiles',
      argv: ['bogus'],
      noInteractive: true,
      stdout: () => undefined,
      stderr: () => undefined,
    });

    expect(result.exitCode).toBe(EXIT_CONFIG_OR_SCHEMA);
  });
});
