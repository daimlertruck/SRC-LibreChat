import fs from 'fs';
import path from 'path';
import type { AgentStatisticsContext } from './statistics';

const CALLERS = [
  { caller: 'persisted AgentClient root chat', covered: true, interactiveUser: true },
  { caller: 'detached recorder from covered parent', covered: true, interactiveUser: false },
  { caller: 'Responses API store:true', covered: true, interactiveUser: true },
  { caller: 'scheduled or service persisted root flow', covered: true, interactiveUser: false },
  { caller: 'Responses API store:false', covered: false, interactiveUser: false },
  { caller: 'OpenAI-compatible stateless completion', covered: false, interactiveUser: false },
  { caller: 'subagent or handoff child dashboard subject', covered: false, interactiveUser: false },
] as const;

const CALLER_INVENTORY = {
  'api/server/controllers/agents/client.js': 6,
  'api/server/controllers/agents/openai.js': 1,
  'api/server/controllers/agents/responses.js': 2,
  'api/server/middleware/abortMiddleware.js': 1,
  'packages/api/src/agents/usage.ts': 2,
} as const;

function productionFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(file);
    if (!/\.[jt]s$/.test(entry.name) || /\.(spec|test)\.[jt]s$/.test(entry.name)) return [];
    return [file];
  });
}

function usageCallCount(file: string): number {
  const source = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  return source.match(/recordCollectedUsage\s*\(/g)?.length ?? 0;
}

describe('agent statistics Phase 0 contracts', () => {
  it.each(CALLERS)('$caller has an explicit coverage decision', (entry) => {
    expect(typeof entry.covered).toBe('boolean');
    expect(entry.interactiveUser && !entry.covered).toBe(false);
  });

  it('defines the server-authorized runtime context', () => {
    const context: AgentStatisticsContext = {
      agentId: 'agent-1',
      tenantId: 'tenant-1',
      bucket: '2026-09-01',
      occurredAt: Date.parse('2026-09-01T10:00:00.000Z'),
      interactiveUserId: 'user-1',
    };
    expect(context.agentId).toBe('agent-1');
  });

  it('inventories every production recordCollectedUsage occurrence', () => {
    const roots = ['api/server', 'packages/api/src'];
    const actual = Object.fromEntries(
      roots
        .flatMap(productionFiles)
        .map((file) => path.relative(process.cwd(), file).replaceAll('\\', '/'))
        .map((file) => [file, usageCallCount(file)] as const)
        .filter(([, count]) => count > 0),
    );
    expect(actual).toEqual(CALLER_INVENTORY);
  });
});
