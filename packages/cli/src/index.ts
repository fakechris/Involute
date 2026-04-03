import { Command } from 'commander';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GraphQLClient } from 'graphql-request';
import { registerExportCommand } from './commands/export.js';
import { registerImportCommand } from './commands/import.js';

type ConfigKey = 'server-url' | 'token';

interface CliConfig {
  'server-url'?: string;
  token?: string;
}

interface JsonOption {
  json?: boolean;
}

interface CommandContext {
  json: boolean;
}

export class CliError extends Error {
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(message: string, exitCode = 1, details?: unknown) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.details = details;
  }
}

const CONFIG_PATH = join(homedir(), '.involute', 'config.json');
const CONFIG_KEYS: readonly ConfigKey[] = ['server-url', 'token'];

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export async function readConfig(configPath = CONFIG_PATH): Promise<CliConfig> {
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliError(`Invalid config file at ${configPath}. Expected a JSON object.`);
    }

    return parsed as CliConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }

    if (error instanceof SyntaxError) {
      throw new CliError(`Invalid config file at ${configPath}. Fix or remove it and try again.`);
    }

    throw error;
  }
}

export async function writeConfig(config: CliConfig, configPath = CONFIG_PATH): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export async function setConfigValue(key: ConfigKey, value: string, configPath = CONFIG_PATH): Promise<CliConfig> {
  const current = await readConfig(configPath);
  const next = { ...current, [key]: value };
  await writeConfig(next, configPath);
  return next;
}

export async function getConfigValue(key: ConfigKey, configPath = CONFIG_PATH): Promise<string | undefined> {
  const config = await readConfig(configPath);
  return config[key];
}

export function createCommandContext(options: JsonOption | undefined): CommandContext {
  return { json: Boolean(options?.json) };
}

export function formatOutput(payload: unknown, context: CommandContext): string {
  if (context.json) {
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  if (typeof payload === 'string') {
    return `${payload}\n`;
  }

  if (Array.isArray(payload) && payload.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
    return `${formatTable(payload as Array<Record<string, unknown>>)}\n`;
  }

  if (payload && typeof payload === 'object') {
    return `${formatKeyValues(payload as Record<string, unknown>)}\n`;
  }

  return `${String(payload)}\n`;
}

function formatKeyValues(record: Record<string, unknown>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}: ${stringifyValue(value)}`)
    .join('\n');
}

function formatTable(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) {
    return '(no results)';
  }

  const headers = Array.from(
    rows.reduce((keys, row) => {
      Object.keys(row).forEach((key) => keys.add(key));
      return keys;
    }, new Set<string>()),
  );

  const widths = headers.map((header) =>
    Math.max(
      header.length,
      ...rows.map((row) => stringifyValue(row[header]).length),
    ),
  );

  const renderRow = (values: string[]) =>
    values.map((value, index) => value.padEnd(widths[index] ?? value.length)).join('  ');

  return [
    renderRow(headers),
    renderRow(widths.map((width) => '-'.repeat(width))),
    ...rows.map((row) => renderRow(headers.map((header) => stringifyValue(row[header])))),
  ].join('\n');
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map((entry) => stringifyValue(entry)).join(', ');
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

export async function createConfiguredGraphQLClient(configPath = CONFIG_PATH): Promise<GraphQLClient> {
  const config = await readConfig(configPath);
  const serverUrl = config['server-url'];

  if (!serverUrl) {
    throw new CliError(
      'Missing required config "server-url". Run `involute config set server-url <url>` first.',
    );
  }

  const token = config.token;

  return new GraphQLClient(joinGraphqlEndpoint(serverUrl), {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

function joinGraphqlEndpoint(serverUrl: string): string {
  const trimmed = serverUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/graphql') ? trimmed : `${trimmed}/graphql`;
}

export function normalizeGraphQLErrorMessage(error: unknown): string {
  if (error instanceof CliError) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null) {
    const responseErrors = (error as { response?: { errors?: Array<{ message?: string }> } }).response?.errors;
    const requestErrorMessage = (error as { message?: string }).message;
    const graphQlMessage = responseErrors?.map((entry) => entry.message).filter(Boolean).join('; ');
    const message = graphQlMessage || requestErrorMessage;

    if (message?.includes('Not authenticated')) {
      return 'Not authenticated. Run `involute config set token <token>` and try again.';
    }

    if (message) {
      return message;
    }
  }

  return String(error);
}

export async function runWithCliErrorHandling(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = normalizeGraphQLErrorMessage(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
}

function registerGlobalOptions(program: Command): void {
  program.option('--json', 'Output machine-readable JSON');
}

function registerConfigCommands(program: Command): void {
  const configCommand = program.command('config').description('Manage CLI configuration');

  configCommand
    .command('set')
    .description('Persist a configuration value')
    .argument('<key>', 'Configuration key (server-url or token)')
    .argument('<value>', 'Configuration value')
    .action(async (key: string, value: string) => {
      await runWithCliErrorHandling(async () => {
        if (!CONFIG_KEYS.includes(key as ConfigKey)) {
          throw new CliError(`Unknown config key "${key}". Expected one of: ${CONFIG_KEYS.join(', ')}`);
        }

        await setConfigValue(key as ConfigKey, value);
        process.stdout.write(`Saved ${key} to ${CONFIG_PATH}\n`);
      });
    });

  configCommand
    .command('get')
    .description('Read a configuration value')
    .argument('<key>', 'Configuration key (server-url or token)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (key: string, options: JsonOption) => {
      await runWithCliErrorHandling(async () => {
        if (!CONFIG_KEYS.includes(key as ConfigKey)) {
          throw new CliError(`Unknown config key "${key}". Expected one of: ${CONFIG_KEYS.join(', ')}`);
        }

        const value = await getConfigValue(key as ConfigKey);
        const context = createCommandContext(options);
        const payload = context.json ? { key, value: value ?? null } : value ?? '';
        process.stdout.write(formatOutput(payload, context));
      });
    });
}

async function probeConnection(context: CommandContext): Promise<void> {
  const client = await createConfiguredGraphQLClient();
  const result = await client.request<{ teams: { nodes: Array<{ id: string; key: string; name: string }> } }>(
    /* GraphQL */ `
      query CliBootstrapTeams {
        teams {
          nodes {
            id
            key
            name
          }
        }
      }
    `,
  );

  process.stdout.write(formatOutput(result.teams.nodes, context));
}

export function createProgram(): Command {
  const program = new Command()
    .name('involute')
    .description('Involute CLI — manage your Linear-compatible project management service')
    .version('0.0.0')
    .enablePositionalOptions();

  registerGlobalOptions(program);
  registerConfigCommands(program);

  registerExportCommand(program);
  registerImportCommand(program);

  program
    .command('teams')
    .description('Query configured server connectivity')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options: JsonOption) => {
      await runWithCliErrorHandling(async () => {
        await probeConnection(createCommandContext(options));
      });
    });

  return program;
}

const currentEntryPoint = process.argv[1];

if (currentEntryPoint && import.meta.url === pathToFileURL(currentEntryPoint).href) {
  createProgram().parse(process.argv);
}
