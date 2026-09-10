import { gql } from '@apollo/client';

export const BOARD_PAGE_QUERY = gql`
  query BoardPage($first: Int!, $after: String, $filter: IssueFilter) {
    teams {
      nodes {
        id
        key
        name
        issueCount
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
            type
            position
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
        revision
        title
        description
        priority
        kind
        repository
        claim {
          id
          leaseUntil
          actor {
            id
            name
            email
            actorKind
          }
        }
        createdAt
        updatedAt
        state {
          id
          name
          type
          position
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
        revision
        title
        description
        priority
        kind
        repository
        claim {
          id
          leaseUntil
          actor {
            id
            name
            email
            actorKind
          }
        }
        createdAt
        updatedAt
        state {
          id
          name
          type
          position
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
            kind
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
        }
        parent {
          id
          identifier
          title
          kind
        }
        projectId
        cycleId
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
      revision
      title
      description
      priority
      kind
      createdAt
      updatedAt
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
        states {
          nodes {
            id
            name
            type
            position
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
          kind
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
      }
      parent {
        id
        identifier
        revision
        title
        kind
      }
      projectId
      cycleId
      project { id name color }
      cycle { id name number }
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
        issueCount
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
            type
            position
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
            type
            position
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
        priority
        repository
        createdAt
        updatedAt
        state {
          id
          name
          type
          position
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
        projectId
        cycleId
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

export const PROJECT_ISSUES_QUERY = gql`
  query ProjectIssues($teamKey: String, $query: String) {
    issues(
      first: 100
      filter: { kind: PROJECT, team: { key: { eq: $teamKey } } }
      query: $query
    ) {
      nodes {
        id
        identifier
        title
        description
        priority
        kind
        repository
        createdAt
        updatedAt
        state {
          id
          name
          type
          position
        }
        assignee {
          id
          name
          email
        }
        team {
          id
          key
          name
        }
        children {
          nodes {
            id
            identifier
            title
            kind
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
        }
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
        from {
          id
          identifier
        }
        to {
          id
          identifier
        }
      }
    }
  }
`;

export const WORK_LINK_DELETE_MUTATION = gql`
  mutation WorkLinkDelete($id: String!) {
    workLinkDelete(id: $id) {
      success
      id
    }
  }
`;

export const PROJECTS_QUERY = gql`
  query Projects($teamId: String!) {
    projects(teamId: $teamId) {
      nodes {
        id
        name
        description
        color
        status
        targetDate
        lead {
          id
          name
          email
        }
        issues {
          nodes {
            id
            identifier
            title
          }
        }
        createdAt
        updatedAt
      }
    }
  }
`;

export const PROJECT_CREATE_MUTATION = gql`
  mutation ProjectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      success
      project {
        id
        name
        description
        color
        status
        targetDate
        lead { id name email }
        issues { nodes { id identifier title } }
        createdAt
        updatedAt
      }
    }
  }
`;

export const PROJECT_UPDATE_MUTATION = gql`
  mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) {
      success
      project {
        id
        name
        description
        color
        status
        targetDate
        lead { id name email }
        issues { nodes { id identifier title } }
        createdAt
        updatedAt
      }
    }
  }
`;

export const PROJECT_DELETE_MUTATION = gql`
  mutation ProjectDelete($id: String!) {
    projectDelete(id: $id) {
      success
      projectId
    }
  }
`;

export const CYCLES_QUERY = gql`
  query Cycles($teamId: String!) {
    cycles(teamId: $teamId) {
      nodes {
        id
        name
        number
        startsAt
        endsAt
        issues {
          nodes {
            id
            identifier
            title
            state { id name type position }
          }
        }
        createdAt
        updatedAt
      }
    }
  }
`;

export const CYCLE_CREATE_MUTATION = gql`
  mutation CycleCreate($input: CycleCreateInput!) {
    cycleCreate(input: $input) {
      success
      cycle {
        id
        name
        number
        startsAt
        endsAt
        issues { nodes { id identifier title state { id name type position } } }
        createdAt
        updatedAt
      }
    }
  }
`;

export const CYCLE_UPDATE_MUTATION = gql`
  mutation CycleUpdate($id: String!, $input: CycleUpdateInput!) {
    cycleUpdate(id: $id, input: $input) {
      success
      cycle {
        id
        name
        number
        startsAt
        endsAt
        issues { nodes { id identifier title state { id name type position } } }
        createdAt
        updatedAt
      }
    }
  }
`;

export const CYCLE_DELETE_MUTATION = gql`
  mutation CycleDelete($id: String!) {
    cycleDelete(id: $id) {
      success
      cycleId
    }
  }
`;

export const USER_UPDATE_MUTATION = gql`
  mutation UserUpdate($input: UserUpdateInput!) {
    userUpdate(input: $input) {
      success
      user { id name email }
    }
  }
`;

export const FILE_UPLOAD_MUTATION = gql`
  mutation FileUpload($input: FileUploadInput!) {
    fileUpload(input: $input) {
      success
      attachment {
        id
        filename
        url
        mimeType
        size
      }
    }
  }
`;

export const MILESTONE_ISSUES_QUERY = gql`
  query MilestoneIssues($teamKey: String, $query: String) {
    issues(
      first: 100
      filter: {
        and: [
          { kind: MILESTONE }
          { team: { key: { eq: $teamKey } } }
        ]
      }
      query: $query
    ) {
      nodes {
        id
        identifier
        title
        description
        outcome
        scope
        acceptance
        priority
        kind
        createdAt
        updatedAt
        state {
          id
          name
          type
          position
        }
        assignee {
          id
          name
          email
          avatarUrl
        }
        team {
          id
          key
          name
        }
        children {
          nodes {
            id
            identifier
            title
            kind
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
        }
      }
    }
  }
`;

export const NOTIFICATIONS_PAGE_QUERY = gql`
  query NotificationsPage($first: Int, $unreadOnly: Boolean) {
    notifications(first: $first, unreadOnly: $unreadOnly) {
      nodes {
        id
        type
        payload
        readAt
        createdAt
        work {
          id
          identifier
          title
          kind
          state {
            id
            name
            type
          }
        }
      }
    }
    unreadNotificationCount
  }
`;

export const NOTIFICATION_MARK_READ_MUTATION = gql`
  mutation NotificationMarkRead($id: String!) {
    notificationMarkRead(id: $id) {
      success
      notification {
        id
        readAt
      }
    }
  }
`;

export const NOTIFICATIONS_MARK_ALL_READ_MUTATION = gql`
  mutation NotificationsMarkAllRead {
    notificationsMarkAllRead {
      count
      success
    }
  }
`;

export const UNREAD_NOTIFICATION_COUNT_QUERY = gql`
  query UnreadNotificationCount {
    unreadNotificationCount
  }
`;


