/**
 * `involute sync organization` — bring an outside organisation into Involute.
 *
 * The import is its own thing, independent of sign-in: it turns the groups an
 * organisation has into teams, and the people in them into members. The
 * source is a parameter, not a hardcoded command:
 *
 * ```bash
 * involute sync organization --provider dingtalk --mapping departments.json
 * ```
 *
 * The mapping file says which group becomes which team, and who joins it:
 *
 * ```json
 * {
 *   "departments": [
 *     {
 *       "deptId": 1,
 *       "teamKey": "CORE",
 *       "teamName": "核心研发",
 *       "role": "EDITOR",
 *       "includeSubDepartments": true
 *     }
 *   ]
 * }
 * ```
 *
 * The credentials come from the environment (`DINGTALK_APP_KEY`,
 * `DINGTALK_APP_SECRET`), and the database from `DATABASE_URL` — the same
 * environment the server reads, so the same Secret in the cluster serves
 * both.
 */

import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { OrganizationSyncInput } from '@turnkeyai/involute-server/org-sync/types';

import { ensureDatabaseUrl, loadEnv } from './shared.js';

export interface OrganizationSyncOptions {
  provider: string;
  mappingFile?: string;
  prune?: boolean;
  dryRun?: boolean;
}

export interface DingTalkSyncMapping {
  departments: Array<{
    deptId: number;
    teamKey: string;
    teamName?: string;
    role?: 'VIEWER' | 'EDITOR' | 'OWNER';
    includeSubDepartments?: boolean;
  }>;
}

export interface OrganizationSyncSummary {
  provider: string;
  groups: number;
  membersAdded: number;
  membersRemoved: number;
  membersUnchanged: number;
  peopleCreated: number;
  peopleLinked: number;
  peopleWithoutEmail: string[];
  peopleWithoutIdentity: string[];
  teamsCreated: number;
  teamsReused: number;
  warnings: string[];
}

/** The sources an import can read. Each one is an adapter over the same contract. */
export const ORGANIZATION_PROVIDERS = ['dingtalk'] as const;

export type OrganizationProviderId = (typeof ORGANIZATION_PROVIDERS)[number];

export function isOrganizationProviderId(value: string): value is OrganizationProviderId {
  return (ORGANIZATION_PROVIDERS as readonly string[]).includes(value);
}

