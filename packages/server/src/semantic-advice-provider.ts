import { AdviceError, type AdviceProvider, type Evaluation, type EvaluationInput } from './semantic-advice/types.js';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdviceError('invalid_response');
  return value as Record<string, unknown>;
}
function finite(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new AdviceError('invalid_response');
  return value;
}
export function validateEvaluation(value: unknown, checks: EvaluationInput['checks']): Evaluation {
  const result = record(value);
  if (typeof result.model !== 'string' || !result.model.trim()) throw new AdviceError('invalid_response');
  const judgments = record(result.judgments);
  if (Object.keys(judgments).length !== checks.length) throw new AdviceError('invalid_response');
  for (const check of checks) {
    const answer = record(judgments[check.id]);
    if (answer.kind !== check.kind) throw new AdviceError('invalid_response');
    if (answer.value !== null) {
      if (check.kind === 'selection') {
        if (typeof answer.value !== 'string' || !Object.hasOwn(check.options, answer.value)) throw new AdviceError('invalid_response');
      } else finite(answer.value, 0, check.kind === 'rating' ? check.levels.length - 1 : 1);
    }
    if (answer.uncertainty !== undefined) {
      const u = record(answer.uncertainty);
      if (typeof u.semantics !== 'string' || !u.semantics.trim()) throw new AdviceError('invalid_response');
      if (u.confidence !== undefined) finite(u.confidence, 0, 1);
      if (u.distribution !== undefined) {
        const distribution = record(u.distribution);
        const keys = check.kind === 'selection' ? Object.keys(check.options)
          : check.kind === 'rating' ? check.levels.map((_, i) => String(i)) : ['false', 'true'];
        if (Object.keys(distribution).length !== keys.length || keys.some(k => !Object.hasOwn(distribution, k))) throw new AdviceError('invalid_response');
        const sum = keys.reduce((total, key) => total + finite(distribution[key], 0, 1), 0);
        if (Math.abs(sum - 1) > 0.001) throw new AdviceError('invalid_response');
      }
    }
  }
  if (result.usage !== undefined) {
    const usage = record(result.usage);
    for (const key of ['inputTokens', 'outputTokens']) {
      if (!Number.isSafeInteger(usage[key]) || Number(usage[key]) < 0) throw new AdviceError('invalid_response');
    }
  }
  return {
    model: result.model,
    judgments: Object.fromEntries(checks.map(check => {
      const a = record(judgments[check.id]);
      const u = a.uncertainty === undefined ? undefined : record(a.uncertainty);
      return [check.id, { kind: check.kind, value: a.value as string | number | null,
        ...(u ? { uncertainty: { semantics: u.semantics as string,
          ...(u.confidence === undefined ? {} : { confidence: u.confidence as number }),
          ...(u.distribution === undefined ? {} : { distribution: { ...u.distribution as Record<string, number> } }),
        } } : {}),
      }];
    })),
    ...(result.usage === undefined ? {} : { usage: {
      inputTokens: record(result.usage).inputTokens as number,
      outputTokens: record(result.usage).outputTokens as number,
    } }),
  };
}
export const baselineProvider: AdviceProvider = {
  id: 'baseline', capabilities: new Set(['selection', 'likelihood', 'rating']),
  async evaluate(input, _model, signal) {
    if (signal.aborted) throw new AdviceError('canceled');
    return validateEvaluation(input.baseline, input.checks);
  },
};

/** Fixed endpoint, explicit credentials, pinned model, bounded response, no retries/redirects. */
export function createJevProvider(options: { apiKey: () => string | undefined; fetch?: typeof fetch }): AdviceProvider {
  return {
    id: 'jev', capabilities: new Set(['selection', 'likelihood', 'rating']),
    async evaluate(input, model, signal) {
      if (!/^jev-\d+\.\d+\.\d+$/.test(model)) throw new AdviceError('not_configured');
      const key = options.apiKey();
      if (!key?.trim()) throw new AdviceError('not_configured');
      const questions = Object.fromEntries(input.checks.map(check => [check.id,
        check.kind === 'selection' ? { type: 'choice', instructions: check.instruction, criteria: check.options }
          : check.kind === 'rating' ? { type: 'score', instructions: check.instruction, criteria: check.levels }
            : { type: 'noul', instructions: check.instruction },
      ]));
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)('https://api.typesafe.ai/v1/systemone', {
          method: 'POST', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, state: input.state, questions }),
        });
      } catch { throw new AdviceError(signal.aborted ? 'canceled' : 'provider_error'); }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AdviceError(response.status === 429 ? 'rate_limit' : 'provider_error');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AdviceError('invalid_response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 512_000) throw new AdviceError('invalid_response');
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      let raw: Record<string, unknown>;
      try { raw = record(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { throw new AdviceError('invalid_response'); }
      if (raw.model !== model) throw new AdviceError('invalid_response');
      const answers = record(raw.answers);
      if (Object.keys(answers).length !== input.checks.length) throw new AdviceError('invalid_response');
      const judgments = Object.fromEntries(input.checks.map(check => {
        const answer = record(answers[check.id]);
        const expected = { selection: 'choice', likelihood: 'noul', rating: 'score' }[check.kind];
        if (answer.type !== expected) throw new AdviceError('invalid_response');
        return [check.id, check.kind === 'likelihood'
          ? { kind: check.kind, value: finite(answer.noul, 0, 1) }
          : { kind: check.kind, value: answer[expected], uncertainty: {
            semantics: 'typesafe-distribution-concentration-v1',
            confidence: finite(answer.confidence, 0, 1), distribution: record(answer.probabilities),
          } }];
      }));
      const usage = record(raw.usage);
      return validateEvaluation({ model, judgments, usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }, input.checks);
    },
  };
}
