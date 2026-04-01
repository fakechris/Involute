import type {
  Comment,
  Issue,
  IssueLabel,
  PrismaClient,
  Team,
  User,
  WorkflowState,
} from '@prisma/client';

import { makeExecutableSchema } from '@graphql-tools/schema';
import { GraphQLScalarType, Kind } from 'graphql';

import { DEFAULT_WORKFLOW_STATE_ORDER } from './constants.js';
import type { CreateIssueInput, UpdateIssueInput } from './issue-service.js';

import { type GraphQLContext } from './auth.js';
import { createIssue, updateIssue } from './issue-service.js';

type TeamParent = Team & { states?: WorkflowState[] | null };
type UserParent = User;
type CommentParent = Comment & { user?: User | null };
type IssueParent = Issue & {
  assignee?: User | null;
  comments?: Comment[] | null;
  state?: WorkflowState | null;
  team?: Team | null;
};

const workflowStateOrder = new Map<string, number>(
  DEFAULT_WORKFLOW_STATE_ORDER.map((name, index) => [name, index] as const),
);

const DateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  serialize(value: unknown): string {
    if (value instanceof Date) {
      return value.toISOString();
    }

    if (typeof value === 'string') {
      return new Date(value).toISOString();
    }

    throw new TypeError('DateTime values must be Date instances or ISO 8601 strings.');
  },
  parseValue(value: unknown): Date {
    if (typeof value !== 'string') {
      throw new TypeError('DateTime values must be provided as ISO 8601 strings.');
    }

    return new Date(value);
  },
  parseLiteral(ast): Date {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError('DateTime values must be provided as ISO 8601 strings.');
    }

    return new Date(ast.value);
  },
});

const typeDefs = /* GraphQL */ `
  scalar DateTime

  type Query {
    issue(id: String!): Issue
    teams: TeamConnection!
    issueLabels: IssueLabelConnection!
  }

  type Mutation {
    issueCreate(input: IssueCreateInput!): IssueCreatePayload!
    issueUpdate(id: String!, input: IssueUpdateInput!): IssueUpdatePayload!
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
    state: WorkflowState!
    labels: IssueLabelConnection!
    assignee: User
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

  type CommentConnection {
    nodes: [Comment!]!
  }

  input IssueCreateInput {
    teamId: String!
    title: String!
    description: String
    stateId: String
  }

  input IssueUpdateInput {
    stateId: String
  }

  type IssueCreatePayload {
    success: Boolean!
    issue: Issue
  }

  type IssueUpdatePayload {
    success: Boolean!
    issue: Issue
  }
`;

const resolvers = {
  DateTime: DateTimeScalar,
  Query: {
    issue: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<Issue | null> =>
      context.prisma.issue.findUnique({
        where: {
          id: args.id,
        },
      }),
    teams: async (
      _parent: unknown,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: Team[] }> => ({
      nodes: await context.prisma.team.findMany({
        orderBy: {
          key: 'asc',
        },
      }),
    }),
    issueLabels: async (
      _parent: unknown,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<{ nodes: IssueLabel[] }> => ({
      nodes: await context.prisma.issueLabel.findMany({
        orderBy: {
          name: 'asc',
        },
      }),
    }),
  },
  Mutation: {
    issueCreate: async (
      _parent: unknown,
      args: { input: CreateIssueInput },
      context: GraphQLContext,
    ): Promise<{ issue: Issue; success: true }> => ({
      success: true,
      issue: await createIssue(context.prisma, args.input),
    }),
    issueUpdate: async (
      _parent: unknown,
      args: { id: string; input: UpdateIssueInput },
      context: GraphQLContext,
    ): Promise<{ issue: Issue; success: true }> => ({
      success: true,
      issue: await updateIssue(context.prisma, args.id, args.input),
    }),
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
      args: { first?: number; orderBy?: 'createdAt' },
      context: GraphQLContext,
    ): Promise<{ nodes: Comment[] }> => ({
      nodes: await context.prisma.comment.findMany({
        where: {
          issueId: parent.id,
        },
        orderBy: {
          createdAt: 'asc',
        },
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
