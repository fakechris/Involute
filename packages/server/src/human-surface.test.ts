import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  HUMAN_GATE_PATTERN,
  HUMAN_GATES,
  MUTATION_SURFACES,
  NOTIFICATION_SURFACES,
  type HumanSurface,
} from './human-surface.ts';
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
function checkWebEntry(mutation: string, entry: Extract<HumanSurface, { kind: 'web' }>, files: Map<string, string>): string[] {
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
  'agent.request_answered',
  'agent.request_replied',
  // The agent learns the decision from work_get_context; people decided it themselves.
  'contract.amendment_accepted',
  'contract.amendment_rejected',
]);

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

  describe('fails when an entry point disappears', () => {
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

    it('reports a new inbox notification type', () => {
      const withNewType = new Map(server);
      withNewType.set('widget.ts', "await tx.notification.createMany({ data: [{ type: 'widget.frobnicated' }] });");
      expect(producedNotificationTypes(withNewType).has('widget.frobnicated')).toBe(true);
      expect(Object.keys(NOTIFICATION_SURFACES)).not.toContain('widget.frobnicated');
    });
  });
});
