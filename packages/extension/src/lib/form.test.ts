import { describe, expect, it } from 'vitest';

import { buildBugReportInput, defaultSteps, validateForm, type BugForm } from './form';

const valid: BugForm = {
  teamId: 'team-1', title: 'Save does nothing', stepsToReproduce: '1. Open\n2. Click Save', description: '  ',
  priority: 2, severity: null, location: { kind: 'parent', parentId: 'INV-1' },
};

describe('defaultSteps', () => {
  it('prefills the page and the picked element, redacted', () => {
    expect(defaultSteps('https://app.example.com/x?token=abc', null)).toBe('1. Open https://app.example.com/x?token=%5Bredacted%5D\n2. ');
    const steps = defaultSteps('https://app.example.com/', { selector: '#save', text: 'Save for jane@example.com', box: { x: 0, y: 0, width: 1, height: 1 }, styles: {} });
    expect(steps).toBe('1. Open https://app.example.com/\n2. Click #save (“Save for [email]”)\n3. ');
  });
});

describe('validateForm', () => {
  it('accepts a complete form', () => {
    expect(validateForm(valid)).toEqual({});
    expect(validateForm({ ...valid, location: { kind: 'triage' } })).toEqual({});
  });

  it('requires a team, title, steps, a priority 1–4 and a location choice', () => {
    expect(Object.keys(validateForm({ ...valid, teamId: null, title: ' ', stepsToReproduce: '', priority: null, location: { kind: 'none' } })).sort())
      .toEqual(['location', 'priority', 'stepsToReproduce', 'teamId', 'title']);
    expect(validateForm({ ...valid, priority: 5 }).priority).toBeTruthy();
    expect(validateForm({ ...valid, priority: 0 }).priority).toBeTruthy();
  });
});

describe('buildBugReportInput', () => {
  it('omits parentId for triage and severity when not judged', () => {
    const input = buildBugReportInput({ ...valid, location: { kind: 'triage' } }, {});
    expect(input).toEqual({ teamId: 'team-1', title: 'Save does nothing', description: null, stepsToReproduce: '1. Open\n2. Click Save', priority: 2, capture: {} });
    expect(buildBugReportInput({ ...valid, severity: 'SEV2' }, {})).toMatchObject({ parentId: 'INV-1', severity: 'SEV2' });
  });
});
