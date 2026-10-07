import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// findBy* waits up to this long. The default 1 s is shorter than a large page's
// first render on a busy CI runner: with pages preloaded (app-test-helpers,
// INV-950), the board still took 500–600 ms on an oversubscribed laptop and
// ran past 1 s on GitHub runners. A passing test is not slower — findBy returns
// as soon as the element appears; only a real failure takes longer to report.
configure({ asyncUtilTimeout: 3000 });
