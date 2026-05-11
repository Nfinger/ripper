import type { SupervisedCommand, TopLevelArgs } from './types.js';

const SUPERVISED_COMMANDS = new Set<SupervisedCommand>(['run', 'profiles', 'runs', 'locks']);

export function parseTopLevelArgs(argv: string[]): TopLevelArgs {
  const args = [...argv];
  let noInteractive = false;

  if (args[0] === '--no-interactive') {
    noInteractive = true;
    args.shift();
  }

  const first = args[0];
  if (first !== undefined && SUPERVISED_COMMANDS.has(first as SupervisedCommand)) {
    args.shift();
    return { mode: 'supervised', command: first as SupervisedCommand, argv: args, noInteractive };
  }

  return { mode: 'legacy', argv: args, noInteractive };
}
