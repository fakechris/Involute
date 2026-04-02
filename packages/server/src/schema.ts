import type {
  Comment,
  Issue,
  IssueLabel,
  Prisma,
  PrismaClient,
  Team,
  User,
  WorkflowState,
} from '@prisma/client';

import { makeExecutableSchema } from '@graphql-tools/schema';
import { GraphQLScalarType, Kind } from 'graphql';

import { DEFAULT_WORKFLOW_STATE_ORDER } from './constants.js';
import { getExposedError, isPrismaInvalidInputError } from './errors.js';
import type {
  CreateCommentInput,
  CreateIssueInput,
  UpdateIssueInput,
} from './issue-service.js';
import { buildIssueWhere, type IssueFilterInput } from './issue-filter.js';

import { requireAuthentication, type GraphQLContext } from './auth.js';
import { createComment, createIssue, updateIssue } from './issue-service.js';

type TeamParent = Team & { states?: WorkflowState[] | null };
type UserParent = User;
type CommentParent = Comment & { user?: User | null };
type IssueParent = Issue & {
  assignee?: User | null;
  comments?: Comment[] | null;
  parent?: Issue | null;
  state?: WorkflowState | null;
  team?: Team | null;
};

interface StringComparatorInput {
  eq?: string | null;
  in?: string[] | null;
  nin?: string[] | null;
}

interface TeamFilterInput {
  key?: StringComparatorInput | null;
}

interface IssueLabelFilterInput {
  name?: StringComparatorInput | null;
}

type CommentOrderByInput = 'createdAt';

const workflowStateOrder = new Map<string, number>(
  DEFAULT_WORKFLOW_STATE_ORDER.map((name, index) => [name, index] as const),
);

const DateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  serialize(value: unknown): string {
    return serializeDateTime(value);
  },
  parseValue(value: unknown): Date {
    if (typeof value !== 'string') {
      throw new TypeError('DateTime values must be provided as ISO 8601 strings.');
    }

    return parseDateTime(value);
  },
  parseLiteral(ast): Date {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError('DateTime values must be provided as ISO 8601 strings.');
    }

    return parseDateTime(ast.value);
  },
});

const typeDefs = /* GraphQL */ `
  scalar DateTime

  type Query {
    issue(id: String!): Issue
    issues(first: Int!, filter: IssueFilter): IssueConnection!
    teams(filter: TeamFilter): TeamConnection!
    issueLabels(filter: IssueLabelFilter): IssueLabelConnection!
    users: UserConnection!
  }

  type Mutation {
    issueCreate(input: IssueCreateInput!): IssueCreatePayload!
    issueUpdate(id: String!, input: IssueUpdateInput!): IssueUpdatePayload!
    commentCreate(input: CommentCreateInput!): CommentCreatePayload!
  }

  type Team {
    id: ID!
    key: String!
    name: String!
    states: WorkflowStateConnection!
  }

  type WorkflowState {
    id: ID!
    name: String!
  }

  type IssueLabel {
    id: ID!
    name: String!
  }

  type User {
    id: ID!
    name: String
    email: String
    isMe: Boolean
  }

  type Comment {
    id: ID!
    body: String!
    createdAt: DateTime!
    user: User
  }

  enum CommentOrderBy {
    createdAt
  }

  type Issue {
    id: ID!
    identifier: String!
    title: String!
    description: String
    createdAt: DateTime!
    updatedAt: DateTime!
    state: WorkflowState!
    labels: IssueLabelConnection!
    assignee: User
    parent: Issue
    children: IssueConnection!
    team: Team!
    comments(first: Int, orderBy: CommentOrderBy): CommentConnection!
  }

  type TeamConnection {
    nodes: [Team!]!
  }

  type WorkflowStateConnection {
    nodes: [WorkflowState!]!
  }

  type IssueLabelConnection {
    nodes: [IssueLabel!]!
  }

  type IssueConnection {
    nodes: [Issue!]!
  }

  type UserConnection {
    nodes: [User!]!
  }

  type CommentConnection {
    nodes: [Comment!]!
  }

  input StringComparator {
    eq: String
    in: [String!]
    nin: [String!]
  }

  input BooleanComparator {
    eq: Boolean
  }

  input TeamFilter {
    key: StringComparator
  }

  input WorkflowStateFilterRef {
    name: StringComparator
  }

  input UserFilterRef {
    isMe: BooleanComparator
  }

  input IssueLabelFilterRef {
    name: StringComparator
  }

  input IssueLabelRelationFilter {
    some: IssueLabelFilterRef
    every: IssueLabelFilterRef
  }

  input IssueFilter {
    and: [IssueFilter!]
    team: TeamFilter
    state: WorkflowStateFilterRef
    assignee: UserFilterRef
    labels: IssueLabelRelationFilter
  }

  input IssueLabelFilter {
    name: StringComparator
  }

  input IssueCreateInput {
    teamId: String!
    title: String!
    description: String
    stateId: String
  }

  input IssueUpdateInput {
    stateId: String
    labelIds: [String!]
    parentId: String
    title: String
    description: String
    assigneeId: String
  }

  input CommentCreateInput {
    issueId: String!
    body: String!
  }

  type IssueCreatePayload {
    success: Boolean!
    issue: Issue
  }

  type IssueUpdatePayload {
    success: Boolean!
    issue: Issue
  }

  type CommentCreatePayload {
    success: Boolean!
    comment: Comment
  }
`;

