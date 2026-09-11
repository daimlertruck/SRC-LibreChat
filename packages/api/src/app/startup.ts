import { isEnabled } from '~/utils';

/**
 * Whether this container skips the startup work that initializes shared deployment state —
 * seeding, interface-permission derivation, migration checks, file sweeps, skill sync, MCP
 * initialization — plus the boot-time RAG health probe.
 *
 * `process.env` is read on every call rather than captured at module load, so a caller always
 * observes the current value of `DISABLE_STARTUP_TASKS`.
 */
export function areStartupTasksDisabled(): boolean {
  return isEnabled(process.env.DISABLE_STARTUP_TASKS);
}

/**
 * The single `warn`-level line a gated container emits per boot, shared by both entrypoints so
 * neither holds its own copy.
 */
export const startupTasksDisabledWarning: string =
  '[Deployment] DISABLE_STARTUP_TASKS is set: this container performs no database seeding, ' +
  'no interface permission derivation from librechat.yaml, no migration checks, no file sweeps, ' +
  'no skill sync, and no MCP initialization. Another container must perform that work — do not ' +
  'run this container as a single-container deployment.';
