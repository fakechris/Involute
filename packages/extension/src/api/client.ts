import { OPERATIONS, type OperationData, type OperationName } from './operations';

export class GraphQLRequestError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

/**
 * Run one of the extension's operations against `${server}/graphql` with the
 * extension token (INV-1147). Only the background calls this: pages and the
 * panel never hold the token in a request of their own.
 */
export async function runOperation<Name extends OperationName>(
  fetchImpl: typeof fetch,
  connection: { server: string; token: string },
  name: Name,
  variables: Record<string, unknown>,
): Promise<OperationData[Name]> {
  let response: Response;
  try {
    response = await fetchImpl(`${connection.server}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ query: OPERATIONS[name], operationName: name, variables }),
      credentials: 'omit',
    });
  } catch {
    throw new GraphQLRequestError(`Involute at ${connection.server} could not be reached.`, null);
  }
  type Body = { data?: OperationData[Name]; errors?: Array<{ message?: string }> };
  const body = (await response.json().catch(() => null)) as Body | null;
  if (response.status === 401) throw new GraphQLRequestError('The extension is no longer connected. Connect it again in Options.', 401);
  const message = body?.errors?.map((error: { message?: string }) => error.message).filter(Boolean).join('; ');
  if (message) throw new GraphQLRequestError(message, response.status);
  if (!response.ok || !body?.data) throw new GraphQLRequestError(`Involute answered ${response.status}.`, response.status);
  return body.data;
}
