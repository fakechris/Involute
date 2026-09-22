import { describe, expect, it, vi } from 'vitest';
import { baselineProvider, createJevProvider, validateEvaluation } from './semantic-advice-provider.js';
import type { AdviceProvider, EvaluationInput } from './semantic-advice/types.js';

const input: EvaluationInput = {
  state: { text: '登录后出现错误' },
  checks: [
    { id: 'category', kind: 'selection', instruction: 'Classify', options: { bug: 'Defect', unknown: 'Insufficient information' } },
    { id: 'missing', kind: 'likelihood', instruction: 'Are steps missing?' },
    { id: 'relevance', kind: 'rating', instruction: 'Relevance', levels: ['Unrelated', 'Related', 'Direct'] },
  ],
  baseline: { model: 'baseline-v1', judgments: { category: { kind: 'selection', value: 'unknown' }, missing: { kind: 'likelihood', value: null }, relevance: { kind: 'rating', value: null } } },
};
const wire = () => ({ model: 'jev-1.13.0', answers: {
  category: { type: 'choice', choice: 'bug', confidence: 0.8, probabilities: { bug: 0.9, unknown: 0.1 } },
  missing: { type: 'noul', noul: 0.8 },
  relevance: { type: 'score', score: 1.5, confidence: 0.5, probabilities: { 0: 0, 1: 0.5, 2: 0.5 } },
}, usage: { input_tokens: 42, output_tokens: 5 } });
const signal = () => new AbortController().signal;

describe('provider contracts', () => {
  const alternative: AdviceProvider = {
    id: 'alternative', capabilities: new Set(['selection', 'likelihood', 'rating']),
    async evaluate() {
      // A completely different wire layout with no confidence or probabilities.
      const result = [{ field: 'category', label: 'bug' }, { field: 'missing', number: 0.8 }, { field: 'relevance', number: 1.5 }];
      return { model: 'other-v1', judgments: Object.fromEntries(result.map((x, i) => [x.field, { kind: input.checks[i]!.kind, value: x.label ?? x.number! }])) };
    },
  };
  for (const [name, provider, model] of [
    ['baseline', baselineProvider, 'baseline-v1'],
    ['jev', createJevProvider({ apiKey: () => 'test-key', fetch: vi.fn(async () => Response.json(wire())) }), 'jev-1.13.0'],
    ['alternative', alternative, 'other-v1'],
  ] as const) {
    it(`${name} satisfies the same domain contract`, async () => {
      const result = await provider.evaluate(structuredClone(input), model, signal());
      expect(validateEvaluation(result, input.checks)).toEqual(result);
      expect(Object.keys(result.judgments)).toEqual(['category', 'missing', 'relevance']);
      if (name !== 'jev') expect(result.judgments.category?.uncertainty).toBeUndefined();
    });
  }
  it('maps typed checks, carries cancellation and does not forward baseline values', async () => {
    const fetcher = vi.fn(async () => Response.json(wire()));
    const s = signal();
    await createJevProvider({ apiKey: () => 'test-key', fetch: fetcher }).evaluate(input, 'jev-1.13.0', s);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.signal).toBe(s); expect(init.redirect).toBe('error');
    const body = JSON.parse(init.body as string);
    expect(body.questions.missing.type).toBe('noul');
    expect(body.baseline).toBeUndefined();
  });
  it.each(['jev-latest', 'jev-preview', 'other-v1'])('rejects unpinned or unsupported model %s before network', async model => {
    const fetcher = vi.fn();
    await expect(createJevProvider({ apiKey: () => 'test', fetch: fetcher }).evaluate(input, model, signal())).rejects.toMatchObject({ code: 'not_configured' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('missing credentials never calls the network', async () => {
    const fetcher = vi.fn();
    await expect(createJevProvider({ apiKey: () => undefined, fetch: fetcher }).evaluate(input, 'jev-1.13.0', signal())).rejects.toMatchObject({ code: 'not_configured' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    (r: ReturnType<typeof wire>) => { r.answers.category.choice = 'not-a-candidate'; },
    (r: ReturnType<typeof wire>) => { r.answers.missing.noul = 1.1; },
    (r: ReturnType<typeof wire>) => { r.answers.category.confidence = -1; },
    (r: ReturnType<typeof wire>) => { r.answers.relevance.score = 4; },
    (r: ReturnType<typeof wire>) => { r.answers.category.probabilities.bug = 0.2; },
    (r: ReturnType<typeof wire>) => { r.model = 'jev-1.14.0'; },
    (r: ReturnType<typeof wire>) => { delete (r.answers as Partial<typeof r.answers>).missing; },
    (r: ReturnType<typeof wire>) => { r.usage.input_tokens = -1; },
  ])('rejects malformed provider output', async corrupt => {
    const response = wire(); corrupt(response);
    const provider = createJevProvider({ apiKey: () => 'secret', fetch: vi.fn(async () => Response.json(response)) });
    await expect(provider.evaluate(input, 'jev-1.13.0', signal())).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('bounds response size', async () => {
    const provider = createJevProvider({ apiKey: () => 'secret', fetch: vi.fn(async () => new Response('x'.repeat(512_001))) });
    await expect(provider.evaluate(input, 'jev-1.13.0', signal())).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('classifies rate limits without echoing credentials or provider body', async () => {
    const provider = createJevProvider({ apiKey: () => 'secret', fetch: vi.fn(async () => new Response('private data', { status: 429 })) });
    await expect(provider.evaluate(input, 'jev-1.13.0', signal())).rejects.toEqual(expect.objectContaining({ message: 'rate_limit' }));
  });
});
