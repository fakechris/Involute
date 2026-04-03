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

interface TeamSummary {
  id: string;
  key: string;
  name: string;
}

interface StateSummary {
  id: string;
  name: string;
}

interface LabelSummary {
  id: string;
  name: string;
}

interface IssueListItem {
  assignee: { id: string; name: string | null } | null;
  id: string;
  identifier: string;
  state: { id: string; name: string };
  title: string;
}

interface IssueCommentItem {
  body: string;
  createdAt: string;
  id: string;
  user: { email: string | null; id: string; name: string | null } | null;
}

interface IssueCommentsResult {
  comments: { nodes: IssueCommentItem[] };
  id: string;
  identifier: string;
}

interface IssueDetail {
  assignee: { email: string | null; id: string; name: string | null } | null;
  description: string | null;
  id: string;
  identifier: string;
  labels: { nodes: LabelSummary[] };
  state: { id: string; name: string };
  title: string;
  comments: { nodes: IssueCommentItem[] };
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

const CONFIG_PATH = process.env.INVOLUTE_CONFIG_PATH ?? join(homedir(), '.involute', 'config.json');
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

function getGlobalJsonOption(command: Command): boolean {
  for (let current: Command | null = command; current; current = current.parent ?? null) {
    const options = current.opts<{ json?: boolean }>();
    if (options.json !== undefined) {
      return Boolean(options.json);
    }
  }

  return false;
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

function formatIssueDetail(detail: IssueDetail): string {
  return formatKeyValues({
    identifier: detail.identifier,
    title: detail.title,
    description: detail.description ?? '',
    state: detail.state.name,
    assignee: detail.assignee?.name ?? '',
    labels: detail.labels.nodes.map((label) => label.name),
    comments: detail.comments.nodes.map(formatCommentSummary),
  });
}

function formatCommentSummary(comment: IssueCommentItem): string {
  const author = comment.user?.name ?? comment.user?.email ?? 'Unknown';
  return `${comment.createdAt} — ${author}: ${comment.body}`;
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
  const teams = await fetchTeams();
  process.stdout.write(formatOutput(teams, context));
}

async function fetchTeams(): Promise<TeamSummary[]> {
  const client = await createConfiguredGraphQLClient();
  const result = await client.request<{ teams: { nodes: TeamSummary[] } }>(
    /* GraphQL */ `
      query CliTeamsList {
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

  return result.teams.nodes;
}

async function fetchStates(): Promise<StateSummary[]> {
  const client = await createConfiguredGraphQLClient();
  const result = await client.request<{ teams: { nodes: Array<{ states: { nodes: StateSummary[] } }> } }>(
    /* GraphQL */ `
      query CliStatesList {
        teams {
          nodes {
            states {
              nodes {
                id
                name
              }
            }
          }
        }
      }
    `,
  );

  return result.teams.nodes.flatMap((team) => team.states.nodes);
}

async function fetchLabels(): Promise<LabelSummary[]> {
  const client = await createConfiguredGraphQLClient();
  const result = await client.request<{ issueLabels: { nodes: LabelSummary[] } }>(
    /* GraphQL */ `
      query CliLabelsList {
        issueLabels {
          nodes {
            id
            name
          }
        }
      }
    `,
  );

  return result.issueLabels.nodes;
}

async function fetchIssues(teamKey?: string): Promise<IssueListItem[]> {
  const client = await createConfiguredGraphQLClient();
  const result = await client.request<{ issues: { nodes: IssueListItem[] } }>(
    /* GraphQL */ `
      query CliIssuesList($filter: IssueFilter, $first: Int!) {
        issues(first: $first, filter: $filter) {
          nodes {
            id
            identifier
            title
            state {
              id
              name
            }
            assignee {
              id
              name
            }
          }
        }
      }
    `,
    {
      filter: teamKey
        ? {
            team: {
              key: {
                eq: teamKey,
              },
            },
          }
        : undefined,
      first: 100,
    },
  );

  return result.issues.nodes;
}

async function fetchIssueByIdentifier(identifier: string): Promise<IssueDetail | null> {
  const teamKey = identifier.includes('-') ? identifier.split('-')[0] ?? undefined : undefined;
  const client = await createConfiguredGraphQLClient();
  const filter = teamKey
    ? {
        team: {
          key: {
            eq: teamKey,
          },
        },
      }
    : undefined;

  let first = 100;
  const maxFirst = 5_000;

  while (true) {
    const result = await client.request<{ issues: { nodes: IssueDetail[] } }>(
      /* GraphQL */ `
        query CliIssueByIdentifier($filter: IssueFilter, $first: Int!) {
          issues(first: $first, filter: $filter) {
            nodes {
              id
              identifier
              title
              description
              state {
                id
                name
              }
              labels {
                nodes {
                  id
                  name
                }
              }
              assignee {
                id
                name
                email
              }
              comments(first: 100, orderBy: createdAt) {
                nodes {
                  id
                  body
                  createdAt
                  user {
                    id
                    name
                    email
                  }
                }
              }
            }
          }
        }
      `,
      {
        filter,
        first,
      },
    );

    const matchedIssue = result.issues.nodes.find((issue) => issue.identifier === identifier);
    if (matchedIssue) {
      return matchedIssue;
    }

    if (result.issues.nodes.length < first) {
      return null;
    }

    if (first >= maxFirst) {
      return null;
    }

    first = Math.min(first * 2, maxFirst);
  }
}

async function fetchTeamByKey(teamKey: string): Promise<TeamSummary | null> {
  const client = await createConfiguredGraphQLClient();
  const result = await client.request<{ teams: { nodes: TeamSummary[] } }>(
    /* GraphQL */ `
      query CliTeamByKey($key: String!) {
        teams(filter: { key: { eq: $key } }) {
          nodes {
            id
            key
            name
          }
        }
      }
    `,
    { key: teamKey },
  );

  return result.teams.nodes[0] ?? null;
}

async function fetchTeamStates(teamKey: string): Promise<StateSummary[]> {
  const client = await createConfiguredGraphQLClient();
  const result = await client.request<{
    teams: { nodes: Array<{ states: { nodes: StateSummary[] } }> };
  }>(
    /* GraphQL */ `
      query CliTeamStates($key: String!) {
        teams(filter: { key: { eq: $key } }) {
          nodes {
            states {
              nodes {
                id
                name
              }
            }
          }
        }
      }
    `,
    { key: teamKey },
  );

  return result.teams.nodes[0]?.states.nodes ?? [];
}

async function createIssueViaCli(options: {
  description?: string;
  team: string;
  title: string;
}): Promise<{ id: string; identifier: string; title: string }> {
  const client = await createConfiguredGraphQLClient();
  const team = await fetchTeamByKey(options.team);

  if (!team) {
    throw new CliError(`Team not found: ${options.team}`);
  }

  const result = await client.request<{
    issueCreate: {
      success: boolean;
      issue: { id: string; identifier: string; title: string } | null;
    };
  }>(
    /* GraphQL */ `
      mutation CliIssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            title
          }
        }
      }
    `,
    {
      input: {
        teamId: team.id,
        title: options.title,
        description: options.description ?? null,
      },
    },
  );

  if (!result.issueCreate.success || !result.issueCreate.issue) {
    throw new CliError('Issue creation failed.');
  }

  return result.issueCreate.issue;
}

async function updateIssueViaCli(
  identifier: string,
  input: { assignee?: string; labels?: string; state?: string; title?: string },
): Promise<IssueDetail> {
  const client = await createConfiguredGraphQLClient();
  const issue = await fetchIssueByIdentifier(identifier);

  if (!issue) {
    throw new CliError('Issue not found');
  }

  const updateInput: Record<string, unknown> = {};

  if (input.state) {
    const state = (await fetchTeamStates(identifier.split('-')[0] ?? 'INV')).find(
      (candidate) => candidate.name === input.state,
    );

    if (!state) {
      throw new CliError(`State not found: ${input.state}`);
    }

    updateInput.stateId = state.id;
  }

  if (input.title) {
    updateInput.title = input.title;
  }

  if (input.assignee !== undefined) {
    updateInput.assigneeId = input.assignee;
  }

  if (input.labels !== undefined) {
    const requestedNames = input.labels
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean);
    const labels = await fetchLabels();
    const labelIds = requestedNames.map((name) => {
      const label = labels.find((candidate) => candidate.name === name);
      if (!label) {
        throw new CliError(`Label not found: ${name}`);
      }

      return label.id;
    });
    updateInput.labelIds = labelIds;
  }

  const result = await client.request<{
    issueUpdate: {
      success: boolean;
      issue: { id: string } | null;
    };
  }>(
    /* GraphQL */ `
      mutation CliIssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue {
            id
          }
        }
      }
    `,
    {
      id: issue.id,
      input: updateInput,
    },
  );

  if (!result.issueUpdate.success) {
    throw new CliError('Issue update failed.');
  }

  const updatedIssue = await fetchIssueByIdentifier(identifier);

  if (!updatedIssue) {
    throw new CliError('Issue not found');
  }

  return updatedIssue;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fetchIssueComments(issueIdOrIdentifier: string): Promise<IssueCommentsResult> {
  if (UUID_PATTERN.test(issueIdOrIdentifier)) {
    const client = await createConfiguredGraphQLClient();
    const result = await client.request<{ issue: IssueCommentsResult | null }>(
      /* GraphQL */ `
        query CliCommentsList($id: String!) {
          issue(id: $id) {
            id
            identifier
            comments(first: 100, orderBy: createdAt) {
              nodes {
                id
                body
                createdAt
                user {
                  id
                  name
                  email
                }
              }
            }
          }
        }
      `,
      { id: issueIdOrIdentifier },
    );

    if (!result.issue) {
      throw new CliError(`Issue not found: ${issueIdOrIdentifier}`);
    }

    return result.issue;
  }

  const issue = await fetchIssueByIdentifier(issueIdOrIdentifier);

  if (!issue) {
    throw new CliError(`Issue not found: ${issueIdOrIdentifier}`);
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    comments: issue.comments,
  };
}

async function resolveIssueId(issueIdOrIdentifier: string): Promise<string> {
  return (await fetchIssueComments(issueIdOrIdentifier)).id;
}

async function fetchComments(issueIdOrIdentifier: string): Promise<IssueCommentItem[]> {
  return (await fetchIssueComments(issueIdOrIdentifier)).comments.nodes;
}

async function createCommentViaCli(
  issueIdOrIdentifier: string,
  body: string,
): Promise<{ body: string; id: string }> {
  const issueId = await resolveIssueId(issueIdOrIdentifier);
  const client = await createConfiguredGraphQLClient();

  const result = await client.request<{
    commentCreate: {
      success: boolean;
      comment: { body: string; id: string } | null;
    };
  }>(
    /* GraphQL */ `
      mutation CliCommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment {
            id
            body
          }
        }
      }
    `,
    {
      input: {
        issueId,
        body,
      },
    },
  );

  if (!result.commentCreate.success || !result.commentCreate.comment) {
    throw new CliError('Comment creation failed.');
  }

  return result.commentCreate.comment;
}

const COMMENT_BODY_TRUNCATE_LENGTH = 80;

function truncateBody(body: string): string {
  if (body.length <= COMMENT_BODY_TRUNCATE_LENGTH) {
    return body;
  }

  return `${body.slice(0, COMMENT_BODY_TRUNCATE_LENGTH)}…`;
}

function toCommentListRows(comments: IssueCommentItem[]): Array<Record<string, unknown>> {
  return comments.map((comment) => ({
    body: truncateBody(comment.body),
    author: comment.user?.name ?? comment.user?.email ?? 'Unknown',
    timestamp: comment.createdAt,
  }));
}

function toIssueListRows(issues: IssueListItem[]): Array<Record<string, unknown>> {
  return issues.map((issue) => ({
    identifier: issue.identifier,
    title: issue.title,
    state: issue.state.name,
    assignee: issue.assignee?.name ?? '',
  }));
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

  const runTeamsCommand = async function (this: Command, options: JsonOption = {}) {
    await runWithCliErrorHandling(async () => {
      await probeConnection(createCommandContext({ json: options.json ?? getGlobalJsonOption(this) }));
    });
  };

  const teamsCommand = program.command('teams').description('List teams').option('--json', 'Output machine-readable JSON');
  teamsCommand.action(runTeamsCommand);
  teamsCommand.command('list').description('List teams').option('--json', 'Output machine-readable JSON').action(runTeamsCommand);

  const runStatesCommand = async function (this: Command, options: JsonOption = {}) {
    await runWithCliErrorHandling(async () => {
      const context = createCommandContext({ json: options.json ?? getGlobalJsonOption(this) });
      process.stdout.write(formatOutput(await fetchStates(), context));
    });
  };

  const statesCommand = program
    .command('states')
    .description('List workflow states')
    .option('--json', 'Output machine-readable JSON');
  statesCommand.action(runStatesCommand);
  statesCommand.command('list').description('List workflow states').option('--json', 'Output machine-readable JSON').action(runStatesCommand);

  const runLabelsCommand = async function (this: Command, options: JsonOption = {}) {
    await runWithCliErrorHandling(async () => {
      const context = createCommandContext({ json: options.json ?? getGlobalJsonOption(this) });
      process.stdout.write(formatOutput(await fetchLabels(), context));
    });
  };

  const labelsCommand = program.command('labels').description('List issue labels').option('--json', 'Output machine-readable JSON');
  labelsCommand.action(runLabelsCommand);
  labelsCommand.command('list').description('List issue labels').option('--json', 'Output machine-readable JSON').action(runLabelsCommand);

  const commentsCommand = program.command('comments').description('Manage issue comments');

  commentsCommand
    .command('list')
    .description('List comments for an issue')
    .argument('<issueId>', 'Issue identifier (e.g., INV-1) or UUID')
    .option('--json', 'Output machine-readable JSON')
    .action(async function (this: Command, issueId: string, options: JsonOption) {
      await runWithCliErrorHandling(async () => {
        const context = createCommandContext({ json: options.json ?? getGlobalJsonOption(this) });
        const issue = await fetchIssueComments(issueId);
        process.stdout.write(
          formatOutput(context.json ? issue.comments.nodes : toCommentListRows(issue.comments.nodes), context),
        );
      });
    });

  commentsCommand
    .command('add')
    .description('Add a comment to an issue')
    .argument('<issueId>', 'Issue identifier (e.g., INV-1) or UUID')
    .requiredOption('--body <text>', 'Comment body text')
    .option('--json', 'Output machine-readable JSON')
    .action(async function (this: Command, issueId: string, options: JsonOption & { body: string }) {
      await runWithCliErrorHandling(async () => {
        const context = createCommandContext({ json: options.json ?? getGlobalJsonOption(this) });
        const comment = await createCommentViaCli(issueId, options.body);
        process.stdout.write(formatOutput(context.json ? comment : { id: comment.id }, context));
      });
    });

  const issuesCommand = program.command('issues').description('Manage issues');

  issuesCommand
    .command('list')
    .description('List issues')
    .option('--team <key>', 'Filter issues by team key')
    .option('--json', 'Output machine-readable JSON')
    .action(async function (
      this: Command,
      options: JsonOption & {
        team?: string;
      },
    ) {
      await runWithCliErrorHandling(async () => {
        const context = createCommandContext({ json: options.json ?? getGlobalJsonOption(this) });
        const issues = await fetchIssues(options.team);
        process.stdout.write(formatOutput(context.json ? issues : toIssueListRows(issues), context));
      });
    });

  issuesCommand
    .command('show')
    .description('Show issue details')
    .argument('<identifier>', 'Issue identifier')
    .option('--json', 'Output machine-readable JSON')
    .action(async function (this: Command, identifier: string, options: JsonOption) {
      await runWithCliErrorHandling(async () => {
        const context = createCommandContext({ json: options.json ?? getGlobalJsonOption(this) });
        const issue = await fetchIssueByIdentifier(identifier);

        if (!issue) {
          throw new CliError('Issue not found');
        }

        process.stdout.write(formatOutput(context.json ? issue : formatIssueDetail(issue), context));
      });
    });

  issuesCommand
    .command('create')
    .description('Create an issue')
    .requiredOption('--title <title>', 'Issue title')
    .requiredOption('--team <key>', 'Team key')
    .option('--description <description>', 'Issue description')
    .option('--json', 'Output machine-readable JSON')
    .action(async function (
      this: Command,
      options: JsonOption & { description?: string; team: string; title: string },
    ) {
      await runWithCliErrorHandling(async () => {
        const context = createCommandContext({ json: options.json ?? getGlobalJsonOption(this) });
        const createdIssue = await createIssueViaCli(options);
        process.stdout.write(
          formatOutput(
            context.json ? createdIssue : { identifier: createdIssue.identifier },
            context,
          ),
        );
      });
    });

  issuesCommand
    .command('update')
    .description('Update an issue')
    .argument('<identifier>', 'Issue identifier')
    .option('--state <state>', 'New workflow state name')
    .option('--title <title>', 'New issue title')
    .option('--assignee <userId>', 'New assignee user ID')
    .option('--labels <labels>', 'Comma-separated label names')
    .option('--json', 'Output machine-readable JSON')
    .action(
      async function (
        this: Command,
        identifier: string,
        options: JsonOption & {
          assignee?: string;
          labels?: string;
          state?: string;
          title?: string;
        },
      ) {
        await runWithCliErrorHandling(async () => {
          const context = createCommandContext({ json: options.json ?? getGlobalJsonOption(this) });
          const updatedIssue = await updateIssueViaCli(identifier, options);
          process.stdout.write(
            formatOutput(
              context.json
                ? updatedIssue
                : {
                    identifier: updatedIssue.identifier,
                    title: updatedIssue.title,
                    state: updatedIssue.state.name,
                    assignee: updatedIssue.assignee?.name ?? '',
                    labels: updatedIssue.labels.nodes.map((label) => label.name),
                  },
              context,
            ),
          );
        });
      },
    );

  return program;
}

const currentEntryPoint = process.argv[1];

if (currentEntryPoint && import.meta.url === pathToFileURL(currentEntryPoint).href) {
  createProgram().parse(process.argv);
}
