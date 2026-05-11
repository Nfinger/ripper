export type SupervisedCommand = 'run' | 'profiles' | 'runs' | 'locks';

export type TopLevelArgs =
  | { mode: 'legacy'; argv: string[]; noInteractive: boolean }
  | { mode: 'supervised'; command: SupervisedCommand; argv: string[]; noInteractive: boolean };
