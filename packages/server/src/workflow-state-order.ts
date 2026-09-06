// Closed group enum: ordering is by state group first, so custom-named states
// still land in the right section for teams.states, CLI output, and board data.
const WORKFLOW_STATE_TYPE_ORDER = [
  'BACKLOG',
  'UNSTARTED',
  'STARTED',
  'REVIEW',
  'COMPLETED',
  'CANCELED',
] as const;

export function orderWorkflowStates<
  TState extends { name: string; type: string; position?: number | null },
>(states: TState[]): TState[] {
  return [...states].sort((left, right) => {
    const typeDiff = stateTypeRank(left.type) - stateTypeRank(right.type);

    if (typeDiff !== 0) {
      return typeDiff;
    }

    const leftPosition = left.position ?? 0;
    const rightPosition = right.position ?? 0;

    if (leftPosition !== rightPosition) {
      return leftPosition - rightPosition;
    }

    return left.name.localeCompare(right.name);
  });
}

function stateTypeRank(type: string): number {
  const index = (WORKFLOW_STATE_TYPE_ORDER as readonly string[]).indexOf(type);

  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}
