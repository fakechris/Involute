import { gql } from '@apollo/client';

export const CANDIDATES_PAGE_QUERY = gql`
  query CandidatesPage($first: Int!, $after: String, $filter: IssueFilter, $teamFilter: TeamFilter) {
    candidateSummary(teamFilter: $teamFilter) {
      totalCount
      noRepositoryCount
      projects {
        repository
        totalCount
      }
    }
    teams(filter: $teamFilter) {
      nodes {
        id
        key
        name
        issueCount
        memberships {
          nodes {
            id
            user {
              id
              name
              email
              actorKind
            }
          }
        }
      }
    }
    issues(first: $first, after: $after, filter: $filter) {
      nodes {
        id
        identifier
        title
        description
        commitmentStatus
        kind
        revision
        outcome
        scope
        constraints
        acceptance
        verification
        repository
        snoozedUntil
        source
        createdAt
        parent {
          id
          identifier
          title
          kind
        }
        dependencyHints
        team {
          id
          key
        }
        assignee {
          id
          name
          email
          actorKind
        }
        state {
          id
          name
          type
          position
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const IN_REVIEW_PAGE_QUERY = gql`
  query InReviewPage($first: Int!, $after: String, $filter: IssueFilter, $query: String) {
    issues(first: $first, after: $after, filter: $filter, query: $query) {
      nodes {
        id
        identifier
        title
        description
        commitmentStatus
        kind
        revision
        outcome
        scope
        constraints
        acceptance
        verification
        repository
        createdAt
        team {
          id
          key
        }
        assignee {
          id
          name
          email
          actorKind
        }
        state {
          id
          name
          type
          position
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// The /graph page (INV-681): pick a project, then read its whole work graph
// in one request resolved server-side, instead of paging issues and
// filtering them in the browser.
export const GRAPH_PROJECTS_QUERY = gql`
  query GraphProjects($teamFilter: TeamFilter) {
    projectSummary(teamFilter: $teamFilter) {
      totalCount
      projects {
        repository
        name
        identifier
        totalCount
      }
    }
  }
`;

export const PROJECT_WORK_GRAPH_QUERY = gql`
  query ProjectWorkGraph($project: String!, $includeCandidates: Boolean) {
    workGraph(project: $project, includeCandidates: $includeCandidates) {
      repository
      truncated
      root {
        id
        identifier
        title
      }
      nodes {
        id
        identifier
        title
        kind
        commitmentStatus
        state {
          id
          name
          type
        }
        assignee {
          id
          name
        }
      }
      externalNodes {
        id
        identifier
        title
        kind
        commitmentStatus
        state {
          id
          name
          type
        }
        assignee {
          id
          name
        }
      }
      edges {
        id
        type
        fromId
        toId
      }
    }
  }
`;

export const WORK_CONTEXT_PAGE_QUERY = gql`
  query WorkContextPage($id: String!) {
    workContext(id: $id) {
      work {
        agentRequests(first: 200) {
          id
          state
          presence
          deadlineAt
          hopCount
          rootRequestId
          handedOffFromId
          failureReason
          answeredCommentId
          targetActor { id name handle actorKind }
        }
        id
        identifier
        title
        description
        kind
        commitmentStatus
        revision
        outcome
        scope
        constraints
        acceptance
        verification
        repository
        state {
          id
          name
          type
          position
        }
        team {
          id
          key
          name
        }
        assignee {
          id
          name
          email
        }
      }
      ancestors {
        id
        identifier
        title
      }
      blockedBy {
        id
        identifier
        title
      }
      blocks {
        id
        identifier
        title
      }
      claim {
        leaseUntil
        createdAt
        actor {
          id
          name
          email
        }
      }
      runs {
        id
        publicId
        actorId
        claimId
        baseRevision
        status
        phase
        summary
        externalUrl
        startedAt
        endedAt
      }
      evidence {
        id
        actorId
        runId
        kind
        url
        summary
        createdAt
        retractedAt
        retractReason
        retractedBy { id name handle }
        supersededByWork { id identifier }
      }
      reviewDecisions {
        id
        decision
        reason
        fromRevision
        toRevision
        createdAt
        reviewer { id name email }
        run { id publicId status startedAt endedAt }
      }
      audits {
        id
        revision
        actorKind
        surface
        reason
        sessionId
        claimGeneration
        createdAt
        actor {
          id
          name
          email
          handle
          actorKind
        }
        receipt {
          id
          reasoning
          runtime
          sessionId
          contractRevision
          createdAt
          actor { id name handle }
          evidence { kind ref version digest excerpt preserved }
          inputs { kind ref version digest excerpt preserved }
        }
      }
    }
  }
`;

export const WORK_COMMIT_MUTATION = gql`
  mutation WorkCommit($id: String!, $input: WorkCommitInput!) {
    workCommit(id: $id, input: $input) {
      success
      message
      issue {
        id
        identifier
        commitmentStatus
      }
    }
  }
`;

export const WORK_REJECT_MUTATION = gql`
  mutation WorkReject($id: String!, $input: WorkRejectInput!) {
    workReject(id: $id, input: $input) {
      success
      issue {
        id
        identifier
        commitmentStatus
      }
    }
  }
`;

export const WORK_REVIEW_MUTATION = gql`
  mutation WorkReview($id: String!, $input: WorkReviewInput!) {
    workReview(id: $id, input: $input) {
      success
      issue {
        id
        identifier
        revision
      }
      decision {
        id
        decision
      }
    }
  }
`;

export const WORK_LINK_MUTATION = gql`
  mutation WorkLink($fromId: String!, $toId: String!, $type: WorkLinkType!) {
    workLink(fromId: $fromId, toId: $toId, type: $type) {
      success
      link {
        id
        type
      }
    }
  }
`;

export const ISSUE_SNOOZE_MUTATION = gql`
  mutation IssueSnooze($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        id
        snoozedUntil
      }
    }
  }
`;

// Timeline data for the /graph Timeline view (INV-682); fetched only when that
// view is open, since it reads every item's audit trail.
export const PROJECT_WORK_TIMELINE_QUERY = gql`
  query ProjectWorkTimeline($project: String!, $includeCandidates: Boolean) {
    workGraph(project: $project, includeCandidates: $includeCandidates) {
      timeline {
        workId
        committedAt
        startedAt
        reviewAt
        completedAt
        canceledAt
        history
        transitions {
          at
          stateName
          stateType
        }
      }
      cycles {
        id
        name
        number
        startsAt
        endsAt
      }
    }
  }
`;

// Where a candidate can be placed before commit (INV-719): committed containers
// in the candidate's repository, fetched per kind so a large project's issues
// cannot crowd them out of one page.
export const PLACEMENT_OPTIONS_QUERY = gql`
  query PlacementOptions($repository: String!) {
    projects: issues(first: 20, filter: { repository: { eq: $repository }, kind: PROJECT, commitmentStatus: COMMITTED }) {
      nodes {
        id
        identifier
        title
        kind
      }
    }
    milestones: issues(first: 200, filter: { repository: { eq: $repository }, kind: MILESTONE, commitmentStatus: COMMITTED }) {
      nodes {
        id
        identifier
        title
        kind
      }
    }
    epics: issues(first: 200, filter: { repository: { eq: $repository }, kind: EPIC, commitmentStatus: COMMITTED }) {
      nodes {
        id
        identifier
        title
        kind
      }
    }
  }
`;
