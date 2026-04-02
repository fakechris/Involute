import { gql } from '@apollo/client';

export const BOARD_PAGE_QUERY = gql`
  query BoardPage($first: Int!) {
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
    issues(first: $first) {
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
