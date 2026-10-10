import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ATTENTION_KINDS, ATTENTION_LOADERS } from './attention-service.ts';
import {
  HUMAN_GATE_PATTERN,
  HUMAN_GATES,
  MUTATION_SURFACES,
  NOTIFICATION_SURFACES,
  type HumanGate,
  type HumanSurface,
  type NotificationSurface,
} from './human-surface.ts';
import { ACTIONABLE_NOTIFICATION_KINDS } from './notification-service.ts';
import { createGraphQLSchema } from './schema.ts';

// INV-795: every thing a person may or must do has a place in the web app.

const serverSrc = dirname(fileURLToPath(import.meta.url));
const webSrc = join(serverSrc, '../../web/src');

function sourceFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'test' && name !== '__fixtures__' && name !== 'node_modules') walk(path);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
        files.set(relative(root, path), readFileSync(path, 'utf8'));
      }
    }
  };
  walk(root);
  return files;
}

const web = sourceFiles(webSrc);
const server = sourceFiles(serverSrc);

/** The web test files, by path under packages/web/src (INV-1004). */
function testFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules') walk(path);
      } else if (/\.test\.tsx?$/.test(name)) files.set(relative(root, path), readFileSync(path, 'utf8'));
    }
  };
  walk(root);
  return files;
}
const webTests = testFiles(webSrc);

function gqlDocuments(files: Map<string, string>): Array<{ name: string; file: string; body: string }> {
  const docs: Array<{ name: string; file: string; body: string }> = [];
  for (const [file, source] of files) {
    for (const match of source.matchAll(/export const (\w+) = gql`([\s\S]*?)`;/g)) {
      docs.push({ name: match[1]!, file, body: match[2]! });
    }
  }
  return docs;
}

const callsMutation = (text: string, mutation: string) => new RegExp(`\\b${mutation}\\s*[({]`).test(text);

