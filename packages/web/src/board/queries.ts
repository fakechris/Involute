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
    issues(first: $first) {
      nodes {
        id
        identifier
        title
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
      }
    }
  }
`;
