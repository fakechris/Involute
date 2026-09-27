/**
 * Where a person does each thing the server lets or asks a person to do
 * (INV-795). Work kept landing with a server rule that said "ask a human" and
 * no screen where a human could: committed contracts (INV-786), claim release,
 * evidence retraction, alias editing. `human-surface.test.ts` holds this table
 * against the code:
 *
 * - every GraphQL mutation has an entry;
 * - a `web` entry's document and component still exist and still use it, and
 *   its label is still on screen;
 * - every server message that tells someone a person must act maps to an
 *   entry;
 * - every notification a person receives says where it lands.
 *
 * Adding a human-only rule, a mutation or a notification without a place for a
 * person to act fails the test. Paths are relative to packages/web/src.
 */

export type HumanSurface =
  | {
      kind: 'web';
      /** Exported gql document holding the mutation; omit when the component declares it inline. */
      doc?: string;
      /** Components that run the mutation (import the doc, or declare it inline). */
      components: string[];
      /** Visible text or accessible name of the control, found in `labelFile` or one of `components`. */
      label?: string;
      labelFile?: string;
    }
  /** Deliberately not a person's action; the reason says who does it instead. */
  | { kind: 'api-only'; reason: string }
  /** A known missing entry point, tracked by an open work item. */
  | { kind: 'gap'; tracking: string; note: string };

