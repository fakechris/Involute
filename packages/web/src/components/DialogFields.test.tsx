import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FieldDefinitionSummary } from '../board/types';
import { DialogFields, missingRequiredFields } from './DialogFields';

// INV-1524: a required field with a default is filled by the server, so it does not block.
afterEach(() => cleanup());
const field = (overrides: Partial<FieldDefinitionSummary>): FieldDefinitionSummary => ({ key: 'customer', label: 'Customer', type: 'TEXT', required: true, options: [], ...overrides });

describe('required fields with defaults (INV-1524)', () => {
  it('are not missing and say they take their default', () => {
    const withDefault = field({ defaultValue: 'internal' });
    expect(missingRequiredFields([withDefault], {})).toEqual([]);
    expect(missingRequiredFields([field({})], {})).toEqual(['Customer']);
    render(<DialogFields definitions={[withDefault]} values={{}} onChange={vi.fn()} />);
    expect(screen.getByText('Left empty, these take their default: Customer.')).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
  });
});
