import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DocumentNode, FragmentDefinitionNode } from 'graphql';
import { describe, expect, it } from 'vitest';

import { createGraphQLSchema } from './schema.ts';

// The schema is built by @graphql-tools, which Node loads with graphql's CommonJS build; validating it with the
// ESM build vitest would import fails the cross-realm check, so use the same copy.
const { Kind, NoUnusedFragmentsRule, parse, specifiedRules, validate, visit } = createRequire(import.meta.url)('graphql') as typeof import('graphql');

// INV-1937: a web query asking for a field the server does not have fails validation as a whole, so the
// page renders its empty state ("No milestones configured") instead of the data. Mocked page tests cannot
// see that; every document the web app sends is validated against the server schema here.

const webSrc = join(dirname(fileURLToPath(import.meta.url)), '../../web/src');

function webSourceFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules') walk(path);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
        files.set(relative(root, path), readFileSync(path, 'utf8'));
      }
    }
  };
  walk(root);
  return files;
}

interface WebDocument {
  file: string;
  document: DocumentNode;
}

/**
 * Every gql`...` template in web/src. A `${NAME}` naming a template constant (a shared selection such as
 * BOARD_ISSUE_SELECTION, or a fragment document) is replaced by its text; fragments are deduplicated later.
 */
function webDocuments(): WebDocument[] {
  const files = webSourceFiles(webSrc);
  const constants = new Map<string, string>();
  for (const source of files.values()) {
    for (const match of source.matchAll(/\bconst (\w+) = (?:gql)?`([\s\S]*?)`;/g)) constants.set(match[1]!, match[2]!);
  }
  const expand = (text: string, depth = 0): string =>
    text.replace(/\$\{(\w+)\}/g, (_whole, name: string) => (depth < 5 ? expand(constants.get(name) ?? '', depth + 1) : ''));
  const documents: WebDocument[] = [];
  for (const [file, source] of files) {
    for (const match of source.matchAll(/\bgql`([\s\S]*?)`/g)) {
      documents.push({ file, document: parse(expand(match[1]!)) });
    }
  }
  return documents;
}

function fragmentSpreads(node: DocumentNode | FragmentDefinitionNode): string[] {
  const names: string[] = [];
  visit(node, { FragmentSpread: (spread) => void names.push(spread.name.value) });
  return names;
}

/** The operation's document plus every fragment it reaches that another template defines. */
function withFragments(document: DocumentNode, fragments: Map<string, FragmentDefinitionNode>): DocumentNode {
  const defined = new Set(
    document.definitions.flatMap((definition) => (definition.kind === Kind.FRAGMENT_DEFINITION ? [definition.name.value] : [])),
  );
  const added: FragmentDefinitionNode[] = [];
  const pending = fragmentSpreads(document);
  while (pending.length) {
    const name = pending.pop()!;
    if (defined.has(name)) continue;
    const fragment = fragments.get(name);
    if (!fragment) continue;
    defined.add(name);
    added.push(fragment);
    pending.push(...fragmentSpreads(fragment));
  }
  const seen = new Set<string>();
  const own = document.definitions.filter((definition) => {
    if (definition.kind !== Kind.FRAGMENT_DEFINITION) return true;
    if (seen.has(definition.name.value)) return false;
    seen.add(definition.name.value);
    return true;
  });
  return { ...document, definitions: [...own, ...added] };
}

describe('web GraphQL documents (INV-1937)', () => {
  const schema = createGraphQLSchema(null as never);
  const documents = webDocuments();
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const { document } of documents) {
    for (const definition of document.definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
    }
  }
  // A fragment-only template is validated where an operation spreads it.
  const rules = specifiedRules.filter((rule) => rule !== NoUnusedFragmentsRule);

  it('finds the web documents', () => {
    expect(documents.length).toBeGreaterThan(100);
    expect(documents.some(({ document }) => document.definitions.some((d) => d.kind === Kind.OPERATION_DEFINITION && d.name?.value === 'MilestoneIssues'))).toBe(true);
  });

  it('every web query and mutation validates against the server schema', () => {
    const problems = documents.flatMap(({ file, document }) => {
      if (!document.definitions.some((definition) => definition.kind === Kind.OPERATION_DEFINITION)) return [];
      const names = document.definitions.flatMap((definition) =>
        definition.kind === Kind.OPERATION_DEFINITION ? [definition.name?.value ?? '(anonymous)'] : [],
      );
      return validate(schema, withFragments(document, fragments), rules).map((error) => `${file} ${names.join(',')}: ${error.message}`);
    });
    expect(problems).toEqual([]);
  });
});
