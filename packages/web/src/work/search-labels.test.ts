import { describe, expect, it } from 'vitest';

import { matchLabel } from './search-labels';

// INV-1117: the label says where the snippet shown under a hit came from.
describe('matchLabel', () => {
  it('names the file when the hit was found in an attachment', () => {
    expect(matchLabel({ matchedField: 'attachment', attachmentFilename: 'postmortem.md' })).toBe('in postmortem.md');
  });

  it('keeps the strongest field and adds the file when only the snippet came from an attachment', () => {
    expect(matchLabel({ matchedField: 'title', attachmentFilename: 'postmortem.md' })).toBe('in title · postmortem.md');
    expect(matchLabel({ matchedField: 'comment', attachmentFilename: 'notes.txt' })).toBe('in comment · notes.txt');
  });

  it('labels other hits by field, and meaning-only hits as related', () => {
    expect(matchLabel({ matchedField: 'comment', attachmentFilename: null })).toBe('in comment');
    expect(matchLabel({ matchedField: 'run' })).toBe('in run');
    expect(matchLabel({ matchedField: 'semantic', attachmentFilename: null })).toBe('related');
  });
});