export function parseDingTalkMapping(value: unknown, fileLabel: string): DingTalkSyncMapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fileLabel} must be a JSON object.`);
  }

  const departments = (value as { departments?: unknown }).departments;

  if (!Array.isArray(departments) || departments.length === 0) {
    throw new Error(`${fileLabel} must list at least one department.`);
  }

  return {
    departments: departments.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`${fileLabel}.departments[${index}] must be an object.`);
      }

      const department = entry as Record<string, unknown>;

      if (typeof department.deptId !== 'number' || !Number.isFinite(department.deptId)) {
        throw new Error(`${fileLabel}.departments[${index}].deptId must be a number.`);
      }

      if (typeof department.teamKey !== 'string' || !department.teamKey.trim()) {
        throw new Error(`${fileLabel}.departments[${index}].teamKey must be a string.`);
      }

      const role = department.role;

      if (role !== undefined && role !== 'VIEWER' && role !== 'EDITOR' && role !== 'OWNER') {
        throw new Error(
          `${fileLabel}.departments[${index}].role must be VIEWER, EDITOR or OWNER.`,
        );
      }

      const mapped: {
        deptId: number;
        includeSubDepartments: boolean;
        role?: 'VIEWER' | 'EDITOR' | 'OWNER';
        teamKey: string;
        teamName?: string;
      } = {
        deptId: department.deptId,
        includeSubDepartments: department.includeSubDepartments === true,
        teamKey: department.teamKey,
      };

      if (role !== undefined) {
        mapped.role = role;
      }

      if (typeof department.teamName === 'string') {
        mapped.teamName = department.teamName;
      }

      return mapped;
    }),
  };
}

export async function runOrganizationSync(
  options: OrganizationSyncOptions,
): Promise<OrganizationSyncSummary> {
  const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };

  if (!options.provider) {
    throw new Error('--provider is required: it says which organisation to read.');
  }

  if (!isOrganizationProviderId(options.provider)) {
    throw new Error(
      `Unknown organisation provider "${options.provider}". Supported: ${ORGANIZATION_PROVIDERS.join(', ')}.`,
    );
  }

  if (!options.mappingFile) {
    throw new Error('--mapping is required: the file says which group becomes which team.');
  }

  loadEnv();
  ensureDatabaseUrl();

  const mappingPath = resolve(options.mappingFile);

  const { PrismaClient } = await import('@prisma/client');
  const { syncOrganization } = await import('@turnkeyai/involute-server/org-sync/engine');

  const collected = await collect(options.provider, mappingPath);

  const prisma = new PrismaClient();

  try {
    await prisma.$connect();

    const summary = await syncOrganization({
      dryRun: options.dryRun ?? false,
      input: collected.input,
      onProgress: log,
      prune: options.prune ?? false,
      prisma,
    });

    summary.warnings.unshift(...collected.warnings);

    log('');
    log(
      `Organisation sync (${summary.provider})${options.dryRun ? ' — dry run, nothing was written' : ''}:`,
    );

    const rows: Array<[string, number | string]> = [
      ['Groups', summary.groups],
      ['Teams created', summary.teamsCreated],
      ['Teams reused', summary.teamsReused],
      ['People created', summary.peopleCreated],
      ['People linked', summary.peopleLinked],
      ['Members added', summary.membersAdded],
      ['Members removed', summary.membersRemoved],
      ['No email', summary.peopleWithoutEmail.length],
      ['No identity', summary.peopleWithoutIdentity.length],
    ];

    for (const [label, value] of rows) {
      log(`  ${label.padEnd(16)}${String(value).padStart(4)}`);
    }

    if (summary.warnings.length > 0) {
      log('');
      log('Warnings:');
      for (const warning of summary.warnings) {
        log(`  - ${warning}`);
      }
    }

    return summary;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Read one organisation into the contract the engine reads.
 *
 * Each source is an adapter over the same contract, so a new source adds a
 * case here and nothing else.
 */
async function collect(
  provider: OrganizationProviderId,
  mappingPath: string,
): Promise<{ input: OrganizationSyncInput; warnings: string[] }> {
  if (provider === 'dingtalk') {
    const appKey = process.env.DINGTALK_APP_KEY?.trim();
    const appSecret = process.env.DINGTALK_APP_SECRET?.trim();

    if (!appKey || !appSecret) {
      throw new Error(
        'DINGTALK_APP_KEY and DINGTALK_APP_SECRET must be set (the same Secret the server reads).',
      );
    }

    const { DingTalkClient } = await import(
      '@turnkeyai/involute-server/dingtalk/client'
    );
    const { collectDingTalkOrganization } = await import(
      '@turnkeyai/involute-server/dingtalk/adapter'
    );

    const mapping = parseDingTalkMapping(
      JSON.parse(await readFile(mappingPath, 'utf8')) as unknown,
      mappingPath,
    );

    return collectDingTalkOrganization(
      new DingTalkClient({ appKey, appSecret }),
      mapping.departments,
    );
  }

  throw new Error(`Unknown organisation provider "${provider}".`);
}

export function registerSyncCommand(program: Command): void {
  const syncCommand = program
    .command('sync')
    .description('Synchronise an outside organisation into Involute');

  syncCommand
    .command('organization')
    .description('Turn the groups of an outside organisation into teams and their people into members')
    .requiredOption('--provider <id>', `Which organisation to read (${ORGANIZATION_PROVIDERS.join(', ')})`)
    .requiredOption('--mapping <file>', 'JSON file mapping the organisation groups to Involute teams')
    .option('--prune', 'Also remove people who left the group (never removes accounts)', false)
    .option('--dry-run', 'Report what would change without writing anything', false)
    .action(async (opts: { mapping?: string | undefined; provider?: string | undefined; prune?: boolean | undefined; dryRun?: boolean | undefined }) => {
      try {
        const options: OrganizationSyncOptions = { provider: opts.provider ?? '' };

        if (opts.mapping !== undefined) {
          options.mappingFile = opts.mapping;
        }

        if (opts.prune !== undefined) {
          options.prune = opts.prune;
        }

        if (opts.dryRun !== undefined) {
          options.dryRun = opts.dryRun;
        }

        await runOrganizationSync(options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Error: ${message}\n`);
        process.exitCode = 1;
      }
    });
}
