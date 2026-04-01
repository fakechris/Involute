/**
 * GraphQL queries for exporting data from Linear.
 * All queries use cursor-based pagination with $first/$after variables.
 */

export const TEAMS_QUERY = `
  query ExportTeams($first: Int!, $after: String) {
    teams(first: $first, after: $after) {
      nodes {
        id
        key
        name
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const WORKFLOW_STATES_QUERY = `
  query ExportWorkflowStates($first: Int!, $after: String) {
    workflowStates(first: $first, after: $after) {
      nodes {
        id
        name
        type
        position
        team {
          id
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const LABELS_QUERY = `
  query ExportLabels($first: Int!, $after: String) {
    issueLabels(first: $first, after: $after) {
      nodes {
        id
        name
        color
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const USERS_QUERY = `
  query ExportUsers($first: Int!, $after: String) {
    users(first: $first, after: $after) {
      nodes {
        id
        name
        email
        displayName
        active
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const ISSUES_QUERY = `
  query ExportIssues($first: Int!, $after: String) {
    issues(first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        description
        priority
        createdAt
        updatedAt
        state {
          id
          name
        }
        team {
          id
          key
        }
        assignee {
          id
          name
          email
        }
        labels {
          nodes {
            id
            name
          }
        }
        parent {
          id
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const COMMENTS_QUERY = `
  query ExportComments($issueId: String!, $first: Int!, $after: String) {
    issue(id: $issueId) {
      comments(first: $first, after: $after) {
        nodes {
          id
          body
          createdAt
          updatedAt
          user {
            id
            name
            email
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;