export const MUTATION_SURFACES: Record<string, HumanSurface> = {
  actorDeactivate: { kind: 'web', doc: 'ACTOR_DEACTIVATE_MUTATION', components: ['components/AgentLifecycleActions.tsx'], label: 'Deactivate' },
  actorReactivate: { kind: 'web', doc: 'ACTOR_REACTIVATE_MUTATION', components: ['components/AgentLifecycleActions.tsx'], label: 'Reactivate' },
  actorTransferOwner: { kind: 'web', doc: 'ACTOR_TRANSFER_OWNER_MUTATION', components: ['components/AgentLifecycleActions.tsx'], label: 'Transfer owner' },
  agentCredentialCreate: { kind: 'web', components: ['routes/AgentsTab.tsx'] },
  agentCredentialRevoke: { kind: 'web', doc: 'AGENT_CREDENTIAL_REVOKE_MUTATION', components: ['routes/AgentsPage.tsx'], label: 'Revoke' },
  agentRequestAnswer: {
    kind: 'web',
    doc: 'AGENT_REQUEST_ANSWER_MUTATION',
    components: ['routes/IssuePage.tsx', 'components/AgentRequestActions.tsx'],
    label: 'Answer',
  },
  agentRequestReply: { kind: 'web', doc: 'AGENT_REQUEST_REPLY_MUTATION', components: ['components/AgentRequestActions.tsx'], label: 'Reply to agent' },
  actorSetSuccessor: { kind: 'web', doc: 'ACTOR_SET_SUCCESSOR_MUTATION', components: ['components/ActorSuccessorControl.tsx'], label: 'Successor' },
  bugReport: { kind: 'web', doc: 'BUG_REPORT_MUTATION', components: ['components/ReportBugDialog.tsx'], label: 'Report bug' },
  commentCreate: { kind: 'web', doc: 'COMMENT_CREATE_MUTATION', components: ['routes/IssuePage.tsx'] },
  commentDelete: { kind: 'web', doc: 'COMMENT_DELETE_MUTATION', components: ['routes/IssuePage.tsx'] },
  cycleCreate: { kind: 'web', doc: 'CYCLE_CREATE_MUTATION', components: ['routes/CyclesPage.tsx'] },
  cycleDelete: { kind: 'web', doc: 'CYCLE_DELETE_MUTATION', components: ['routes/CyclesPage.tsx'] },
  cycleUpdate: { kind: 'web', doc: 'CYCLE_UPDATE_MUTATION', components: ['routes/CyclesPage.tsx'] },
  evidenceAttach: { kind: 'web', doc: 'EVIDENCE_ATTACH_MUTATION', components: ['components/EvidenceAttachForm.tsx'], label: 'Attach evidence' },
  evidenceRetract: { kind: 'web', doc: 'EVIDENCE_RETRACT_MUTATION', components: ['components/ReviewEvidence.tsx'], label: 'Retract evidence' },
  fileUpload: { kind: 'web', doc: 'FILE_UPLOAD_MUTATION', components: ['components/RichTextEditor.tsx'] },
  issueCreate: { kind: 'web', doc: 'ISSUE_CREATE_MUTATION', components: ['routes/BoardPage.tsx'] },
  issueDelete: { kind: 'web', doc: 'ISSUE_DELETE_MUTATION', components: ['routes/IssuePage.tsx'] },
  issueUpdate: {
    kind: 'web',
    doc: 'ISSUE_UPDATE_MUTATION',
    components: ['routes/IssuePage.tsx'],
    label: 'Edit contract',
    labelFile: 'components/ContractSection.tsx',
  },
  notificationMarkRead: { kind: 'web', doc: 'NOTIFICATION_MARK_READ_MUTATION', components: ['routes/InboxPage.tsx'], label: 'Mark as read' },
  notificationPreferencesUpdate: {
    kind: 'web',
    doc: 'NOTIFICATION_PREFERENCES_UPDATE_MUTATION',
    components: ['routes/WorkspaceSettingsTabs.tsx'],
    label: 'Email notifications',
  },
  notificationsMarkAllRead: { kind: 'web', doc: 'NOTIFICATIONS_MARK_ALL_READ_MUTATION', components: ['routes/InboxPage.tsx'] },
  projectCreate: { kind: 'api-only', reason: 'Deprecated: a project is a PROJECT work item, created with issueCreate on the Projects page.' },
  projectDelete: { kind: 'api-only', reason: 'Deprecated: a project is a PROJECT work item, deleted with issueDelete on the Projects page.' },
  projectUpdate: { kind: 'api-only', reason: 'Deprecated: a project is a PROJECT work item, edited with issueUpdate on the Projects page.' },
  runReport: { kind: 'api-only', reason: 'Agents report runs; people review them (workReview).' },
  serviceActorCreate: { kind: 'web', doc: 'SERVICE_ACTOR_CREATE_MUTATION', components: ['routes/WorkspaceSettingsTabs.tsx'], label: 'Create service' },
  labelCreate: { kind: 'web', doc: 'LABEL_CREATE_MUTATION', components: ['routes/WorkspaceSettingsTabs.tsx'], label: 'Add label' },
  labelUpdate: { kind: 'web', doc: 'LABEL_UPDATE_MUTATION', components: ['routes/WorkspaceSettingsTabs.tsx'], label: 'Rename' },
  labelDelete: { kind: 'web', doc: 'LABEL_DELETE_MUTATION', components: ['routes/WorkspaceSettingsTabs.tsx'], label: 'Delete label' },
  workflowStateCreate: { kind: 'web', doc: 'WORKFLOW_STATE_CREATE_MUTATION', components: ['routes/WorkspaceSettingsTabs.tsx'], label: 'Add state' },
  workflowStateUpdate: { kind: 'web', doc: 'WORKFLOW_STATE_UPDATE_MUTATION', components: ['routes/WorkspaceSettingsTabs.tsx'], label: 'Rename state' },
  workflowStateDelete: { kind: 'web', doc: 'WORKFLOW_STATE_DELETE_MUTATION', components: ['routes/WorkspaceSettingsTabs.tsx'], label: 'Delete state' },
  userSetGlobalRole: { kind: 'web', doc: 'USER_SET_GLOBAL_ROLE_MUTATION', components: ['routes/WorkspaceSettingsTabs.tsx'], label: 'Make admin' },
  teamMembershipRemove: { kind: 'web', doc: 'TEAM_MEMBERSHIP_REMOVE_MUTATION', components: ['routes/AccessPage.tsx'] },
  teamMembershipUpsert: { kind: 'web', doc: 'TEAM_MEMBERSHIP_UPSERT_MUTATION', components: ['routes/AccessPage.tsx'], label: 'Member role' },
  teamTriageRotationUpdate: { kind: 'web', doc: 'TEAM_TRIAGE_ROTATION_MUTATION', components: ['routes/BugTriageTab.tsx'], label: 'Bug triage rotation' },
  teamUpdateAccess: { kind: 'web', doc: 'TEAM_UPDATE_ACCESS_MUTATION', components: ['routes/AccessPage.tsx'], label: 'Team visibility' },
  userUpdate: { kind: 'web', doc: 'USER_UPDATE_MUTATION', components: ['routes/SettingsPage.tsx'] },
  webhookCreate: { kind: 'web', doc: 'WEBHOOK_CREATE_MUTATION', components: ['routes/OpsPage.tsx'], label: 'Add webhook' },
  webhookDelete: { kind: 'web', doc: 'WEBHOOK_DELETE_MUTATION', components: ['routes/OpsPage.tsx'], label: 'Delete webhook' },
  webhookRotateSecret: { kind: 'web', doc: 'WEBHOOK_ROTATE_SECRET_MUTATION', components: ['routes/OpsPage.tsx'], label: 'Rotate secret' },
  webhookUpdate: { kind: 'web', doc: 'WEBHOOK_UPDATE_MUTATION', components: ['routes/OpsPage.tsx'], label: 'Re-enable' },
  opsSyncDeadLetterClear: { kind: 'web', doc: 'OPS_SYNC_DEAD_LETTER_CLEAR_MUTATION', components: ['routes/OpsPage.tsx'], label: 'Clear and retry' },
  opsInboundReplay: { kind: 'web', doc: 'OPS_INBOUND_REPLAY_MUTATION', components: ['routes/OpsPage.tsx'], label: 'Replay' },
  workClaim: {
    kind: 'api-only',
    reason: 'Agents lease work to execute it; a person owns work through the assignee and can release a claim (workClaimRelease).',
  },
  workClaimRelease: { kind: 'web', doc: 'WORK_CLAIM_RELEASE_MUTATION', components: ['components/ClaimControl.tsx'], label: 'Why release this claim' },
  workCommit: { kind: 'web', doc: 'WORK_COMMIT_MUTATION', components: ['routes/CandidatesPage.tsx'], label: 'Commit' },
  workLink: { kind: 'web', doc: 'WORK_LINK_MUTATION', components: ['components/IssueRelations.tsx'], label: 'Relation type' },
  workLinkDelete: { kind: 'web', doc: 'WORK_LINK_DELETE_MUTATION', components: ['components/IssueRelations.tsx'], label: 'Remove ' },
  workPropose: {
    kind: 'api-only',
    reason: 'Agents propose candidates; people create committed work directly (issueCreate) or report bugs (bugReport).',
  },
  workReject: { kind: 'web', doc: 'WORK_REJECT_MUTATION', components: ['routes/CandidatesPage.tsx'], label: 'Reject reason' },
  workRestore: { kind: 'web', doc: 'WORK_RESTORE_MUTATION', components: ['routes/CandidatesPage.tsx'], label: 'Restore to candidate' },
  workReview: {
    kind: 'web',
    doc: 'WORK_REVIEW_MUTATION',
    components: ['routes/WorkContextPage.tsx', 'routes/InReviewPage.tsx'],
    label: 'Human review',
  },
};

