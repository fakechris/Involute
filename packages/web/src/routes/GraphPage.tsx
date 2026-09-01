import { useQuery } from '@apollo/client/react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { readStoredTeamKey } from '../board/utils';
import { IcoGraph } from '../components/Icons';
import { WORK_GRAPH_PAGE_QUERY } from '../work/queries';
import type {
  GraphWorkNode,
  WorkGraphPageQueryData,
  WorkGraphPageQueryVariables,
  WorkRef,
} from '../work/types';

interface GraphEdge {
  id: string;
  from: WorkRef;
  to: WorkRef;
}

function uniqueEdges(nodes: GraphWorkNode[], type: 'CONTAINS' | 'BLOCKS'): GraphEdge[] {
  const edges = new Map<string, GraphEdge>();

  for (const node of nodes) {
    if (node.commitmentStatus === 'REJECTED') {
      continue;
    }

    for (const link of node.links.nodes) {
      if (link.type !== type) {
        continue;
      }

      if (link.from.commitmentStatus === 'REJECTED' || link.to.commitmentStatus === 'REJECTED') {
        continue;
      }

      edges.set(link.id, { id: link.id, from: link.from, to: link.to });
    }
  }

  return Array.from(edges.values()).sort((left, right) =>
    left.from.identifier.localeCompare(right.from.identifier),
  );
}

function buildContainsForest(nodes: GraphWorkNode[], contains: GraphEdge[]): Array<{
  node: GraphWorkNode;
  children: GraphWorkNode[];
}> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, GraphWorkNode[]>();
  const childIds = new Set<string>();

  for (const edge of contains) {
    const child = byId.get(edge.to.id);
    if (!child) {
      continue;
    }
    childIds.add(child.id);
    const current = childrenByParent.get(edge.from.id) ?? [];
    current.push(child);
    childrenByParent.set(edge.from.id, current);
  }

  return nodes
    .filter(
      (node) =>
        node.commitmentStatus !== 'REJECTED' &&
        !childIds.has(node.id) &&
        (childrenByParent.get(node.id)?.length ?? 0) > 0,
    )
    .map((node) => ({
      node,
      children: (childrenByParent.get(node.id) ?? []).sort((left, right) =>
        left.identifier.localeCompare(right.identifier),
      ),
    }));
}

function WorkLinkButton({ work }: { work: Pick<WorkRef, 'id' | 'identifier' | 'title'> }) {
  const navigate = useNavigate();
  return (
    <button type="button" className="observation-card__id" onClick={() => navigate(`/work/${work.id}`)}>
      {work.identifier}
    </button>
  );
}

export function GraphPage() {
  const navigate = useNavigate();
  const teamKey = readStoredTeamKey();
  const { data, loading } = useQuery<WorkGraphPageQueryData, WorkGraphPageQueryVariables>(WORK_GRAPH_PAGE_QUERY, {
    variables: {
      first: 200,
      ...(teamKey ? { filter: { team: { key: { eq: teamKey } } } } : {}),
    },
  });
  const nodes = data?.issues.nodes ?? [];
  const contains = useMemo(() => uniqueEdges(nodes, 'CONTAINS'), [nodes]);
  const blocks = useMemo(() => uniqueEdges(nodes, 'BLOCKS'), [nodes]);
  const forest = useMemo(() => buildContainsForest(nodes, contains), [contains, nodes]);

  return (
    <div className="observation-page">
      <div className="page-header">
        <span style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}>
          <IcoGraph />
        </span>
        <h1 className="page-header__title">Graph</h1>
        <span className="mono observation-count">{contains.length + blocks.length}</span>
        <div style={{ flex: 1 }} />
        <span className="observation-hint">Contains and blocks only. Candidates stay off the board.</span>
      </div>
      <div className="page-content observation-content">
        {loading && nodes.length === 0 ? (
          <p className="observation-empty">Loading graph…</p>
        ) : contains.length === 0 && blocks.length === 0 ? (
          <div className="empty-state">
            <h3>No contains or blocks links</h3>
            <p>Typed work links show up here as the kernel graph, not as a second board.</p>
          </div>
        ) : (
          <div className="work-graph">
            <section className="work-graph__column" aria-label="Contains">
              <h2>Contains</h2>
              {forest.length === 0 ? (
                <p className="observation-empty">No contains tree.</p>
              ) : (
                <ul className="work-graph__tree">
                  {forest.map(({ node, children }) => (
                    <li key={node.id}>
                      <div className="work-graph__node">
                        <WorkLinkButton work={node} />
                        <span>{node.title}</span>
                      </div>
                      {children.length > 0 ? (
                        <ul>
                          {children.map((child) => (
                            <li key={child.id} className="work-graph__node">
                              <WorkLinkButton work={child} />
                              <span>{child.title}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="work-graph__column" aria-label="Blocks">
              <h2>Blocks</h2>
              {blocks.length === 0 ? (
                <p className="observation-empty">No blocking edges.</p>
              ) : (
                <ul className="work-graph__edges">
                  {blocks.map((edge) => (
                    <li key={edge.id}>
                      <WorkLinkButton work={edge.from} />
                      <span className="work-graph__verb">blocks</span>
                      <WorkLinkButton work={edge.to} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="work-graph__column" aria-label="All work">
              <h2>Nodes</h2>
              <ul className="work-graph__nodes">
                {nodes
                  .filter((node) => node.commitmentStatus !== 'REJECTED')
                  .map((node) => (
                    <li key={node.id}>
                      <button type="button" onClick={() => navigate(`/work/${node.id}`)}>
                        <span className="mono">{node.identifier}</span>
                        <span>{node.title}</span>
                        <span className="observation-card__status">{node.commitmentStatus.toLowerCase()}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
