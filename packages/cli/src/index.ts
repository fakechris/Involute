#!/usr/bin/env node

import { Command } from 'commander';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GraphQLClient } from 'graphql-request';
import {
  type ViewerAssertionSubjectType,
  VIEWER_ASSERTION_HEADER,
} from '@turnkeyai/involute-shared';
import { createViewerAssertion } from '@turnkeyai/involute-shared/viewer-assertion';
import { registerExportCommand } from './commands/export.js';
import { registerImportCommand } from './commands/import.js';

type ConfigKey = 'server-url' | 'token' | 'viewer-assertion';

interface CliConfig {
  'server-url'?: string;
  token?: string;
  'viewer-assertion'?: string;
}

interface JsonOption {
  json?: boolean;
}

interface CommandContext {
  json: boolean;
}

interface PageInfo {
  endCursor: string | null;
  hasNextPage: boolean;
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
  team: { key: string };
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

const CONFIG_KEYS: readonly ConfigKey[] = ['server-url', 'token', 'viewer-assertion'];
const CLI_PAGE_SIZE = 100;

function resolveConfigPath(): string {
  return process.env.INVOLUTE_CONFIG_PATH ?? join(homedir(), '.involute', 'config.json');
}

export function getConfigPath(): string {
  return resolveConfigPath();
}

export async function readConfig(configPath = getConfigPath()): Promise<CliConfig> {
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

export async function writeConfig(config: CliConfig, configPath = getConfigPath()): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(tempPath, configPath);
  await chmod(configPath, 0o600);
}

export async function setConfigValue(key: ConfigKey, value: string, configPath = getConfigPath()): Promise<CliConfig> {
  const current = await readConfig(configPath);
  const next = { ...current, [key]: value };
  await writeConfig(next, configPath);
  return next;
}

export async function getConfigValue(key: ConfigKey, configPath = getConfigPath()): Promise<string | undefined> {
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

export async function createConfiguredGraphQLClient(configPath = getConfigPath()): Promise<GraphQLClient> {
  const config = await readConfig(configPath);
  const serverUrl = config['server-url'];

  if (!serverUrl) {
    throw new CliError(
      'Missing required config "server-url". Run `involute config set server-url <url>` first.',
    );
  }

  const token = config.token;
  const viewerAssertion = process.env.INVOLUTE_VIEWER_ASSERTION ?? config['viewer-assertion'];

  return new GraphQLClient(joinGraphqlEndpoint(serverUrl), {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(viewerAssertion ? { [VIEWER_ASSERTION_HEADER]: viewerAssertion } : {}),
    },
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
    .option('--json', 'Output machine-readable JSON')
    .argument('<key>', 'Configuration key (server-url, token, or viewer-assertion)')
    .argument('<value>', 'Configuration value')
    .action(async function (this: Command, key: string, value: string, options: JsonOption) {
      await runWithCliErrorHandling(async () => {
        if (!CONFIG_KEYS.includes(key as ConfigKey)) {
          throw new CliError(`Unknown config key "${key}". Expected one of: ${CONFIG_KEYS.join(', ')}`);
        }

        await setConfigValue(key as ConfigKey, value);
        const configPath = getConfigPath();
        const context = createCommandContext({ json: options.json ?? getGlobalJsonOption(this) });
        const payload = context.json ? { key, path: configPath } : `Saved ${key} to ${configPath}`;
        process.stdout.write(formatOutput(payload, context));
      });
    });

  configCommand
    .command('get')
    .description('Read a configuration value')
    .argument('<key>', 'Configuration key (server-url, token, or viewer-assertion)')
    .option('--json', 'Output machine-readable JSON')
    .action(async function (this: Command, key: string, options: JsonOption) {
      await runWithCliErrorHandling(async () => {
        if (!CONFIG_KEYS.includes(key as ConfigKey)) {
          throw new CliError(`Unknown config key "${key}". Expected one of: ${CONFIG_KEYS.join(', ')}`);
        }

        const value = await getConfigValue(key as ConfigKey);
        const context = createCommandContext({ json: options.json ?? getGlobalJsonOption(this) });
        const payload = context.json ? { key, value: value ?? null } : value ?? '';
        process.stdout.write(formatOutput(payload, context));
      });
    });
}

function registerAuthCommands(program: Command): void {
  const authCommand = program.command('auth').description('Manage local authentication helpers');
  const viewerAssertionCommand = authCommand
    .command('viewer-assertion')
    .description('Create signed viewer assertions for trusted impersonation');

  viewerAssertionCommand
    .command('create')
    .description('Create a signed viewer assertion for a user ID or email')
    .argument('<subject>', 'User UUID or email address')
    .option('--json', 'Output machine-readable JSON')
    .option('--secret <secret>', 'Override INVOLUTE_VIEWER_ASSERTION_SECRET for this command')
    .option('--ttl <seconds>', 'Assertion lifetime in seconds', '3600')
    .action(
      async function (
        this: Command,
        subject: string,
        options: JsonOption & { secret?: string; ttl: string },
      ) {
        await runWithCliErrorHandling(async () => {
          const ttlSeconds = parseTtlSeconds(options.ttl);
          const secret = options.secret ?? process.env.INVOLUTE_VIEWER_ASSERTION_SECRET;

          if (!secret) {
            throw new CliError(
              'Missing viewer assertion secret. Set INVOLUTE_VIEWER_ASSERTION_SECRET or pass --secret.',
            );
          }

          const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
          const subjectType = inferViewerAssertionSubjectType(subject);
          const assertion = createViewerAssertion(
            {
              exp: Math.floor(expiresAt.getTime() / 1000),
              sub: subject,
              subType: subjectType,
            },
            secret,
          );
          const context = createCommandContext({ json: options.json ?? getGlobalJsonOption(this) });
          const payload = context.json
            ? {
                assertion,
                expiresAt: expiresAt.toISOString(),
                subject,
                subjectType,
              }
            : assertion;

          process.stdout.write(formatOutput(payload, context));
        });
      },
    );
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
  const filter = teamKey
    ? {
        team: {
          key: {
            eq: teamKey,
          },
        },
      }
    : undefined;
  const issues: IssueListItem[] = [];
  let after: string | null = null;

  do {
    const result: { issues: { nodes: IssueListItem[]; pageInfo: PageInfo } } = await client.request(
      /* GraphQL */ `
        query CliIssuesList($after: String, $filter: IssueFilter, $first: Int!) {
          issues(first: $first, after: $after, filter: $filter) {
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
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      {
        filter,
        first: CLI_PAGE_SIZE,
        after,
      },
    );

    issues.push(...result.issues.nodes);
    after = result.issues.pageInfo.hasNextPage ? result.issues.pageInfo.endCursor : null;
  } while (after);

  return issues;
}

async function fetchIssueByIdentifier(identifier: string): Promise<IssueDetail | null> {
  const client = await createConfiguredGraphQLClient();
  const result = await client.request<{
    issue:
      | (Omit<IssueDetail, 'comments'> & {
          comments: { nodes: IssueCommentItem[]; pageInfo: PageInfo };
        })
      | null;
  }>(
    /* GraphQL */ `
      query CliIssueByIdentifier($after: String, $first: Int!, $id: String!) {
        issue(id: $id) {
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
          team {
            key
          }
          comments(first: $first, after: $after, orderBy: createdAt) {
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
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `,
    {
      id: identifier,
      first: CLI_PAGE_SIZE,
      after: null,
    },
  );

  if (!result.issue) {
    return null;
  }

  const issue: IssueDetail = {
    ...result.issue,
    comments: {
      nodes: [...result.issue.comments.nodes],
    },
  };
  let after = result.issue.comments.pageInfo.hasNextPage
    ? result.issue.comments.pageInfo.endCursor
    : null;

  while (after) {
    const nextPage = await client.request<{
      issue: {
        comments: { nodes: IssueCommentItem[]; pageInfo: PageInfo };
      } | null;
    }>(
      /* GraphQL */ `
        query CliIssueCommentPage($after: String, $first: Int!, $id: String!) {
          issue(id: $id) {
            comments(first: $first, after: $after, orderBy: createdAt) {
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
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `,
      {
        id: issue.id,
        first: CLI_PAGE_SIZE,
        after,
      },
    );

    if (!nextPage.issue) {
      break;
    }

    issue.comments.nodes.push(...nextPage.issue.comments.nodes);
    after = nextPage.issue.comments.pageInfo.hasNextPage
      ? nextPage.issue.comments.pageInfo.endCursor
      : null;
  }

  return issue;
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
    const state = (await fetchTeamStates(issue.team.key)).find(
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
  const client = await createConfiguredGraphQLClient();
  const result = await client.request<{
    issue:
      | (IssueCommentsResult & {
          comments: { nodes: IssueCommentItem[]; pageInfo: PageInfo };
        })
      | null;
  }>(
    /* GraphQL */ `
      query CliCommentsList($after: String, $first: Int!, $id: String!) {
        issue(id: $id) {
          id
          identifier
          comments(first: $first, after: $after, orderBy: createdAt) {
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
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `,
    {
      id: issueIdOrIdentifier,
      first: CLI_PAGE_SIZE,
      after: null,
    },
  );

  if (result.issue) {
    const issue: IssueCommentsResult = {
      id: result.issue.id,
      identifier: result.issue.identifier,
      comments: {
        nodes: [...result.issue.comments.nodes],
      },
    };
    let after = result.issue.comments.pageInfo.hasNextPage
      ? result.issue.comments.pageInfo.endCursor
      : null;

    while (after) {
      const nextPage = await client.request<{
        issue:
          | {
              comments: { nodes: IssueCommentItem[]; pageInfo: PageInfo };
            }
          | null;
      }>(
        /* GraphQL */ `
          query CliCommentsPage($after: String, $first: Int!, $id: String!) {
            issue(id: $id) {
              comments(first: $first, after: $after, orderBy: createdAt) {
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
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        `,
        {
          id: issue.id,
          first: CLI_PAGE_SIZE,
          after,
        },
      );

      if (!nextPage.issue) {
        break;
      }

      issue.comments.nodes.push(...nextPage.issue.comments.nodes);
      after = nextPage.issue.comments.pageInfo.hasNextPage
        ? nextPage.issue.comments.pageInfo.endCursor
        : null;
    }

    return issue;
  }

  throw new CliError(`Issue not found: ${issueIdOrIdentifier}`);
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
    .description('Involute CLI — manage your issue, team, and workspace service')
    .version('0.0.0')
    .enablePositionalOptions();

  registerGlobalOptions(program);
  registerConfigCommands(program);
  registerAuthCommands(program);

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

function inferViewerAssertionSubjectType(subject: string): ViewerAssertionSubjectType {
  return subject.includes('@') ? 'email' : 'id';
}

function parseTtlSeconds(value: string): number {
  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new CliError(`Invalid --ttl value "${value}". Expected a positive integer number of seconds.`);
  }

  return parsedValue;
}
