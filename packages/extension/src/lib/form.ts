import { redactText, redactUrl } from './redact';
import type { BugCapture, PickedElement } from './types';

export type Severity = 'SEV1' | 'SEV2' | 'SEV3';

/** "triage" sends the report to the candidate queue (no parentId); otherwise the parent's id or identifier. */
export type Location = { kind: 'triage' } | { kind: 'parent'; parentId: string } | { kind: 'none' };

export interface BugForm {
  teamId: string | null;
  title: string;
  stepsToReproduce: string;
  description: string;
  priority: number | null;
  severity: Severity | null;
  location: Location;
}

export const PRIORITIES = [
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
] as const;

/** Steps prefilled from the page (and the picked element), redacted like everything else from it. */
export function defaultSteps(url: string | null, element: PickedElement | null): string {
  const lines = [`1. Open ${url ? redactUrl(url) : 'the page'}`];
  if (element) {
    const label = element.text ? ` (“${redactText(element.text).replace(/\s+/g, ' ').slice(0, 60)}”)` : '';
    lines.push(`2. Click ${redactText(element.selector)}${label}`);
    lines.push('3. ');
  } else {
    lines.push('2. ');
  }
  return lines.join('\n');
}

/** Field → reason; empty when the form can be submitted. Mirrors the server's own refusals (INV-749). */
export function validateForm(form: BugForm): Partial<Record<'teamId' | 'title' | 'stepsToReproduce' | 'priority' | 'location', string>> {
  const errors: Partial<Record<'teamId' | 'title' | 'stepsToReproduce' | 'priority' | 'location', string>> = {};
  if (!form.teamId) errors.teamId = 'Choose a team.';
  if (!form.title.trim()) errors.title = 'Give the bug a title.';
  if (!form.stepsToReproduce.trim()) errors.stepsToReproduce = 'Steps to reproduce are required.';
  if (form.priority === null || !Number.isInteger(form.priority) || form.priority < 1 || form.priority > 4) {
    errors.priority = 'Choose a priority (1 Urgent – 4 Low).';
  }
  if (form.location.kind === 'none') errors.location = 'Choose where the bug belongs, or “Not sure — send to triage”.';
  return errors;
}

/** The BugReportInput the panel submits. */
export function buildBugReportInput(form: BugForm, capture: BugCapture) {
  if (!form.teamId || form.priority === null) throw new Error('The form is not valid.');
  return {
    teamId: form.teamId,
    title: form.title.trim(),
    description: form.description.trim() || null,
    stepsToReproduce: form.stepsToReproduce.trim(),
    priority: form.priority,
    ...(form.severity ? { severity: form.severity } : {}),
    ...(form.location.kind === 'parent' ? { parentId: form.location.parentId } : {}),
    capture,
  };
}