/** Why a `web` entry no longer holds; empty when it does. */
function checkWebEntry(mutation: string, entry: Extract<HumanSurface, { kind: 'web' }>, files: Map<string, string>, tests: Map<string, string> = webTests): string[] {
  const problems: string[] = [];
  if (entry.doc) {
    const doc = gqlDocuments(files).find((candidate) => candidate.name === entry.doc);
    if (!doc) problems.push(`${mutation}: document ${entry.doc} is not exported anywhere in web/src`);
    else if (!callsMutation(doc.body, mutation)) problems.push(`${mutation}: ${entry.doc} does not run ${mutation}`);
  }
  for (const component of entry.components) {
    const source = files.get(component);
    if (source === undefined) {
      problems.push(`${mutation}: component ${component} does not exist`);
      continue;
    }
    const uses = entry.doc ? new RegExp(`\\b${entry.doc}\\b`).test(source) : callsMutation(source, mutation);
    if (!uses) problems.push(`${mutation}: ${component} no longer uses ${entry.doc ?? mutation}`);
  }
  if (entry.label) {
    const where = entry.labelFile ? [entry.labelFile] : entry.components;
    if (!where.some((file) => files.get(file)?.includes(entry.label!))) {
      problems.push(`${mutation}: label "${entry.label}" is not in ${where.join(', ')}`);
    }
  }
  // A web entry is exercised by a test, or an open item will write one (INV-1004).
  const test = (entry as { test?: string | { tracking: string } }).test;
  if (!test) problems.push(`${mutation}: no web test named (test: 'path.test.tsx' or { tracking: 'INV-…' })`);
  else if (typeof test === 'object') {
    if (!/^INV-\d+$/.test(test.tracking)) problems.push(`${mutation}: test gap must track an INV item`);
  } else {
    const source = tests.get(test);
    if (source === undefined) problems.push(`${mutation}: test ${test} does not exist`);
    else {
      const names = [entry.label, entry.doc, ...entry.components.map((component) => component.replace(/^.*\//, '').replace(/\.tsx?$/, ''))].filter((name): name is string => Boolean(name));
      if (!names.some((name) => source.includes(name))) problems.push(`${mutation}: test ${test} mentions neither the label, the document nor a component`);
    }
  }
  return problems;
}

/** String literals in a TypeScript source (quotes and template text, not nested). */
function stringLiterals(source: string): string[] {
  return [...source.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
}

/** Server text telling someone a person must act that no gate covers. */
function uncoveredGateTexts(files: Map<string, string>, gates: typeof HUMAN_GATES): string[] {
  const uncovered: string[] = [];
  for (const [file, source] of files) {
    if (file === 'human-surface.ts') continue;
    // Long literals (protocol docs, the SDL) are checked line by line.
    for (const line of stringLiterals(source).flatMap((literal) => literal.split('\n'))) {
      if (HUMAN_GATE_PATTERN.test(line) && !gates.some((gate) => line.includes(gate.text))) {
        uncovered.push(`${file}: ${line.trim().slice(0, 160)}`);
      }
    }
  }
  return uncovered;
}

/** Inbox notification types written by the server, from the files that write notifications. */
function producedNotificationTypes(files: Map<string, string>): Set<string> {
  const types = new Set<string>();
  for (const [file, source] of files) {
    if (!/notification\.createMany\(|notification\.create\(|projectWorkNotifications\(/.test(source)) continue;
    for (const match of source.matchAll(/'([a-z_]+\.[a-z_.]+)'/g)) {
      // ops-alerts.ts writes `ops.${kind}` for each OpsAlertKind.
      types.add(file === 'ops-alerts.ts' ? `ops.${match[1]}` : match[1]!);
    }
  }
  return types;
}

/** Dotted literals in notification producers that are outbox events, not inbox notifications. */
const NOT_INBOX = new Set([
  'work.review_submitted',
  // Outbox event written next to a run.completed notification (INV-997).
  'artifact.attached',
  'agent.request_answered',
  'agent.request_replied',
  // The agent learns the decision from work_get_context; people decided it themselves.
  'contract.amendment_accepted',
  'contract.amendment_rejected',
  // A needinfo was withdrawn (INV-1119): its notification is resolved, nobody new is told.
  'needinfo.withdrawn',
]);

/** Gates that do not say whether they wait in Needs you (INV-1095). */
function gateAttentionProblems(gates: readonly HumanGate[]): string[] {
  return gates.flatMap((gate) => {
    const attention = (gate as { attention?: unknown }).attention;
    if (typeof attention === 'string') {
      return (ATTENTION_KINDS as readonly string[]).includes(attention) ? [] : [`${gate.text}: unknown attention kind ${attention}`];
    }
    if (attention && typeof attention === 'object' && typeof (attention as { none?: unknown }).none === 'string') {
      return /INV-\d+/.test((attention as { none: string }).none) ? [] : [`${gate.text}: attention exemption must cite an INV item`];
    }
    return [`${gate.text}: no attention declared (an AttentionKind or { none: 'reason (INV-…)' })`];
  });
}

/**
 * Notifications whose `actionable` is missing or disagrees with
 * ACTIONABLE_NOTIFICATION_KINDS, the list notification-service resolves from (INV-1095).
 */
function notificationActionableProblems(
  surfaces: Record<string, NotificationSurface>,
  actionable: Record<string, string> = ACTIONABLE_NOTIFICATION_KINDS,
): string[] {
  const problems: string[] = [];
  for (const [type, surface] of Object.entries(surfaces)) {
    const declared = (surface as { actionable?: unknown }).actionable;
    const expected = Object.hasOwn(actionable, type) ? actionable[type] : 'info';
    if (declared === undefined) problems.push(`${type}: no actionable declared (an AttentionKind or 'info')`);
    else if (declared !== expected) problems.push(`${type}: actionable ${String(declared)} here, ${expected} in ACTIONABLE_NOTIFICATION_KINDS`);
  }
  for (const type of Object.keys(actionable)) {
    if (!(type in surfaces)) problems.push(`${type}: in ACTIONABLE_NOTIFICATION_KINDS but not in NOTIFICATION_SURFACES`);
  }
  return problems;
}

/** Attention kinds that a non-test server source resolves with resolveAttentionNotifications({ kind }). */
function resolvedAttentionKinds(files: Map<string, string>): Set<string> {
  const kinds = new Set<string>();
  for (const source of files.values()) {
    for (const match of source.matchAll(/resolveAttentionNotifications\(\s*[\w.]+\s*,\s*\{[^}]*?\bkind:\s*'(\w+)'/g)) kinds.add(match[1]!);
  }
  return kinds;
}

const attentionTest = readFileSync(join(serverSrc, 'attention-service.test.ts'), 'utf8');

describe('human surface registry (INV-795)', () => {
  const mutations = Object.keys(createGraphQLSchema(null as never).getMutationType()!.getFields()).sort();

  it('lists every GraphQL mutation, and nothing else', () => {
    expect(mutations.filter((name) => !(name in MUTATION_SURFACES))).toEqual([]);
    expect(Object.keys(MUTATION_SURFACES).filter((name) => !mutations.includes(name))).toEqual([]);
  });

  it('gives every mutation payload a message, so a refusal can say why', () => {
    const schema = createGraphQLSchema(null as never);
    const withoutMessage = Object.entries(schema.getMutationType()!.getFields())
      .map(([name, field]) => {
        let type = field.type as { ofType?: unknown; name?: string; getFields?: () => Record<string, unknown> };
        while (type.ofType) type = type.ofType as typeof type;
        return { name, type };
      })
      .filter(({ type }) => typeof type.getFields === 'function' && !('message' in type.getFields!()))
      .map(({ name, type }) => `${name}: ${type.name}`);
    expect(withoutMessage).toEqual([]);
  });

  it('finds each web entry point where the registry says it is', () => {
    const problems = Object.entries(MUTATION_SURFACES).flatMap(([mutation, entry]) =>
      entry.kind === 'web' ? checkWebEntry(mutation, entry, web) : [],
    );
    expect(problems).toEqual([]);
  });

  it('keeps gaps honest: a gap that now has a web entry must be moved to web', () => {
    const closed = Object.entries(MUTATION_SURFACES)
      .filter(([, entry]) => entry.kind === 'gap')
      .filter(([mutation]) => gqlDocuments(web).some((doc) => callsMutation(doc.body, mutation))
        || [...web.values()].some((source) => /useMutation/.test(source) && callsMutation(source, mutation)))
      .map(([mutation]) => mutation);
    expect(closed).toEqual([]);
  });

  it('maps every "a person must do this" message to where a person does it', () => {
    expect(uncoveredGateTexts(server, HUMAN_GATES)).toEqual([]);
    const serverText = [...server.entries()].filter(([file]) => file !== 'human-surface.ts').map(([, source]) => source).join('\n');
    expect(HUMAN_GATES.filter((gate) => !serverText.includes(gate.text)).map((gate) => gate.text)).toEqual([]);
    for (const gate of HUMAN_GATES) {
      if ('mutation' in gate) {
        const entry = MUTATION_SURFACES[gate.mutation];
        expect(entry, gate.text).toBeDefined();
        expect(entry!.kind, `${gate.text} → ${gate.mutation} is api-only`).not.toBe('api-only');
      }
    }
  });

  it('says where every inbox notification lands', () => {
    const produced = [...producedNotificationTypes(server)].filter((type) => !NOT_INBOX.has(type)).sort();
    expect(produced).toEqual(Object.keys(NOTIFICATION_SURFACES).sort());
    const workPage = web.get('routes/WorkContextPage.tsx') ?? '';
    for (const [type, landing] of Object.entries(NOTIFICATION_SURFACES)) {
      if (landing.kind !== 'work') continue;
      if (landing.component) {
        const name = landing.component.replace(/^.*\//, '').replace(/\.tsx$/, '');
        expect(workPage.includes(`<${name}`), `${type}: work page renders ${name}`).toBe(true);
      }
      const source = landing.component ? (web.get(landing.component) ?? '') : workPage;
      expect(source.includes(landing.action), `${type}: "${landing.action}"`).toBe(true);
    }
  });

  it('says for every human gate whether it waits in Needs you (INV-1095)', () => {
    expect(gateAttentionProblems(HUMAN_GATES)).toEqual([]);
  });

  it('says for every notification whether it asks for a decision, agreeing with notification-service (INV-1095)', () => {
    expect(notificationActionableProblems(NOTIFICATION_SURFACES)).toEqual([]);
  });

  it('gives every attention kind a loader and a test that sees it appear and go (INV-1095)', () => {
    expect(ATTENTION_KINDS.filter((kind) => typeof (ATTENTION_LOADERS as Record<string, unknown>)[kind] !== 'function')).toEqual([]);
    // attention-service.test.ts holds one "appears → decided → gone" case per kind.
    expect(ATTENTION_KINDS.filter((kind) => !attentionTest.includes(`'${kind}'`))).toEqual([]);
  });

  it('resolves every actionable notification kind from some decision (INV-1095)', () => {
    const resolved = resolvedAttentionKinds(server);
    const used = [...new Set(Object.values(ACTIONABLE_NOTIFICATION_KINDS))].sort();
    expect(used.filter((kind) => !resolved.has(kind))).toEqual([]);
  });

  describe('fails when an entry point disappears', () => {
    it('reports a web entry with no test, a test that does not exist, and one that never touches the entry point', () => {
    const entry = MUTATION_SURFACES.workClaimRelease as Extract<HumanSurface, { kind: 'web' }>;
    const { test: _test, ...bare } = entry;
    expect(checkWebEntry('workClaimRelease', bare as typeof entry, web)).toEqual([
      "workClaimRelease: no web test named (test: 'path.test.tsx' or { tracking: 'INV-…' })",
    ]);
    expect(checkWebEntry('workClaimRelease', { ...entry, test: 'components/Nope.test.tsx' }, web)).toEqual([
      'workClaimRelease: test components/Nope.test.tsx does not exist',
    ]);
    const unrelated = new Map(webTests);
    unrelated.set('components/Unrelated.test.tsx', "it('renders', () => {});");
    expect(checkWebEntry('workClaimRelease', { ...entry, test: 'components/Unrelated.test.tsx' }, web, unrelated)).toEqual([
      'workClaimRelease: test components/Unrelated.test.tsx mentions neither the label, the document nor a component',
    ]);
    expect(checkWebEntry('workClaimRelease', { ...entry, test: { tracking: 'later' } }, web)).toEqual(['workClaimRelease: test gap must track an INV item']);
  });

  it('reports a removed component, a component that stopped using the document, and a missing label', () => {
      const entry = MUTATION_SURFACES.workClaimRelease as Extract<HumanSurface, { kind: 'web' }>;
      const without = new Map(web);
      without.delete(entry.components[0]!);
      expect(checkWebEntry('workClaimRelease', entry, without)).toEqual([
        'workClaimRelease: component components/ClaimControl.tsx does not exist',
        'workClaimRelease: label "Why release this claim" is not in components/ClaimControl.tsx',
      ]);

      const unused = new Map(web);
      unused.set(entry.components[0]!, 'export function ClaimControl() { return null; }');
      expect(checkWebEntry('workClaimRelease', entry, unused)).toContain(
        'workClaimRelease: components/ClaimControl.tsx no longer uses WORK_CLAIM_RELEASE_MUTATION',
      );
    });

    it('reports a new human-only rule that has no gate', () => {
      const withNewRule = new Map(server);
      withNewRule.set('frobnicate.ts', "export const M = 'Only a person may frobnicate the widget.';");
      expect(uncoveredGateTexts(withNewRule, HUMAN_GATES)).toEqual(['frobnicate.ts: Only a person may frobnicate the widget.']);
    });

    it('reports a gate or a notification that does not say whether it waits in Needs you (INV-1095)', () => {
      const bare = { text: 'Only a person may frobnicate', mutation: 'workCommit' } as unknown as HumanGate;
      expect(gateAttentionProblems([bare])).toEqual([
        "Only a person may frobnicate: no attention declared (an AttentionKind or { none: 'reason (INV-…)' })",
      ]);
      expect(gateAttentionProblems([{ ...bare, attention: { none: 'later' } }])).toEqual(['Only a person may frobnicate: attention exemption must cite an INV item']);

      const withNew = { ...NOTIFICATION_SURFACES, 'widget.frobnicated': { kind: 'info' } as NotificationSurface };
      expect(notificationActionableProblems(withNew)).toEqual(["widget.frobnicated: no actionable declared (an AttentionKind or 'info')"]);
      expect(notificationActionableProblems({ ...NOTIFICATION_SURFACES, 'run.completed': { ...NOTIFICATION_SURFACES['run.completed']!, actionable: 'info' } })).toEqual([
        'run.completed: actionable info here, WORK_REVIEW in ACTIONABLE_NOTIFICATION_KINDS',
      ]);
      expect(notificationActionableProblems(NOTIFICATION_SURFACES, { ...ACTIONABLE_NOTIFICATION_KINDS, 'widget.frobnicated': 'OPS' })).toEqual([
        'widget.frobnicated: in ACTIONABLE_NOTIFICATION_KINDS but not in NOTIFICATION_SURFACES',
      ]);
    });

    it('reports an attention kind nobody resolves (INV-1095)', () => {
      const without = new Map([...server].map(([file, source]) => [file, source.replace(/kind: 'OPS'/g, "kind: 'NOPE'")]));
      expect(resolvedAttentionKinds(without).has('OPS')).toBe(false);
      expect(resolvedAttentionKinds(server).has('OPS')).toBe(true);
    });

    it('reports a new inbox notification type', () => {
      const withNewType = new Map(server);
      withNewType.set('widget.ts', "await tx.notification.createMany({ data: [{ type: 'widget.frobnicated' }] });");
      expect(producedNotificationTypes(withNewType).has('widget.frobnicated')).toBe(true);
      expect(Object.keys(NOTIFICATION_SURFACES)).not.toContain('widget.frobnicated');
    });
  });
});
