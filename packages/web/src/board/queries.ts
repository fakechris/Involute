import { gql } from '@apollo/client';

export const BOARD_PAGE_QUERY = gql`
  query BoardPage($first: Int!, $after: String, $filter: IssueFilter) {
    teams {
      nodes {
        id
        key
        name
        states {
          nodes {
            id
            name
          }
        }
      }
    }
    users {
      nodes {
        id
        name
        email
      }
    }
    issueLabels {
      nodes {
        id
        name
      }
    }
    issues(first: $first, after: $after, filter: $filter) {
      nodes {
        id
        identifier
        title
        description
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
        labels {
          nodes {
            id
            name
          }
        }
        assignee {
          id
          name
          email
        }
        children {
          nodes {
            id
            identifier
            title
          }
        }
        parent {
          id
          identifier
          title
        }
        comments(first: 100, orderBy: createdAt) {
          nodes {
            id
            body
            createdAt
            user {
              id
              name
              email
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const ISSUE_UPDATE_MUTATION = gql`
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        id
        identifier
        title
        description
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
        labels {
          nodes {
            id
            name
          }
        }
        assignee {
          id
          name
          email
        }
        children {
          nodes {
            id
            identifier
            title
          }
        }
        parent {
          id
          identifier
          title
        }
        comments(first: 100, orderBy: createdAt) {
          nodes {
            id
            body
            createdAt
            user {
              id
              name
              email
            }
          }
        }
      }
    }
  }
`;

export const COMMENT_CREATE_MUTATION = gql`
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment {
        id
        body
        createdAt
        user {
          id
          name
          email
        }
      }
    }
  }
`;

export const ISSUE_DELETE_MUTATION = gql`
  mutation IssueDelete($id: String!) {
    issueDelete(id: $id) {
      success
      issueId
    }
  }
`;

export const COMMENT_DELETE_MUTATION = gql`
  mutation CommentDelete($id: String!) {
    commentDelete(id: $id) {
      success
      commentId
    }
  }
`;

export const ISSUE_PAGE_QUERY = gql`
  query IssuePage($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      createdAt
      updatedAt
      state {
        id
        name
      }
      team {
        id
        key
        name
        states {
          nodes {
            id
            name
          }
        }
      }
      labels {
        nodes {
          id
          name
        }
      }
      assignee {
        id
        name
        email
      }
      children {
        nodes {
          id
          identifier
          title
        }
      }
      parent {
        id
        identifier
        title
      }
      comments(first: 100, orderBy: createdAt) {
        nodes {
          id
          body
          createdAt
          user {
            id
            name
            email
          }
        }
      }
    }
    users {
      nodes {
        id
        name
        email
      }
    }
    issueLabels {
      nodes {
        id
        name
      }
    }
  }
`;

export const ACCESS_PAGE_QUERY = gql`
  query AccessPage {
    viewer {
      id
      name
      email
      globalRole
    }
    teams {
      nodes {
        id
        key
        name
        visibility
        memberships {
          nodes {
            id
            role
            user {
              id
              name
              email
              globalRole
            }
          }
        }
        states {
          nodes {
            id
            name
          }
        }
      }
    }
  }
`;

export const TEAM_UPDATE_ACCESS_MUTATION = gql`
  mutation TeamUpdateAccess($input: TeamUpdateAccessInput!) {
    teamUpdateAccess(input: $input) {
      success
      team {
        id
        key
        name
        visibility
        memberships {
          nodes {
            id
            role
            user {
              id
              name
              email
              globalRole
            }
          }
        }
        states {
          nodes {
            id
            name
          }
        }
      }
    }
  }
`;

export const TEAM_MEMBERSHIP_UPSERT_MUTATION = gql`
  mutation TeamMembershipUpsert($input: TeamMembershipUpsertInput!) {
    teamMembershipUpsert(input: $input) {
      success
      membership {
        id
        role
        user {
          id
          name
          email
          globalRole
        }
      }
    }
  }
`;

export const TEAM_MEMBERSHIP_REMOVE_MUTATION = gql`
  mutation TeamMembershipRemove($input: TeamMembershipRemoveInput!) {
    teamMembershipRemove(input: $input) {
      success
      membershipId
    }
  }
`;

export const ISSUE_CREATE_MUTATION = gql`
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
        title
        description
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
        labels {
          nodes {
            id
            name
          }
        }
        assignee {
          id
          name
          email
        }
        children {
          nodes {
            id
            identifier
            title
          }
        }
        parent {
          id
          identifier
          title
        }
        comments(first: 100, orderBy: createdAt) {
          nodes {
            id
            body
            createdAt
            user {
              id
              name
              email
            }
          }
        }
      }
    }
  }
`;
