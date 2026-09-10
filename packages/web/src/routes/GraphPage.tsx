import { useQuery } from '@apollo/client/react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { readStoredTeamKey } from '../board/utils';
import { IcoGraph } from '../components/Icons';
import { ProjectFilterCombobox, type AvailableProject } from '../components/ProjectFilterCombobox';
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
    for (const link of node.links.nodes) {
      if (link.type !== type) {
        continue;
      }

      edges.set(link.id, { id: link.id, from: link.from, to: link.to });
    }
  }

  return Array.from(edges.values()).sort((left, right) =>
    left.from.identifier.localeCompare(right.from.identifier),
  );
}

interface ContainsTreeNode {
  node: GraphWorkNode;
  children: ContainsTreeNode[];
}

function buildContainsForest(nodes: GraphWorkNode[], contains: GraphEdge[]): ContainsTreeNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, string[]>();
  const childIds = new Set<string>();

  for (const edge of contains) {
    if (!byId.has(edge.from.id) || !byId.has(edge.to.id)) {
      continue;
    }
    childIds.add(edge.to.id);
    const current = childrenByParent.get(edge.from.id) ?? [];
    current.push(edge.to.id);
    childrenByParent.set(edge.from.id, current);
  }

  function build(node: GraphWorkNode, path: Set<string>): ContainsTreeNode {
    const nextPath = new Set(path).add(node.id);
    const children = (childrenByParent.get(node.id) ?? [])
      .filter((childId) => !nextPath.has(childId))
      .map((childId) => byId.get(childId))
      .filter((child): child is GraphWorkNode => Boolean(child))
      .sort((left, right) => left.identifier.localeCompare(right.identifier))
      .map((child) => build(child, nextPath));
    return { node, children };
  }

  return nodes
    .filter(
      (node) =>
        !childIds.has(node.id) &&
        (childrenByParent.get(node.id)?.length ?? 0) > 0,
    )
    .sort((left, right) => left.identifier.localeCompare(right.identifier))
    .map((node) => build(node, new Set()));
}

function WorkLinkButton({ work }: { work: Pick<WorkRef, 'id' | 'identifier' | 'title'> }) {
  const navigate = useNavigate();
  return (
    <button type="button" className="observation-card__id" onClick={() => navigate(`/work/${work.id}`)}>
      {work.identifier}
    </button>
  );
}

function ContainsTreeItem({ item }: { item: ContainsTreeNode }) {
  return (
    <li>
      <div className="work-graph__node">
        <WorkLinkButton work={item.node} />
        <span>{item.node.title}</span>
      </div>
      {item.children.length > 0 ? (
        <ul>
          {item.children.map((child) => <ContainsTreeItem key={child.node.id} item={child} />)}
        </ul>
      ) : null}
    </li>
  );
}