const resolvers = {
  DateTime: DateTimeScalar,
  Query: {
    issue: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<Issue | null> => {
      try {
        return await context.prisma.issue.findUnique({
          where: {
            id: args.id,
          },
        });
      } catch (error) {
        if (isPrismaInvalidInputError(error)) {
          return null;
        }

        throw error;
      }
    },
    issues: async (
      _parent: unknown,
      args: { filter?: IssueFilterInput | null; first: number },
      context: GraphQLContext,
    ): Promise<{ nodes: Issue[] }> => {
      const where = buildIssueWhere(args.filter, context.viewer?.id ?? null);

      return {
        nodes: await context.prisma.issue.findMany({
          ...(where ? { where } : {}),
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: args.first,
        }),
      };
    },
    teams: async (
      _parent: unknown,
      args: { filter?: TeamFilterInput | null },
      context: GraphQLContext,
    ): Promise<{ nodes: Team[] }> => {
      const where = buildTeamWhere(args.filter);

      return {
        nodes: await context.prisma.team.findMany({
          ...(where ? { where } : {}),
          orderBy: {
            key: 'asc',
          },
        }),
      };
    },
    issueLabels: async (
      _parent: unknown,
      args: { filter?: IssueLabelFilterInput | null },
      context: GraphQLContext,
    ): Promise<{ nodes: IssueLabel[] }> => {
      const where = buildIssueLabelWhere(args.filter);

      return {
        nodes: await context.prisma.issueLabel.findMany({
          ...(where ? { where } : {}),
          orderBy: {
            name: 'asc',
          },
        }),
      };
    },
    users: async (
      _parent: unknown,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: User[] }> => ({
      nodes: await context.prisma.user.findMany({
        orderBy: [{ email: 'asc' }, { id: 'asc' }],
      }),
    }),
  },
  Mutation: {
    issueCreate: async (
      _parent: unknown,
      args: { input: CreateIssueInput },
      context: GraphQLContext,
    ): Promise<{ issue: Issue | null; success: boolean }> =>
      runIssueMutation(async () => ({
        issue: await createIssue(context.prisma, args.input),
        success: true as const,
      })),
    issueUpdate: async (
      _parent: unknown,
      args: { id: string; input: UpdateIssueInput },
      context: GraphQLContext,
    ): Promise<{ issue: Issue | null; success: boolean }> =>
      runIssueMutation(async () => ({
        issue: await updateIssue(context.prisma, args.id, args.input),
        success: true as const,
      })),
    commentCreate: async (
      _parent: unknown,
      args: { input: CreateCommentInput },
      context: GraphQLContext,
    ): Promise<{ comment: Comment | null; success: boolean }> => {
      const viewer = requireAuthentication(context);

      return runCommentMutation(async () => ({
        comment: await createComment(context.prisma, args.input, viewer.id),
        success: true as const,
      }));
    },
  },
  Team: {
    states: async (
      parent: TeamParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: WorkflowState[] }> => {
      const states =
        parent.states ??
        (await context.prisma.workflowState.findMany({
          where: {
            teamId: parent.id,
          },
        }));

      return {
        nodes: orderWorkflowStates(states),
      };
    },
  },
  User: {
    isMe: (parent: UserParent, _args: Record<string, never>, context: GraphQLContext): boolean =>
      context.viewer?.id === parent.id,
  },
  Comment: {
    user: async (
      parent: CommentParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User | null> =>
      parent.user ??
      context.prisma.user.findUnique({
        where: {
          id: parent.userId,
        },
      }),
  },
  Issue: {
    state: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<WorkflowState> =>
      parent.state ??
      context.prisma.workflowState.findUniqueOrThrow({
        where: {
          id: parent.stateId,
        },
      }),
    labels: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: IssueLabel[] }> => ({
      nodes: await context.prisma.issueLabel.findMany({
        where: {
          issues: {
            some: {
              id: parent.id,
            },
          },
        },
        orderBy: {
          name: 'asc',
        },
      }),
    }),
    assignee: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<User | null> => {
      if (!parent.assigneeId) {
        return null;
      }

      return (
        parent.assignee ??
        context.prisma.user.findUnique({
          where: {
            id: parent.assigneeId,
          },
        })
      );
    },
    parent: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<Issue | null> => {
      if (!parent.parentId) {
        return null;
      }

      return (
        parent.parent ??
        context.prisma.issue.findUnique({
          where: {
            id: parent.parentId,
          },
        })
      );
    },
    children: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: Issue[] }> => ({
      nodes: await context.prisma.issue.findMany({
        where: {
          parentId: parent.id,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    }),
    team: async (
      parent: IssueParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<Team> =>
      parent.team ??
      context.prisma.team.findUniqueOrThrow({
        where: {
          id: parent.teamId,
        },
      }),
    comments: async (
      parent: IssueParent,
      args: { first?: number; orderBy?: CommentOrderByInput },
      context: GraphQLContext,
    ): Promise<{ nodes: Comment[] }> => ({
      nodes: await context.prisma.comment.findMany({
        where: {
          issueId: parent.id,
        },
        orderBy: buildCommentOrderBy(args.orderBy),
        ...(args.first === undefined ? {} : { take: args.first }),
      }),
    }),
  },
};

export function createGraphQLSchema(_prisma: PrismaClient) {
  return makeExecutableSchema({
    typeDefs,
    resolvers,
  });
}

function orderWorkflowStates(states: WorkflowState[]): WorkflowState[] {
  return [...states].sort((left, right) => {
    const leftOrder = workflowStateOrder.get(left.name) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = workflowStateOrder.get(right.name) ?? Number.MAX_SAFE_INTEGER;

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return left.name.localeCompare(right.name);
  });
}

function buildTeamWhere(filter: TeamFilterInput | null | undefined) {
  const key = filter?.key?.eq;

  if (key === undefined || key === null) {
    return undefined;
  }

  return {
    key,
  };
}

function buildIssueLabelWhere(filter: IssueLabelFilterInput | null | undefined) {
  const name = filter?.name?.eq;

  if (name === undefined || name === null) {
    return undefined;
  }

  return {
    name,
  };
}

function serializeDateTime(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string') {
    return parseDateTime(value).toISOString();
  }

  throw new TypeError('DateTime values must be Date instances or ISO 8601 strings.');
}

function parseDateTime(value: string): Date {
  const parsedValue = new Date(value);

  if (Number.isNaN(parsedValue.getTime())) {
    throw new TypeError('DateTime values must be provided as ISO 8601 strings.');
  }

  return parsedValue;
}

function buildCommentOrderBy(
  orderBy: CommentOrderByInput | null | undefined,
): Prisma.CommentOrderByWithRelationInput[] {
  if (orderBy === undefined || orderBy === null || orderBy === 'createdAt') {
    return [{ createdAt: 'asc' }, { id: 'asc' }];
  }

  return [{ createdAt: 'asc' }, { id: 'asc' }];
}

async function runIssueMutation<TResult extends { issue: Issue; success: true }>(
  operation: () => Promise<TResult>,
): Promise<TResult | { issue: null; success: false }> {
  try {
    return await operation();
  } catch (error) {
    if (getExposedError(error) || isPrismaInvalidInputError(error)) {
      return {
        issue: null,
        success: false,
      };
    }

    throw error;
  }
}

async function runCommentMutation<TResult extends { comment: Comment; success: true }>(
  operation: () => Promise<TResult>,
): Promise<TResult | { comment: null; success: false }> {
  try {
    return await operation();
  } catch (error) {
    if (getExposedError(error) || isPrismaInvalidInputError(error)) {
      return {
        comment: null,
        success: false,
      };
    }

    throw error;
  }
}
