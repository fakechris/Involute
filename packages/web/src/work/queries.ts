import { gql } from '@apollo/client';

export const CANDIDATES_PAGE_QUERY = gql`
  query CandidatesPage($first: Int!, $filter: IssueFilter) {
    teams {
      nodes {
        id
        key
        name
      }
    }
    users {
      nodes {
        id
        name
        email
        actorKind
      }
    }
    issues(first: $first, filter: $filter) {
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

export const WORK_GRAPH_PAGE_QUERY = gql`
  query WorkGraphPage($first: Int!, $filter: IssueFilter) {
    issues(first: $first, filter: $filter) {
      nodes {
        id
        identifier
        title
        commitmentStatus
        state {
          name
        }
        links {
          nodes {
            id
            type
            from {
              id
              identifier
              title
              commitmentStatus
            }
            to {
              id
              identifier
              title
              commitmentStatus
            }
          }
        }
      }
    }
  }
`;

export const WORK_CONTEXT_PAGE_QUERY = gql`
  query WorkContextPage($id: String!) {
    workContext(id: $id) {
      work {
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
        status
        phase
        summary
        externalUrl
        startedAt
        endedAt
      }
      evidence {
        id
        kind
        url
        summary
        createdAt
      }
      audits {
        id
        revision
        actorKind
        surface
        reason
        createdAt
        actor {
          id
          name
          email
        }
      }
    }
  }
`;

export const WORK_COMMIT_MUTATION = gql`
  mutation WorkCommit($id: String!, $input: WorkCommitInput!) {
    workCommit(id: $id, input: $input) {
      success
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
