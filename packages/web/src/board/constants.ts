export const BOARD_COLUMN_ORDER = [
  'Backlog',
  'Ready',
  'In Progress',
  'In Review',
  'Done',
  'Canceled',
] as const;

export type BoardColumnName = (typeof BOARD_COLUMN_ORDER)[number];