/**
 * Server text that tells someone a person must act, matched by substring, and
 * where that person does it: a mutation in MUTATION_SURFACES, or an open item
 * when no mutation exists yet.
 */
export const HUMAN_GATES: Array<{ text: string; mutation: string } | { text: string; tracking: string }> = [
  { text: 'Agents cannot commit work', mutation: 'workCommit' },
  { text: 'Humans only. Requires acceptance', mutation: 'workCommit' },
  { text: 'Committed work requires a human owner', mutation: 'workCommit' },
  { text: 'Agents cannot reject work', mutation: 'workReject' },
  { text: 'Agents cannot accept or cancel work', mutation: 'workReview' },
  { text: 'Agents cannot transition work directly to COMPLETED or CANCELED', mutation: 'workReview' },
  { text: 'Agents cannot rewrite committed contract fields', mutation: 'issueUpdate' },
  { text: 'Work owner must be a human assignee', mutation: 'issueUpdate' },
  { text: 'Only a person can release a claim', mutation: 'workClaimRelease' },
  { text: 'Only a person can restore a rejected candidate', mutation: 'workRestore' },
  { text: 'Only a person may retract evidence', mutation: 'evidenceRetract' },
  { text: 'Human-only (delegated CLI or Web UI):', mutation: 'workCommit' },
  { text: 'gated on actor kind (humans only)', mutation: 'workCommit' },
  { text: 'Only a human may deactivate or reactivate an actor', mutation: 'actorDeactivate' },
  { text: 'ends its ability to act. Human-only.', mutation: 'actorDeactivate' },
  { text: 'Undo a deactivation. Human-only', mutation: 'actorReactivate' },
  { text: 'Transfer accountability for a non-human actor to another human. Human-only', mutation: 'actorTransferOwner' },
  { text: 'A new agent needs a human owner', mutation: 'agentCredentialCreate' },
  { text: 'Only the person this request is addressed to may answer it', mutation: 'agentRequestAnswer' },
  { text: 'Team membership is a human roster', mutation: 'teamMembershipUpsert' },
  { text: 'the filing agent needs a human owner on this team', mutation: 'teamMembershipUpsert' },
  { text: 'A triage rotation lists human members', mutation: 'teamTriageRotationUpdate' },
  { text: 'Only a human may provision a service actor', mutation: 'serviceActorCreate' },
  { text: 'Provision a SERVICE actor for an external program (CI, cron, a bridge). Human-only.', mutation: 'serviceActorCreate' },
  { text: 'or declare a successor', mutation: 'actorSetSuccessor' },
  { text: 'Only the person who asked may reply', mutation: 'agentRequestReply' },
];

