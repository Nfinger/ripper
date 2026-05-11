#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';

import { parseTopLevelArgs } from './cli/router.js';
import { Daemon } from './daemon.js';
import { dispatchSupervisedCommand } from './supervised/command.js';
import { log } from './log.js';
import { createHttpServer, type HttpServer } from './server/http.js';
import { createTrackerClient } from './tracker/factory.js';
import {
  loadProfileFromFile,
  loadProfilesFromDir,
  type Profile,
  type ProfileResult,
} from './workflow/profile.js';

interface CliArgs {
  workflowPath: string | null;
  configDir: string | null;
  port: number | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let workflowPath: string | null = null;
  let configDir: string | null = null;
  let port: number | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port') {
      const next = argv[++i];
      if (next === undefined) throw new Error('--port requires a value');
      const n = Number.parseInt(next, 10);
      if (Number.isNaN(n)) throw new Error(`--port: not an integer: ${next}`);
      port = n;
    } else if (a === '--config-dir') {
      const next = argv[++i];
      if (next === undefined) throw new Error('--config-dir requires a value');
      configDir = path.resolve(next);
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--help' || a === '-h') {
      printUsageAndExit(0);
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      workflowPath = path.resolve(a);
    }
  }
  if (workflowPath === null && configDir === null) {
    workflowPath = path.resolve('WORKFLOW.md');
  }
  if (workflowPath !== null && configDir !== null) {
    throw new Error('Pass either a single WORKFLOW.md path or --config-dir, not both');
  }
  return { workflowPath, configDir, port, dryRun };
}

function printUsageAndExit(code: number): never {
  process.stderr.write(
    `usage: symphony [path-to-WORKFLOW.md] [--config-dir <dir>] [--port <n>] [--dry-run]\n` +
      `Defaults to ./WORKFLOW.md if neither path nor --config-dir is provided.\n` +
      `--config-dir: load every *.WORKFLOW.md in <dir> as a separate client profile.\n` +
      `--dry-run:    load + validate + fetch one batch of candidates per profile, then exit.\n`,
  );
  process.exit(code);
}

function loadProfiles(args: CliArgs): ProfileResult {
  if (args.configDir) return loadProfilesFromDir(args.configDir);
  if (args.workflowPath) return loadProfileFromFile(args.workflowPath);
  return {
    ok: false,
    error: { code: 'config_dir_not_found', path: '', message: 'no config source given' },
  };
}

async function dryRun(profiles: Profile[]): Promise<number> {
  let anyFailed = false;
  for (const profile of profiles) {
    log.info(
      {
        client: profile.name,
        tracker_kind: profile.config.tracker.kind,
        team_key: profile.config.tracker.team_key,
        project_slug: profile.config.tracker.project_slug,
        active_states: profile.config.tracker.active_states,
      },
      'dry-run: fetching candidate issues',
    );
    const trackerRes = createTrackerClient(profile.config.tracker);
    if (!trackerRes.ok) {
      log.error({ client: profile.name, err: trackerRes.error }, 'dry-run: tracker init failed');
      anyFailed = true;
      continue;
    }
    const res = await trackerRes.value.fetch_candidate_issues();
    if (!res.ok) {
      log.error({ client: profile.name, err: res.error }, 'dry-run: candidate fetch failed');
      anyFailed = true;
      continue;
    }
    log.info({ client: profile.name, count: res.value.length }, 'dry-run: candidate count');
    for (const issue of res.value.slice(0, 20)) {
      log.info(
        {
          client: profile.name,
          identifier: issue.identifier,
          state: issue.state,
          priority: issue.priority,
          labels: issue.labels,
          blocked_by: issue.blocked_by.map((b) => `${b.identifier}(${b.state})`),
        },
        'candidate',
      );
    }
  }
  return anyFailed ? 2 : 0;
}

async function runLegacyDaemon(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const profilesRes = loadProfiles(args);
  if (!profilesRes.ok) {
    log.error({ err: profilesRes.error }, 'profile load failed');
    process.exit(1);
  }
  const profiles = profilesRes.profiles;
  if (args.port !== null) {
    for (const p of profiles) p.config.server.port = args.port;
  }

  if (args.dryRun) {
    const code = await dryRun(profiles);
    process.exit(code);
  }

  let daemon: Daemon;
  try {
    daemon = new Daemon(profiles);
  } catch (err) {
    log.error({ err: (err as Error).message }, 'daemon init failed');
    process.exit(1);
  }

  await daemon.start();

  // HTTP: pick the first profile's server config as authoritative. If the user
  // wants the API on, set server.port in any profile; the daemon binds once.
  const httpProfile = profiles.find((p) => p.config.server.port !== null);
  let httpServer: HttpServer | null = null;
  if (httpProfile) {
    httpServer = createHttpServer({
      port: httpProfile.config.server.port!,
      bindHost: httpProfile.config.server.bind_host,
      daemon,
    });
    await httpServer.listen();
  }

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    log.info({ signal }, 'shutdown initiated');
    if (httpServer) await httpServer.close();
    await daemon.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  log.info({ profiles: profiles.map((p) => p.name) }, 'symphony running');
}

async function main(): Promise<void> {
  const top = parseTopLevelArgs(process.argv.slice(2));
  if (top.mode === 'supervised') {
    const result = await dispatchSupervisedCommand({
      command: top.command,
      argv: top.argv,
      noInteractive: top.noInteractive,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
    process.exit(result.exitCode);
  }
  await runLegacyDaemon(top.argv);
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : err }, 'fatal');
  process.exit(1);
});
