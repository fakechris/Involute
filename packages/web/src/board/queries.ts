import { gql } from '@apollo/client';

export const BOARD_PAGE_QUERY = gql`
  query BoardPage($query: String, $first: Int!, $after: String, $filter: IssueFilter, $teamFilter: TeamFilter) {
    projectSummary(teamFilter: $teamFilter) {
      totalCount
      noRepositoryCount
      projects {
        repository
        name
        identifier
        totalCount
      }
    }
    teams {
      nodes {
        id
        key
        name
        viewerCanWrite
        viewerCanManage
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
              actorKind
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
        actorKind
        globalRole
      }
    }
    issueLabels {
      nodes {
        id
        name
      }
    }
    issues(first: $first, after: $after, filter: $filter, query: $query) {
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
          executionId
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
        bugSla {
          status
          remainingMs
          dueAt
          budgetHours
        }
        openBlockers {
          id
          identifier
          title
        }
        provenance {
          actorKind
          surface
          source
          actor {
            id
            name
            email
            handle
            actorKind
            runtime
            presence
            presenceDetail
            lastSeenAt
          }
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
              handle
              actorKind
              runtime
              presence
              presenceDetail
              lastSeenAt
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
      message
      issue {
        id
        identifier
        revision
        title
        description
        priority
        kind
        repository
        commitmentStatus
        outcome
        scope
        constraints
        acceptance
        verification
        claim {
          id
          leaseUntil
          executionId
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
        provenance {
          actorKind
          surface
          source
          actor {
            id
            name
            email
            handle
            actorKind
            runtime
            presence
            presenceDetail
            lastSeenAt
          }
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
              handle
              actorKind
              runtime
              presence
              presenceDetail
              lastSeenAt
            }
          }
        }
      }
    }
  }
`;

/** A person completes a request addressed to them (INV-596). */
export const AGENT_REQUEST_ANSWER_MUTATION = gql`
  mutation AgentRequestAnswer($input: AgentRequestAnswerInput!) {
    agentRequestAnswer(input: $input) {
      success
      message
      request { id state answeredCommentId }
      comment { id }
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

/**
 * The contract of the one issue open in the board drawer (INV-896). The board list does not
 * carry contracts — a hundred cards do not need them, and a pending amendment per card would be
 * a query per card — so the drawer asks for the open issue's own.
 */
export const ISSUE_CONTRACT_QUERY = gql`
  query IssueContract($id: String!) {
    issue(id: $id) {
      id
      revision
      commitmentStatus
      outcome
      scope
      constraints
      acceptance
      verification
      pendingContractAmendment {
        id
        reason
        stale
        proposedByClaimant
        createdAt
        proposedBy {
          id
          name
          email
        }
        changes {
          field
          before
          after
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
      revision
      title
      description
      priority
      kind
      repository
      claim {
        id
        leaseUntil
          executionId
        actor {
          id
          name
          email
          actorKind
        }
      }
      commitmentStatus
      outcome
      scope
      constraints
      acceptance
      verification
      pendingContractAmendment {
        id
        reason
        stale
        proposedByClaimant
        createdAt
        proposedBy {
          id
          name
          email
        }
        changes {
          field
          before
          after
        }
      }
      bugSla {
        status
        remainingMs
        dueAt
        budgetHours
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
      attachments {
        id
        filename
        mimeType
        size
        url
        createdAt
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
      provenance {
        actorKind
        surface
        source
        actor {
          id
          name
          email
          handle
          actorKind
          runtime
          presence
          presenceDetail
          lastSeenAt
        }
      }
      agentRequests(first: 200) {
        id
        state
        presence
        presenceDetail
        deadlineAt
        hopCount
        rootRequestId
        handedOffFromId
        failureReason
        answeredCommentId
        targetActor {
          id
          name
          handle
          actorKind
        }
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
            handle
            actorKind
            runtime
            presence
            presenceDetail
            lastSeenAt
          }
        }
      }
    }
    users {
      nodes {
        id
        name
        email
        actorKind
        globalRole
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
      message
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
      message
      membershipId
    }
  }
`;

export const ISSUE_CREATE_MUTATION = gql`
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      message
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
        provenance {
          actorKind
          surface
          source
          actor {
            id
            name
            email
            handle
            actorKind
            runtime
            presence
            presenceDetail
            lastSeenAt
          }
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
              handle
              actorKind
              runtime
              presence
              presenceDetail
              lastSeenAt
            }
          }
        }
      }
    }
  }