/** Recognises text that tells someone a person must act; every match must be in HUMAN_GATES. */
export const HUMAN_GATE_PATTERN =
  /Only (?:a|the) (?:human|person)|[Hh]umans? only|[Hh]uman-only|ask a (?:human|person)|Agents? (?:cannot|may not|can't)|declare a successor|human (?:owner|roster|members)/;

export type NotificationLanding =
  /**
   * Opens the work page, where the person can act on it. The action text is on
   * the work page, or in `component` when the page renders it through one.
   */
  | { kind: 'work'; action: string; component?: string }
  /** No work item: the inbox row shows the details and links itself. */
  | { kind: 'inbox' }
  /** Opens the work page to show what happened; nothing to do. */
  | { kind: 'info' }
  | { kind: 'gap'; tracking: string; note: string };

/** Every notification type written to a person's inbox. */
export const NOTIFICATION_SURFACES: Record<string, NotificationLanding> = {
  'run.completed': { kind: 'work', action: 'Human review' },
  'work.accepted': { kind: 'info' },
  'work.review_rejected': { kind: 'info' },
  'work.claim_released': { kind: 'info' },
  'bug.sla_at_risk': { kind: 'info' },
  'bug.sla_breached': { kind: 'info' },
  'decision.requested': { kind: 'work', action: 'Respond to the agent', component: 'components/RespondToAgent.tsx' },
  'agent.request_input_required': { kind: 'work', action: 'Reply to agent', component: 'components/AgentRequestActions.tsx' },
  'bug.reported': { kind: 'work', action: 'Triage this candidate' },
  'agent.request_expired': { kind: 'work', action: 'Answer', component: 'components/AgentRequestActions.tsx' },
  'agent.request_handed_off': { kind: 'work', action: 'Answer', component: 'components/AgentRequestActions.tsx' },
  'webhook.disabled': { kind: 'inbox' },
  'ops.event.dead_letter': { kind: 'inbox' },
  'ops.webhook.disabled': { kind: 'inbox' },
  'ops.github_sync.dead_letter': { kind: 'inbox' },
  'ops.github_inbound.dead_letter': { kind: 'inbox' },
  'ops.github_inbound.payload_conflict': { kind: 'inbox' },
  'ops.github.pr_unverified_reference': { kind: 'inbox' },
};
