import type { WorkEvidenceKind, WorkRunStatus } from '@prisma/client';

/** How objectively clear In Review evidence is. Only CLEAR may auto-Done. */
export type AutoAcceptTier = 'CLEAR' | 'LIKELY' | 'AMBIGUOUS' | 'INSUFFICIENT';

export interface EvidenceGradeInput {
  kind: WorkEvidenceKind | string;
  summary?: string | null;
  url?: string | null;
}

export interface AutoAcceptGradeInput {
  evidence: EvidenceGradeInput[];
  runStatus?: WorkRunStatus | string | null;
}

export interface ParsedEvidenceSignals {
  checks: 'pass' | 'fail' | null;
  exit: 'pass' | 'fail' | null;
  kind: string;
  merged: 'pass' | 'fail' | null;
  status: 'pass' | 'fail' | null;
}

export interface AutoAcceptGradeResult {
  reasons: string[];
  signals: ParsedEvidenceSignals[];
  tier: AutoAcceptTier;
}

const PASS_BOOL = new Set(['true', 'yes', 'merged', '1']);
const FAIL_BOOL = new Set(['false', 'no', 'open', '0']);
const PASS_STATUS = new Set(['pass', 'passed', 'success', 'ok', 'green']);
const FAIL_STATUS = new Set(['fail', 'failed', 'error', 'red', 'pending']);

/**
 * Pure grader for INV-11. Conservative by design: only CLEAR is auto-Done
 * eligible, and soft evidence kinds never promote to CLEAR alone.
 */
export function evaluateAutoAcceptGrade(input: AutoAcceptGradeInput): AutoAcceptGradeResult {
  const reasons: string[] = [];
  const signals = input.evidence.map((item) => parseEvidenceSignals(item));
  const runStatus = String(input.runStatus ?? '').trim().toUpperCase();

  if (runStatus !== 'COMPLETED') {
    reasons.push('requires a COMPLETED run');
    return { reasons, signals, tier: 'INSUFFICIENT' };
  }

  if (input.evidence.length === 0) {
    reasons.push('no evidence attached to the completed run');
    return { reasons, signals, tier: 'INSUFFICIENT' };
  }

  const hasFail = signals.some(
    (signal) =>
      signal.merged === 'fail' ||
      signal.checks === 'fail' ||
      signal.exit === 'fail' ||
      signal.status === 'fail',
  );
  if (hasFail) {
    reasons.push('fail signal present on evidence; refusing CLEAR');
    return { reasons, signals, tier: 'AMBIGUOUS' };
  }

  const clearHits: string[] = [];
  let hasHardEvidence = false;
  let hasSoftEvidence = false;

  for (const signal of signals) {
    const kind = signal.kind;
    if (kind === 'PR') {
      hasHardEvidence = true;
      // PR CLEAR requires an explicit merged pass. checks-only stays LIKELY.
      if (signal.merged === 'pass') {
        clearHits.push('PR merged');
      } else if (signal.checks === 'pass') {
        reasons.push('PR has green checks but no merged signal');
      } else {
        reasons.push('PR evidence lacks objective merged/checks signals');
      }
    } else if (kind === 'TEST') {
      hasHardEvidence = true;
      if (signal.exit === 'pass' || signal.status === 'pass') {
        clearHits.push(signal.exit === 'pass' ? 'TEST exit 0' : 'TEST status pass');
      } else {
        reasons.push('TEST evidence lacks exit:0 or status:pass');
      }
    } else {
      hasSoftEvidence = true;
    }
  }

  if (clearHits.length > 0) {
    reasons.push(`CLEAR signals: ${clearHits.join(', ')}`);
    return { reasons, signals, tier: 'CLEAR' };
  }

  if (hasHardEvidence) {
    if (reasons.length === 0) {
      reasons.push('PR/TEST evidence present without objective pass signals');
    }
    return { reasons, signals, tier: 'LIKELY' };
  }

  if (hasSoftEvidence) {
    reasons.push('only soft evidence (log/screenshot/artifact/decision); human review required');
    return { reasons, signals, tier: 'AMBIGUOUS' };
  }

  reasons.push('unable to classify evidence');
  return { reasons, signals, tier: 'INSUFFICIENT' };
}

export function parseEvidenceSignals(evidence: EvidenceGradeInput): ParsedEvidenceSignals {
  const kind = String(evidence.kind ?? '').trim().toUpperCase();
  const tokens = tokenizeSummary(evidence.summary);
  const mergedRaw = tokens.get('merged') ?? tokens.get('merge_state') ?? tokens.get('merge');
  const checksRaw = tokens.get('checks') ?? tokens.get('ci');
  const exitRaw = tokens.get('exit') ?? tokens.get('exit_code') ?? tokens.get('exitcode');
  const statusRaw = tokens.get('status') ?? tokens.get('result');

  return {
    kind,
    merged: classifyBool(mergedRaw),
    checks: classifyStatus(checksRaw),
    exit: classifyExit(exitRaw),
    status: classifyStatus(statusRaw),
  };
}

function tokenizeSummary(summary: string | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!summary) {
    return map;
  }

  // Accept "merged: true", "merged=true", "exit:0", and comma/newline separated pairs.
  const pattern = /([a-z_]+)\s*[:=]\s*([a-z0-9_-]+)/gi;
  for (const match of summary.matchAll(pattern)) {
    const key = normalizeToken(match[1]);
    const value = normalizeToken(match[2]);
    if (key && value) {
      map.set(key, value);
    }
  }
  return map;
}

function classifyBool(value: string | undefined): 'pass' | 'fail' | null {
  if (!value) return null;
  if (PASS_BOOL.has(value) || value === 'merged') return 'pass';
  if (FAIL_BOOL.has(value)) return 'fail';
  return null;
}

function classifyStatus(value: string | undefined): 'pass' | 'fail' | null {
  if (!value) return null;
  if (PASS_STATUS.has(value)) return 'pass';
  if (FAIL_STATUS.has(value)) return 'fail';
  return null;
}

function classifyExit(value: string | undefined): 'pass' | 'fail' | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    return value === '0' ? 'pass' : 'fail';
  }
  return null;
}

function normalizeToken(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}