export function GraphPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedProjectKey = searchParams.get('project');
  const teamKey = readStoredTeamKey();
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState(false);
  const { data, error, fetchMore, loading, refetch } = useQuery<WorkGraphPageQueryData, WorkGraphPageQueryVariables>(WORK_GRAPH_PAGE_QUERY, {
    variables: {
      first: 100,
      ...(teamKey ? { filter: { team: { key: { eq: teamKey } } } } : {}),
    },
  });
  const nodes = data?.issues.nodes ?? [];
  const contains = useMemo(() => uniqueEdges(nodes, 'CONTAINS'), [nodes]);
  const blocks = useMemo(() => uniqueEdges(nodes, 'BLOCKS'), [nodes]);
  const forest = useMemo(() => buildContainsForest(nodes, contains), [contains, nodes]);
  const pageInfo = data?.issues.pageInfo;

  const availableProjects = useMemo<AvailableProject[]>(() => {
    const map = new Map<string, AvailableProject>();

    for (const issue of nodes) {
      if (issue.kind === 'PROJECT') {
        const name = issue.repository || issue.title;
        map.set(name, {
          id: issue.id,
          identifier: issue.identifier,
          name,
          key: issue.identifier,
          issueCount: 0,
        });
      }
    }

    for (const issue of nodes) {
      if (issue.repository && !map.has(issue.repository)) {
        map.set(issue.repository, {
          id: issue.id,
          identifier: issue.identifier,
          name: issue.repository,
          key: issue.repository,
          issueCount: 0,
        });
      }
    }

    const projects = Array.from(map.values());
    for (const p of projects) {
      const target = p.name.toLowerCase();
      const targetId = p.id.toLowerCase();
      const targetIdent = p.identifier.toLowerCase();

      let count = 0;
      for (const issue of nodes) {
        const directMatch =
          issue.id.toLowerCase() === targetId ||
          issue.identifier.toLowerCase() === targetIdent ||
          (issue.repository && issue.repository.toLowerCase() === target) ||
          (issue.title && issue.title.toLowerCase() === target);

        if (directMatch) {
          count++;
        }
      }
      p.issueCount = count;
    }

    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }, [nodes]);

  const { scopedNodes, scopedContains, scopedBlocks, scopedForest } = useMemo(() => {
    if (!selectedProjectKey) {
      return {
        scopedNodes: nodes,
        scopedContains: contains,
        scopedBlocks: blocks,
        scopedForest: forest,
      };
    }

    const target = selectedProjectKey.toLowerCase();
    const projectNodeIds = new Set<string>();

    for (const node of nodes) {
      const isMatch =
        node.id.toLowerCase() === target ||
        node.identifier.toLowerCase() === target ||
        (node.repository && node.repository.toLowerCase() === target) ||
        (node.title && node.title.toLowerCase() === target);
      if (isMatch) {
        projectNodeIds.add(node.id);
      }
    }

    // Downward propagation along CONTAINS
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of contains) {
        if (projectNodeIds.has(edge.from.id) && !projectNodeIds.has(edge.to.id)) {
          projectNodeIds.add(edge.to.id);
          changed = true;
        }
      }
    }

    // Upward propagation along CONTAINS
    changed = true;
    while (changed) {
      changed = false;
      for (const edge of contains) {
        if (projectNodeIds.has(edge.to.id) && !projectNodeIds.has(edge.from.id)) {
          projectNodeIds.add(edge.from.id);
          changed = true;
        }
      }
    }

    const filteredNodes = nodes.filter((n) => projectNodeIds.has(n.id));
    const filteredContains = contains.filter(
      (e) => projectNodeIds.has(e.from.id) && projectNodeIds.has(e.to.id),
    );
    const filteredBlocks = blocks.filter(
      (e) => projectNodeIds.has(e.from.id) || projectNodeIds.has(e.to.id),
    );
    const filteredForest = buildContainsForest(filteredNodes, filteredContains);

    return {
      scopedNodes: filteredNodes,
      scopedContains: filteredContains,
      scopedBlocks: filteredBlocks,
      scopedForest: filteredForest,
    };
  }, [blocks, contains, forest, nodes, selectedProjectKey]);

  function handleSelectProject(projectKey: string | null) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (projectKey) {
          next.set('project', projectKey);
        } else {
          next.delete('project');
        }
        return next;
      },
      { replace: false },
    );
  }

  async function handleLoadMore() {
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return;
    setLoadingMore(true);
    setPaginationError(false);
    try {
      await fetchMore({
        variables: { after: pageInfo.endCursor },
        updateQuery: (previous, { fetchMoreResult }) => ({
          issues: {
            ...fetchMoreResult.issues,
            nodes: [...previous.issues.nodes, ...fetchMoreResult.issues.nodes],
          },
        }),
      });
    } catch {
      setPaginationError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="observation-page">
      <div className="page-header" style={{ gap: 12, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}>
          <IcoGraph />
        </span>
        <h1 className="page-header__title">Graph</h1>
        <span className="mono observation-count">{scopedContains.length + scopedBlocks.length}</span>

        {availableProjects.length > 0 && (
          <ProjectFilterCombobox
            projects={availableProjects}
            selectedProjectKey={selectedProjectKey}
            totalCount={nodes.length}
            onSelectProject={handleSelectProject}
            showQuickPills={true}
          />
        )}

        <div style={{ flex: 1 }} />
        <span className="observation-hint">Contains and blocks only. Candidates stay off the board.</span>
      </div>
      <div className="page-content observation-content">
        {error ? (
          <div className="empty-state" role="alert">
            <h3>Could not load graph</h3>
            <p>The graph request failed. No empty-state inference was made.</p>
            <button type="button" onClick={() => void refetch()}>Retry</button>
          </div>
        ) : loading && nodes.length === 0 ? (
          <p className="observation-empty">Loading graph…</p>
        ) : scopedContains.length === 0 && scopedBlocks.length === 0 ? (
          <div className="empty-state">
            <h3>{selectedProjectKey ? `No links for ${selectedProjectKey}` : 'No contains or blocks links'}</h3>
            <p>
              {selectedProjectKey
                ? 'No contains or blocks links found for this project in the current team scope.'
                : 'Typed work links show up here as the kernel graph, not as a second board.'}
            </p>
            {selectedProjectKey && (
              <button type="button" onClick={() => handleSelectProject(null)}>
                Show All Projects
              </button>
            )}
          </div>
        ) : (
          <div className="work-graph">
            <section className="work-graph__column" aria-label="Contains">
              <h2>Contains</h2>
              {scopedForest.length === 0 ? (
                <p className="observation-empty">No contains tree.</p>
              ) : (
                <ul className="work-graph__tree">
                  {scopedForest.map((item) => <ContainsTreeItem key={item.node.id} item={item} />)}
                </ul>
              )}
            </section>
            <section className="work-graph__column" aria-label="Blocks">
              <h2>Blocks</h2>
              {scopedBlocks.length === 0 ? (
                <p className="observation-empty">No blocking edges.</p>
              ) : (
                <ul className="work-graph__edges">
                  {scopedBlocks.map((edge) => (
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
              <h2>Nodes ({scopedNodes.length})</h2>
              <ul className="work-graph__nodes">
                {scopedNodes.map((node) => (
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
            {pageInfo?.hasNextPage ? (
              <section className="work-graph__column" aria-label="Pagination">
                <h2>More nodes</h2>
                <p className="observation-empty">Load the remaining page before treating this graph as complete.</p>
                {paginationError ? (
                  <div role="alert">
                    <p>Could not load more graph nodes.</p>
                    <button type="button" disabled={loadingMore} onClick={() => void handleLoadMore()}>
                      Retry loading more
                    </button>
                  </div>
                ) : (
                  <button type="button" disabled={loadingMore} onClick={() => void handleLoadMore()}>
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </button>
                )}
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
