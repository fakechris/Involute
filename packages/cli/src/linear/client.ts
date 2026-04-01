/**
 * Linear GraphQL API client with cursor-based pagination support.
 * Uses LINEAR_API_TOKEN env var for authentication.
 */

const LINEAR_API_ENDPOINT = 'https://api.linear.app/graphql';

export interface LinearClientOptions {
  apiToken: string;
  endpoint?: string | undefined;
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; path?: string[] }>;
}

export class LinearClient {
  private readonly apiToken: string;
  private readonly endpoint: string;

  constructor(options: LinearClientOptions) {
    this.apiToken = options.apiToken;
    this.endpoint = options.endpoint ?? LINEAR_API_ENDPOINT;
  }

  /**
   * Execute a single GraphQL request against the Linear API.
   */
  async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify({ query, variables });

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.apiToken,
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Linear API HTTP error: ${String(response.status)} ${response.statusText}`);
    }

    const json = (await response.json()) as GraphQLResponse<T>;

    if (json.errors && json.errors.length > 0) {
      const messages = json.errors.map((e) => e.message).join('; ');
      throw new Error(`Linear GraphQL error: ${messages}`);
    }

    if (json.data === undefined) {
      throw new Error('Linear API returned no data');
    }

    return json.data;
  }

  /**
   * Paginate through a connection-style query.
   * The query MUST accept $after: String variable for cursor pagination.
   * The extractor function pulls { nodes, pageInfo } from the response data.
   */
  async paginate<TData, TNode>(
    query: string,
    extractor: (data: TData) => { nodes: TNode[]; pageInfo: PageInfo },
    variables?: Record<string, unknown>,
    pageSize: number = 50,
  ): Promise<TNode[]> {
    const allNodes: TNode[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage) {
      const vars: Record<string, unknown> = {
        ...variables,
        first: pageSize,
        after: cursor,
      };

      const data = await this.request<TData>(query, vars);
      const page = extractor(data);

      allNodes.push(...page.nodes);
      hasNextPage = page.pageInfo.hasNextPage;
      cursor = page.pageInfo.endCursor;
    }

    return allNodes;
  }
}

/**
 * Create a LinearClient from the LINEAR_API_TOKEN env var.
 */
export function createLinearClientFromEnv(endpoint?: string): LinearClient {
  const token = process.env['LINEAR_API_TOKEN'];
  if (!token) {
    throw new Error(
      'LINEAR_API_TOKEN environment variable is required. ' +
      'Get one from Linear Settings → API → Personal API keys.',
    );
  }
  return new LinearClient({ apiToken: token, endpoint });
}
