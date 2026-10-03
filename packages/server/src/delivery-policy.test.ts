import { describe, expect, it } from 'vitest';
import { parseDeliveryPolicy, executionContract } from './delivery-policy.js';

const contract = { acceptance: 'First outcome\nSecond outcome', scope: 'Approved implementation', constraints: 'Preserve data', repository: 'fakechris/Involute', verification: 'Integration checks' };
const plan = { units: [
  { key: 'a', title: 'Build A', criteria: [0], paths: ['packages/server/'], actions: ['edit', 'test', 'pull_request'], dependsOn: [], checks: [{ workflowId: 42, job: 'server-tests' }] },
  { key: 'b', title: 'Build B', criteria: [1], paths: ['packages/web/'], actions: ['edit', 'test'], dependsOn: ['a'] },
], environments: [] };

describe('delivery authorization boundaries', () => {
  it('derives execution contracts only from approved criteria and scope', () => {
    const policy = parseDeliveryPolicy(plan, contract);
    expect(executionContract(policy, 'b', contract)).toEqual(expect.objectContaining({ acceptance: 'Second outcome', scope: contract.scope, repository: contract.repository, constraints: contract.constraints }));
  });
  it('refuses extra goal or acceptance fields hidden in a unit', () => {
    expect(() => parseDeliveryPolicy({ ...plan, units: [{ ...plan.units[0], acceptance: 'New business goal' }] }, contract)).toThrow(/Unknown/);
  });
  it('rejects cycles, unknown predecessors and non-existing criteria', () => {
    expect(() => parseDeliveryPolicy({ ...plan, units: [{ ...plan.units[0], dependsOn: ['b'] }, plan.units[1]] }, contract)).toThrow(/cycle/);
    expect(() => parseDeliveryPolicy({ ...plan, units: [{ ...plan.units[0], dependsOn: ['missing'] }] }, contract)).toThrow(/predecessor/);
    expect(() => parseDeliveryPolicy({ ...plan, units: [{ ...plan.units[0], criteria: [2] }] }, contract)).toThrow(/criteria/);
  });
  it('rejects path escape and deployment without named environments', () => {
    for (const path of ['../outside', '/etc', 'packages/../../etc', '.', '*', 'packages\\server']) {
      expect(() => parseDeliveryPolicy({ ...plan, units: [{ ...plan.units[0], paths: [path] }] }, contract)).toThrow(/path/);
    }
    expect(() => parseDeliveryPolicy({ ...plan, units: [{ ...plan.units[0], actions: ['deploy'] }] }, contract)).toThrow(/environment/);
  });
  it('does not grant merge or deploy when omitted, and refuses unknown actions', () => {
    const policy = parseDeliveryPolicy(plan, contract);
    expect(policy.units[0]?.actions).not.toContain('merge');
    expect(policy.units[0]?.actions).not.toContain('deploy');
    expect(() => parseDeliveryPolicy({ ...plan, units: [{ ...plan.units[0], actions: ['admin'] }] }, contract)).toThrow(/action/);
  });
});
