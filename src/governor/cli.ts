/**
 * Budget governor CLI.
 *
 *   npm run governor -- --config governor.config.json [--apply] [--once] [--duration 300] [--restore <endpointId>]
 *
 * --config <file>   required; JSON config (see governor.config.example.json)
 * --apply           allow the throttle PATCH (workers.max = 0). Default: dry-run (warn only)
 * --once            single poll then exit
 * --duration <sec>  run for at most <sec> seconds (for supervised smoke runs)
 * --restore <id>    PATCH back the workers.min/max saved before a throttle (requires --apply)
 *
 * API key: read from RUNPOD_API_KEY (never logged; see jsonl.ts).
 * Read-only by default: without --apply the only API calls are GETs.
 */

import { RunPodClient } from '../client.js';
import { loadConfig } from './config.js';
import { BudgetGovernor, type GovernorRunOptions } from './governor.js';
import { JsonlLogger } from './jsonl.js';
import { getState, loadState, saveState } from './state.js';
import { restoreEndpoint } from './throttle.js';

interface Args {
  config?: string;
  apply: boolean;
  once: boolean;
  durationSeconds?: number;
  restore?: string;
}

function next(argv: string[], i: number): string {
  const v = argv[i];
  if (v === undefined) {
    process.stderr.write('missing value for argument\n');
    process.exit(2);
  }
  return v;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, once: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--once') args.once = true;
    else if (a === '--config') args.config = next(argv, ++i);
    else if (a === '--duration') args.durationSeconds = Number(next(argv, ++i));
    else if (a === '--restore') args.restore = next(argv, ++i);
    else if (a === '--help' || a === '-h') {
      process.stdout.write('usage: governor --config <file> [--apply] [--once] [--duration <sec>] [--restore <endpointId>]\n');
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${a}\n`);
      process.stderr.write('usage: governor --config <file> [--apply] [--once] [--duration <sec>] [--restore <endpointId>]\n');
      process.exit(2);
    }
  }
  if (!args.config) {
    process.stderr.write('missing required argument: --config <file>\n');
    process.exit(2);
  }
  if (args.durationSeconds !== undefined && (!Number.isFinite(args.durationSeconds) || args.durationSeconds <= 0)) {
    process.stderr.write('--duration must be a positive number of seconds\n');
    process.exit(2);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) {
    process.stderr.write('missing required argument: --config <file>\n');
    process.exit(2);
  }
  const cfg = loadConfig(args.config);

  const logger = new JsonlLogger({ filePath: cfg.logFile });
  if (!args.apply) {
    logger.info('mode', { mode: 'dry-run', note: 'warn-only; throttle PATCH requires --apply' });
  } else {
    logger.warn('mode', { mode: 'apply', note: 'throttle PATCH enabled (workers.max=0 on limit breach)' });
  }

  const client = new RunPodClient();
  const opts: GovernorRunOptions = {
    apply: args.apply,
    once: args.once,
    restore: false,
  };
  if (args.durationSeconds !== undefined) opts.durationMs = args.durationSeconds * 1000;

  if (args.restore !== undefined) {
    if (!args.apply) {
      logger.error('restore_requires_apply', { endpoint: args.restore });
      process.exit(2);
    }
    const state = loadState(cfg.stateFile);
    await restoreEndpoint(client, args.restore, state, getState, logger);
    saveState(cfg.stateFile, state);
    return;
  }

  const governor = new BudgetGovernor(cfg, client, opts, logger);
  const onSignal = (): void => governor.stop();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  await governor.run();
}

main().catch((err) => {
  process.stderr.write(`governor: fatal: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}\n`);
  process.exit(1);
});