`;

export const BUG_REPORT_MUTATION = gql`
  mutation BugReport($input: BugReportInput!) {
    bugReport(input: $input) {
      success
      message
      issue {
        id
        identifier
        title
        priority
        repository
        commitmentStatus
      }
    }
  }
`;

// Open bugs with similar titles, shown while reporting one (INV-749).
export const SIMILAR_BUGS_QUERY = gql`
  query SimilarBugs($teamId: String!, $title: String!) {
    similarBugs(teamId: $teamId, title: $title, first: 5) {
      id
      identifier
      title
      state {
        id
        name
      }
    }
  }
`;

export const BUGS_PAGE_QUERY = gql`
  query BugsPage($teamFilter: TeamFilter, $issueFilter: IssueFilter) {
    bugSummary(teamFilter: $teamFilter) {
      openCount
      closedCount
      byPriority {
        priority
        count
      }
      byRepository {
        repository
        openCount
        closedCount
      }
      byTypeLabel {
        label
        count
      }
      unclaimedOpenCount
      oldestOpenAgeDays
      avgOpenAgeDays
      createdPerWeek {
        weekStart
        count
      }
      metrics {
        triageHoursP50
        triageHoursP90
        triagedCount
        untriagedCount
        slaMetCount
        slaBreachedClosedCount
        slaMetRate
        atRiskOpenCount
        breachedOpen {
          id
          identifier
          title
          overdueHours
        }
        bySource {
          source
          count
        }
        unplacedOpenCount
      }
    }
    issues(first: 100, filter: $issueFilter) {
      nodes {
        id
        identifier
        title
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
      }
      pageInfo {
        endCursor
        hasNextPage
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
        alias
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
      message
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
      message
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




/** Mentionable agent actors, for `@` completion and the directory (INV-573). */
export const AGENTS_QUERY = gql`
  query Agents($teamKey: String, $includeDeactivated: Boolean) {
    agents(teamKey: $teamKey, includeDeactivated: $includeDeactivated) {
      id
      name
      email
      handle
      actorKind
      runtime
      description
      presence
      presenceDetail
      lastSeenAt
      description
      agentCardUrl
      deactivatedAt
      credentialCounts {
        active
        revoked
      }
      owner {
        id
        name
        handle
      }
    }
  }
`;

/** One agent: who it is, and what it has done (INV-573). */
export const AGENT_PROFILE_QUERY = gql`
  query AgentProfile($handle: String!) {
    agentProfile(handle: $handle) {
      actor {
        id
        name
        email
        handle
        actorKind
        runtime
        description
        agentCardUrl
        presence
        presenceDetail
        lastSeenAt
        deactivatedAt
        owner {
          id
          name
          handle
        }
        successorActor {
          id
          name
          handle
        }
      }
      viewerCanManage
      counts {
        proposedWork
        openRequests
        answeredRequests
        runs
        evidence
      }
      credentials {
        id
        name
        scopes
        teamKey
        createdAt
        expiresAt
        revokedAt
        issuedBy { id name handle }
      }
      receipts {
        auditId
        surface
        work { id identifier title }
        receipt {
          id
          reasoning
          runtime
          sessionId
          contractRevision
          createdAt
          actor { id name handle actorKind }
          evidence { kind ref version digest excerpt preserved }
          inputs { kind ref version digest excerpt preserved }
        }
      }
      timeline {
        at
        kind
        detail
        workIdentifier
      }
    }
  }
`;

/** Humans who can be made accountable for an actor (INV-605). */
export const AGENT_OWNER_CANDIDATES_QUERY = gql`
  query AgentOwnerCandidates {
    viewer {
      id
    }
    users {
      nodes {
        id
        name
        email
        actorKind
        deactivatedAt
      }
    }
  }
`;

export const ACTOR_DEACTIVATE_MUTATION = gql`
  mutation ActorDeactivate($id: String!, $reason: String) {
    actorDeactivate(id: $id, reason: $reason) {
      success
      actor { id deactivatedAt }
    }
  }
`;

export const ACTOR_REACTIVATE_MUTATION = gql`
  mutation ActorReactivate($id: String!, $reason: String) {
    actorReactivate(id: $id, reason: $reason) {
      success
      actor { id deactivatedAt }
    }
  }
`;

export const ACTOR_TRANSFER_OWNER_MUTATION = gql`
  mutation ActorTransferOwner($id: String!, $ownerId: String!, $reason: String) {
    actorTransferOwner(id: $id, ownerId: $ownerId, reason: $reason) {
      success
      actor { id owner { id name handle } }
    }
  }
`;

export const AGENT_CREDENTIAL_REVOKE_MUTATION = gql`
  mutation AgentCredentialRevoke($id: String!) {
    agentCredentialRevoke(id: $id) {
      success
    }
  }
`;

// Typed links for the issue panel's Relations section (INV-679). Kept out of
// the board query so opening the board does not load every card's links.
export const ISSUE_RELATIONS_QUERY = gql`
  query IssueRelations($id: String!) {
    issue(id: $id) {
      id
      links {
        nodes {
          id
          type
          from {
            id
            identifier
            title
            commitmentStatus
            state {
              id
              name
              type
            }
          }
          to {
            id
            identifier
            title
            commitmentStatus
            state {
              id
              name
              type
            }
          }
        }
      }
    }
  }
`;

// Weekly bug triage rotation for the active team (INV-750).
export const TEAM_TRIAGE_QUERY = gql`
  query TeamTriage($teamKey: String!) {
    teams(filter: { key: { eq: $teamKey } }) {
      nodes {
        id
        key
        name
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
        triageRotation {
          startsAt
          users {
            id
            name
            email
          }
        }
        currentTriager {
          id
          name
          email
        }
      }
    }
  }
`;

export const TEAM_TRIAGE_ROTATION_MUTATION = gql`
  mutation TeamTriageRotationUpdate($input: TeamTriageRotationInput!) {
    teamTriageRotationUpdate(input: $input) {
      success
      message
    }
  }
`;

// A person ends an agent's claim now, with a reason (INV-789).
export const WORK_CLAIM_RELEASE_MUTATION = gql`
  mutation WorkClaimRelease($workId: String!, $reason: String!) {
    workClaimRelease(workId: $workId, reason: $reason) {
      success
      message
    }
  }
`;

// The requester answers a request that asked back (INV-794).
export const AGENT_REQUEST_REPLY_MUTATION = gql`
  mutation AgentRequestReply($requestId: String!, $body: String!, $overrideReason: String) {
    agentRequestReply(requestId: $requestId, body: $body, overrideReason: $overrideReason) {
      success
      message
      request { id state }
    }
  }
`;

// Who takes over when an actor stops answering (INV-794).
export const ACTOR_SET_SUCCESSOR_MUTATION = gql`
  mutation ActorSetSuccessor($id: String!, $successorId: String, $reason: String) {
    actorSetSuccessor(id: $id, successorId: $successorId, reason: $reason) {
      success
      message
      actor { id successorActor { id name handle } }
    }
  }
`;

/** Who a PROJECT node is shared with (INV-833). `shares` is empty unless the viewer may manage the team. */
export const PROJECT_SHARES_QUERY = gql`
  query ProjectShares($id: String!) {
    issue(id: $id) {
      id
      viewerCanShare
      shares {
        id
        role
        createdAt
        user { id name email handle actorKind }
      }
    }
    users {
      nodes { id name email handle actorKind deactivatedAt }
    }
  }
`;

export const WORK_SHARE_UPSERT_MUTATION = gql`
  mutation WorkShareUpsert($workId: String!, $userId: String!, $role: WorkShareRole!) {
    workShareUpsert(workId: $workId, userId: $userId, role: $role) {
      success
      message
      share { id role }
    }
  }
`;

export const WORK_SHARE_REMOVE_MUTATION = gql`
  mutation WorkShareRemove($workId: String!, $userId: String!) {
    workShareRemove(workId: $workId, userId: $userId) {
      success
      message
    }
  }
`;

// --- Administration (INV-849, docs/permissions.md §7) ---

export const ADMIN_MEMBERS_QUERY = gql`
  query AdminMembers {
    users {
      nodes {
        id
        name
        email
        actorKind
        globalRole
        accessStatus
        lastSeenAt
        invitedAt
        teamMemberships { role team { id key name } }
      }
    }
    teams(includeArchived: false) { nodes { id key name } }
    viewer { id }
  }
`;

export const USER_INVITE_MUTATION = gql`
  mutation UserInvite($input: UserInviteInput!) {
    userInvite(input: $input) { success message emailSent emailNote signInUrl user { id email accessStatus } }
  }
`;

export const USER_INVITE_REVOKE_MUTATION = gql`
  mutation UserInviteRevoke($id: String!) {
    userInviteRevoke(id: $id) { success message }
  }
`;

export const USER_SUSPEND_MUTATION = gql`
  mutation UserSuspend($id: String!, $reason: String) {
    userSuspend(id: $id, reason: $reason) { success message }
  }
`;

export const USER_REACTIVATE_MUTATION = gql`
  mutation UserReactivate($id: String!, $reason: String) {
    userReactivate(id: $id, reason: $reason) { success message }
  }
`;

export const ADMIN_TEAMS_QUERY = gql`
  query AdminTeams {
    teams(includeArchived: true) {
      nodes {
        id
        key
        name
        visibility
        archivedAt
        memberships { nodes { role user { id name email } } }
      }
    }
  }
`;

export const TEAM_CREATE_MUTATION = gql`
  mutation TeamCreate($input: TeamCreateInput!) {
    teamCreate(input: $input) { success message team { id key } }
  }
`;

export const TEAM_ARCHIVE_MUTATION = gql`
  mutation TeamArchive($teamId: String!) {
    teamArchive(teamId: $teamId) { success message }
  }
`;

export const TEAM_UNARCHIVE_MUTATION = gql`
  mutation TeamUnarchive($teamId: String!) {
    teamUnarchive(teamId: $teamId) { success message }
  }
`;

export const WORKSPACE_SECURITY_QUERY = gql`
  query WorkspaceSecurity {
    workspaceSettings {
      approvedDomains
      defaultTeams { id }
      membersCanInvite
      membersCanCreateTeams
    }
    teams(includeArchived: false) { nodes { id key name } }
  }
`;

export const WORKSPACE_SETTINGS_UPDATE_MUTATION = gql`
  mutation WorkspaceSettingsUpdate($input: WorkspaceSettingsUpdateInput!) {
    workspaceSettingsUpdate(input: $input) { success message }
  }
`;

// --- Team pages (INV-850) ---

export const TEAM_PAGE_QUERY = gql`
  query TeamPage($key: String!) {
    teams(filter: { key: { eq: $key } }, includeArchived: true) {
      nodes {
        id
        key
        name
        visibility
        archivedAt
        viewerCanManage
        viewerCanJoin
        viewerIsMember
        memberships {
          nodes {
            id
            role
            user { id name email globalRole accessStatus }
          }
        }
      }
    }
    viewer { id }
  }
`;

export const TEAM_UPDATE_MUTATION = gql`
  mutation TeamUpdate($input: TeamUpdateInput!) {
    teamUpdate(input: $input) { success message }
  }
`;

export const TEAM_JOIN_MUTATION = gql`
  mutation TeamJoin($teamId: String!) {
    teamJoin(teamId: $teamId) { success message }
  }
`;

export const TEAM_LEAVE_MUTATION = gql`
  mutation TeamLeave($teamId: String!) {
    teamLeave(teamId: $teamId) { success message }
  }
`;

/** The sidebar's team list, straight from the server (INV-853) rather than from the last board visit. */
export const SHELL_TEAMS_QUERY = gql`
  query ShellTeams {
    teams {
      nodes { id key name issueCount viewerCanManage viewerCanWrite }
    }
  }
`;

// An agent's proposed change to a committed contract, decided by a person (INV-869).
export const CONTRACT_AMENDMENT_ACCEPT_MUTATION = gql`
  mutation ContractAmendmentAccept($input: ContractAmendmentAcceptInput!) {
    contractAmendmentAccept(input: $input) {
      success
      message
    }
  }
`;

export const CONTRACT_AMENDMENT_REJECT_MUTATION = gql`
  mutation ContractAmendmentReject($input: ContractAmendmentRejectInput!) {
    contractAmendmentReject(input: $input) {
      success
      message
    }
  }
`;
