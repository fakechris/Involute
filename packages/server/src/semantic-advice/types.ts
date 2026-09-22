/** Domain-neutral judgments. Provider wire formats never cross this interface. */
export type Check =
  | { id: string; kind: 'selection'; instruction: string; options: Record<string, string> }
  | { id: string; kind: 'likelihood'; instruction: string }
  | { id: string; kind: 'rating'; instruction: string; levels: string[] };
export interface Judgment {
  kind: Check['kind'];
  value: string | number | null;
  /** Missing when a provider does not publish uncertainty; never synthesized. */
  uncertainty?: { semantics: string; confidence?: number; distribution?: Record<string, number> };
}
export interface Evaluation {
  model: string;
  judgments: Record<string, Judgment>;
  usage?: { inputTokens: number; outputTokens: number };
}
export interface EvaluationInput {
  state: unknown;
  checks: Check[];
  baseline: Evaluation;
}
export interface AdviceProvider {
  id: string;
  capabilities: ReadonlySet<Check['kind']>;
  evaluate(input: EvaluationInput, model: string, signal: AbortSignal): Promise<Evaluation>;
}
export type Failure = 'timeout' | 'canceled' | 'stale' | 'capacity' | 'budget' | 'unsupported'
  | 'invalid_input' | 'invalid_response' | 'rate_limit' | 'not_configured' | 'provider_error' | 'journal_error';
export class AdviceError extends Error {
  constructor(readonly code: Failure) { super(code); }
}
/** Atomic first-writer-wins storage. Implementations must survive worker/process restarts. */
export interface AdviceJournal {
  put(key: string, value: unknown): Promise<unknown>;
  get(key: string): Promise<unknown | undefined>;
}
