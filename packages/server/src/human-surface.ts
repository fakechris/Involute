/**
 * Where a person does each thing the server lets or asks a person to do
 * (INV-795). Work kept landing with a server rule that said "ask a human" and
 * no screen where a human could: committed contracts (INV-786), claim release,
 * evidence retraction, alias editing. `human-surface.test.ts` holds this table
 * against the code:
 *
 * - every GraphQL mutation has an entry;
 * - a `web` entry's document and component still exist and still use it, and
 *   its label is still on screen, and a web test exercises it (INV-1004);
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
      /**
       * The web test that exercises this entry point (path under packages/web/src),
       * or the open item that will write it (INV-1004). A bare entry fails the test.
       */
      test: string | { tracking: string };
    }
  /** Deliberately not a person's action; the reason says who does it instead. */
  | { kind: 'api-only'; reason: string }
  /** A known missing entry point, tracked by an open work item. */
  | { kind: 'gap'; tracking: string; note: string };

export const MUTATION_SURFACES: Record<string, HumanSurface> = {
  executorUpdate: { kind: 'web', components: ['components/ExecutorPanel.tsx'], label: 'Stop executor', test: 'components/ExecutorPanel.test.tsx' },
  deliveryChangePropose: { kind: 'web', components: ['components/DeliveryPanel.tsx'], label: 'Propose delivery change', test: 'components/DeliveryPanel.test.tsx' },
  deliveryChangeDecide: { kind: 'web', components: ['components/DeliveryPanel.tsx'], label: 'Approve delivery change', test: 'components/DeliveryPanel.test.tsx' },
  deliveryExecutionCreate: { kind: 'web', components: ['components/DeliveryPanel.tsx'], label: 'Create implementation', test: 'components/DeliveryPanel.test.tsx' },
  actorDeactivate: { kind: 'web', doc: 'ACTOR_DEACTIVATE_MUTATION', components: ['components/AgentLifecycleActions.tsx'], label: 'Deactivate', test: 'App.agents-lifecycle.test.tsx' },
  actorReactivate: { kind: 'web', doc: 'ACTOR_REACTIVATE_MUTATION', components: ['components/AgentLifecycleActions.tsx'], label: 'Reactivate', test: 'App.agents-lifecycle.test.tsx' },
  actorTransferOwner: { kind: 'web', doc: 'ACTOR_TRANSFER_OWNER_MUTATION', components: ['components/AgentLifecycleActions.tsx'], label: 'Transfer owner', test: 'App.agents-lifecycle.test.tsx' },
  agentCredentialCreate: { kind: 'web', components: ['routes/AgentsTab.tsx'], test: 'App.agents-issue.test.tsx' },
  agentCredentialRevoke: { kind: 'web', doc: 'AGENT_CREDENTIAL_REVOKE_MUTATION', components: ['routes/AgentsPage.tsx'], label: 'Revoke', test: 'App.agents-lifecycle.test.tsx' },
  agentRequestAnswer: {
    kind: 'web',
    doc: 'AGENT_REQUEST_ANSWER_MUTATION',
    components: ['routes/IssuePage.tsx', 'components/AgentRequestActions.tsx'],
    label: 'Answer',
    test: 'components/AgentRequestActions.test.tsx',
  },
  agentRequestReply: { kind: 'web', doc: 'AGENT_REQUEST_REPLY_MUTATION', components: ['components/AgentRequestActions.tsx'], label: 'Reply to agent', test: 'components/AgentRequestActions.test.tsx' },
  actorSetSuccessor: { kind: 'web', doc: 'ACTOR_SET_SUCCESSOR_MUTATION', components: ['components/ActorSuccessorControl.tsx'], label: 'Successor', test: 'components/AgentRequestActions.test.tsx' },
  bugReport: { kind: 'web', doc: 'BUG_REPORT_MUTATION', components: ['components/ReportBugDialog.tsx'], label: 'Report bug', test: 'components/ReportBugDialog.test.tsx' },
  commentCreate: { kind: 'web', doc: 'COMMENT_CREATE_MUTATION', components: ['routes/IssuePage.tsx'], test: 'App.delete.test.tsx' },
  commentDelete: { kind: 'web', doc: 'COMMENT_DELETE_MUTATION', components: ['routes/IssuePage.tsx'], test: 'App.delete.test.tsx' },
  contractAmendmentAccept: {
    kind: 'web',
    doc: 'CONTRACT_AMENDMENT_ACCEPT_MUTATION',
    components: ['components/ContractAmendmentPanel.tsx'],
    label: 'Accept change',
    test: 'components/ContractAmendmentPanel.test.tsx',
  },
  contractAmendmentReject: {
    kind: 'web',
    doc: 'CONTRACT_AMENDMENT_REJECT_MUTATION',
    components: ['components/ContractAmendmentPanel.tsx'],
    label: 'Reject change',
    test: 'components/ContractAmendmentPanel.test.tsx',
  },
  cycleCreate: { kind: 'web', doc: 'CYCLE_CREATE_MUTATION', components: ['routes/CyclesPage.tsx'], test: 'routes/CyclesPage.test.tsx' },
  cycleDelete: { kind: 'web', doc: 'CYCLE_DELETE_MUTATION', components: ['routes/CyclesPage.tsx'], test: 'routes/CyclesPage.test.tsx' },
  cycleUpdate: { kind: 'web', doc: 'CYCLE_UPDATE_MUTATION', components: ['routes/CyclesPage.tsx'], test: 'routes/CyclesPage.test.tsx' },
  evidenceAttach: { kind: 'web', doc: 'EVIDENCE_ATTACH_MUTATION', components: ['components/EvidenceAttachForm.tsx'], label: 'Attach evidence', test: 'components/EvidenceAttachForm.test.tsx' },
  evidenceRetract: { kind: 'web', doc: 'EVIDENCE_RETRACT_MUTATION', components: ['components/ReviewEvidence.tsx'], label: 'Retract evidence', test: 'App.work-observation.test.tsx' },
  fileUpload: { kind: 'web', doc: 'FILE_UPLOAD_MUTATION', components: ['components/RichTextEditor.tsx'], test: 'components/RichTextEditor.test.tsx' },
  issueCreate: { kind: 'web', doc: 'ISSUE_CREATE_MUTATION', components: ['routes/BoardPage.tsx'], test: 'App.issue-create.test.tsx' },
  issueDelete: { kind: 'web', doc: 'ISSUE_DELETE_MUTATION', components: ['routes/IssuePage.tsx'], label: 'Delete issue', test: 'App.issue-meta.test.tsx' },
  issueUndelete: { kind: 'web', doc: 'ISSUE_UNDELETE_MUTATION', components: ['undo/DeleteUndoHost.tsx'], label: 'Undo', test: 'App.delete-undo.test.tsx' },
  issueUpdate: {
    kind: 'web',
    doc: 'ISSUE_UPDATE_MUTATION',
    components: ['routes/IssuePage.tsx'],
    label: 'Edit contract',
    labelFile: 'components/ContractSection.tsx',
    test: 'App.issue-detail-edit.test.tsx',
  },
  notificationMarkRead: { kind: 'web', doc: 'NOTIFICATION_MARK_READ_MUTATION', components: ['routes/InboxPage.tsx'], label: 'Mark as read', test: 'routes/InboxPage.test.tsx' },
  notificationPreferencesUpdate: {
    kind: 'web',
    doc: 'NOTIFICATION_PREFERENCES_UPDATE_MUTATION',
    components: ['routes/WorkspaceSettingsTabs.tsx'],
    label: 'Email notifications',
    test: 'routes/WorkspaceSettingsTabs.test.tsx',
  },
  notificationsMarkAllRead: { kind: 'web', doc: 'NOTIFICATIONS_MARK_ALL_READ_MUTATION', components: ['routes/InboxPage.tsx'], test: 'routes/InboxPage.test.tsx' },
  projectCreate: { kind: 'api-only', reason: 'Deprecated: a project is a PROJECT work item, created with issueCreate on the Projects page.' },
  projectDelete: { kind: 'api-only', reason: 'Deprecated: a project is a PROJECT work item, deleted with issueDelete on the Projects page.' },
  projectUpdate: { kind: 'api-only', reason: 'Deprecated: a project is a PROJECT work item, edited with issueUpdate on the Projects page.' },
  runReport: { kind: 'api-only', reason: 'Agents report runs; people review them (workReview).' },
  serviceActorCreate: { kind: 'web', doc: 'SERVICE_ACTOR_CREATE_MUTATION', components: ['routes/WorkspaceSettingsTabs.tsx'], label: 'Create service', test: 'routes/WorkspaceSettingsTabs.test.tsx' },
  labelCreate: { kind: 'web', doc: 'LABEL_CREATE_MUTATION', components: ['routes/WorkspaceSettingsTabs.tsx'], label: 'Add label', test: 'routes/WorkspaceSettingsTabs.test.tsx' },
  labelUpdate: { kind: 'web', doc: 'LABEL_UPDATE_MUTATION', components: ['routes/WorkspaceSettingsTabs.tsx'], label: 'Rename', test: 'routes/WorkspaceSettingsTabs.test.tsx' },
  labelDelete: { kind: 'web', doc: 'LABEL_DELETE_MUTATION', components: ['routes/WorkspaceSettingsTabs.tsx'], label: 'Delete label', test: 'routes/WorkspaceSettingsTabs.test.tsx' },
  workflowStateCreate: { kind: 'web', doc: 'WORKFLOW_STATE_CREATE_MUTATION', components: ['routes/WorkspaceSettingsTabs.tsx'], label: 'Add state', test: 'routes/WorkspaceSettingsTabs.test.tsx' },
  workflowStateUpdate: { kind: 'web', doc: 'WORKFLOW_STATE_UPDATE_MUTATION', components: ['routes/WorkspaceSettingsTabs.tsx'], label: 'Rename state', test: 'routes/WorkspaceSettingsTabs.test.tsx' },
  workflowStateDelete: { kind: 'web', doc: 'WORKFLOW_STATE_DELETE_MUTATION', components: ['routes/WorkspaceSettingsTabs.tsx'], label: 'Delete state', test: 'routes/WorkspaceSettingsTabs.test.tsx' },
  userSetGlobalRole: { kind: 'web', doc: 'USER_SET_GLOBAL_ROLE_MUTATION', components: ['routes/AdministrationTabs.tsx'], label: 'Workspace role for', test: 'routes/AdministrationTabs.test.tsx' },
  teamMembershipRemove: { kind: 'web', doc: 'TEAM_MEMBERSHIP_REMOVE_MUTATION', components: ['routes/TeamPages.tsx'], label: 'Remove', test: 'App.team-pages.test.tsx' },
  teamMembershipUpsert: { kind: 'web', doc: 'TEAM_MEMBERSHIP_UPSERT_MUTATION', components: ['routes/TeamPages.tsx'], label: 'Add to team', test: 'App.team-pages.test.tsx' },
  teamTriageRotationUpdate: { kind: 'web', doc: 'TEAM_TRIAGE_ROTATION_MUTATION', components: ['routes/BugTriageTab.tsx'], label: 'Bug triage rotation', test: 'routes/BugTriageTab.test.tsx' },
  teamUpdateAccess: { kind: 'api-only', reason: 'Superseded by teamUpdate (name and visibility together), which the team settings page uses; kept for existing API clients.' },
  userUpdate: { kind: 'web', doc: 'USER_UPDATE_MUTATION', components: ['routes/SettingsPage.tsx'], test: 'routes/SettingsPage.test.tsx' },
  savedViewUpsert: { kind: 'web', doc: 'SAVED_VIEW_UPSERT_MUTATION', components: ['routes/ViewsPage.tsx'], label: 'Share with team', test: 'routes/ViewsPage.test.tsx' },
  savedViewDelete: { kind: 'web', doc: 'SAVED_VIEW_DELETE_MUTATION', components: ['routes/ViewsPage.tsx'], label: 'Delete view', test: 'routes/ViewsPage.test.tsx' },
  webhookCreate: { kind: 'web', doc: 'WEBHOOK_CREATE_MUTATION', components: ['routes/OpsPage.tsx'], label: 'Add webhook', test: 'routes/OpsPage.test.tsx' },
  webhookDelete: { kind: 'web', doc: 'WEBHOOK_DELETE_MUTATION', components: ['routes/OpsPage.tsx'], label: 'Delete webhook', test: 'routes/OpsPage.test.tsx' },
  webhookRotateSecret: { kind: 'web', doc: 'WEBHOOK_ROTATE_SECRET_MUTATION', components: ['routes/OpsPage.tsx'], label: 'Rotate secret', test: 'routes/OpsPage.test.tsx' },
  webhookUpdate: { kind: 'web', doc: 'WEBHOOK_UPDATE_MUTATION', components: ['routes/OpsPage.tsx'], label: 'Re-enable', test: 'routes/OpsPage.test.tsx' },
  opsSyncDeadLetterClear: { kind: 'web', doc: 'OPS_SYNC_DEAD_LETTER_CLEAR_MUTATION', components: ['routes/OpsPage.tsx'], label: 'Clear and retry', test: 'routes/OpsPage.test.tsx' },
  opsInboundReplay: { kind: 'web', doc: 'OPS_INBOUND_REPLAY_MUTATION', components: ['routes/OpsPage.tsx'], label: 'Replay', test: 'routes/OpsPage.test.tsx' },
  workClaim: {
    kind: 'api-only',
    reason: 'Agents lease work to execute it; a person owns work through the assignee and can release a claim (workClaimRelease).',
  },
  workClaimRelease: { kind: 'web', doc: 'WORK_CLAIM_RELEASE_MUTATION', components: ['components/ClaimControl.tsx'], label: 'Why release this claim', test: 'components/ClaimControl.test.tsx' },
  workCommit: { kind: 'web', doc: 'WORK_COMMIT_MUTATION', components: ['routes/CandidatesPage.tsx', 'routes/AttentionPage.tsx'], label: 'Commit', test: 'routes/CandidatesPage.test.tsx' },
  workLink: { kind: 'web', doc: 'WORK_LINK_MUTATION', components: ['components/IssueRelations.tsx'], label: 'Relation type', test: 'App.issue-relations.test.tsx' },
  workLinkDelete: { kind: 'web', doc: 'WORK_LINK_DELETE_MUTATION', components: ['components/IssueRelations.tsx'], label: 'Remove ', test: 'App.issue-relations.test.tsx' },
  workShareRemove: { kind: 'web', doc: 'WORK_SHARE_REMOVE_MUTATION', components: ['components/ProjectSharing.tsx'], label: 'Remove', test: 'App.project-sharing.test.tsx' },
  workShareUpsert: { kind: 'web', doc: 'WORK_SHARE_UPSERT_MUTATION', components: ['components/ProjectSharing.tsx'], label: 'Share', test: 'App.project-sharing.test.tsx' },
  teamArchive: { kind: 'web', doc: 'TEAM_ARCHIVE_MUTATION', components: ['routes/AdministrationTabs.tsx', 'routes/TeamPages.tsx'], label: 'Archive', test: 'routes/AdministrationTabs.test.tsx' },
  teamCreate: { kind: 'web', doc: 'TEAM_CREATE_MUTATION', components: ['routes/AdministrationTabs.tsx'], label: 'Create team', test: 'routes/AdministrationTabs.test.tsx' },
  teamJoin: { kind: 'web', doc: 'TEAM_JOIN_MUTATION', components: ['routes/TeamPages.tsx'], label: 'Join', test: 'App.team-pages.test.tsx' },
  teamLeave: { kind: 'web', doc: 'TEAM_LEAVE_MUTATION', components: ['routes/TeamPages.tsx'], label: 'Leave', test: 'App.team-pages.test.tsx' },
  teamUnarchive: { kind: 'web', doc: 'TEAM_UNARCHIVE_MUTATION', components: ['routes/AdministrationTabs.tsx', 'routes/TeamPages.tsx'], label: 'Unarchive', test: 'routes/AdministrationTabs.test.tsx' },
  teamUpdate: { kind: 'web', doc: 'TEAM_UPDATE_MUTATION', components: ['routes/TeamPages.tsx'], label: 'Save team settings', test: 'App.team-pages.test.tsx' },
  userInvite: { kind: 'web', doc: 'USER_INVITE_MUTATION', components: ['routes/AdministrationTabs.tsx'], label: 'Send invite', test: 'routes/AdministrationTabs.test.tsx' },
  userInviteRevoke: { kind: 'web', doc: 'USER_INVITE_REVOKE_MUTATION', components: ['routes/AdministrationTabs.tsx'], label: 'Revoke invite', test: 'routes/AdministrationTabs.test.tsx' },
  userReactivate: { kind: 'web', doc: 'USER_REACTIVATE_MUTATION', components: ['routes/AdministrationTabs.tsx'], label: 'Reactivate', test: 'routes/AdministrationTabs.test.tsx' },
  userSuspend: { kind: 'web', doc: 'USER_SUSPEND_MUTATION', components: ['routes/AdministrationTabs.tsx'], label: 'Suspend', test: 'routes/AdministrationTabs.test.tsx' },
  workspaceSettingsUpdate: { kind: 'web', doc: 'WORKSPACE_SETTINGS_UPDATE_MUTATION', components: ['routes/AdministrationTabs.tsx'], label: 'Save security settings', test: 'routes/AdministrationTabs.test.tsx' },
  workPropose: {
    kind: 'api-only',
    reason: 'Agents propose candidates; people create committed work directly (issueCreate) or report bugs (bugReport).',
  },
  workReject: { kind: 'web', doc: 'WORK_REJECT_MUTATION', components: ['routes/CandidatesPage.tsx'], label: 'Reject reason', test: 'routes/CandidatesPage.test.tsx' },
  workRestore: { kind: 'web', doc: 'WORK_RESTORE_MUTATION', components: ['routes/CandidatesPage.tsx'], label: 'Restore to candidate', test: 'routes/CandidatesPage.test.tsx' },
  workUncommit: { kind: 'web', doc: 'WORK_UNCOMMIT_MUTATION', components: ['undo/CommitUndoHost.tsx'], label: 'Undo commit', test: 'routes/CandidatesPage.test.tsx' },
  workReview: {
    kind: 'web',
    doc: 'WORK_REVIEW_MUTATION',
    // Needs you accepts by key and in batches (INV-1092).
    components: ['components/HumanReviewSection.tsx', 'routes/InReviewPage.tsx', 'routes/AttentionPage.tsx'],
    label: 'Human review',
    test: 'routes/InReviewPage.test.tsx',
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
  { text: 'Agents stop at Review except committed Research issues; Canceled remains human-only.', mutation: 'workReview' },
  { text: 'Agents cannot transition work directly to COMPLETED or CANCELED', mutation: 'workReview' },
  { text: 'Agents cannot rewrite committed contract fields', mutation: 'issueUpdate' },
  { text: 'Work owner must be a human assignee', mutation: 'issueUpdate' },
  { text: 'Only a person can turn automatic acceptance of verified bug fixes on or off.', mutation: 'issueUpdate' },
  { text: 'Only a person may reconcile external effects.', mutation: 'executorUpdate' },
  { text: 'Instantiate an approved delivery unit and any predecessors', mutation: 'deliveryExecutionCreate' },
  { text: 'Only a person may approve or reject a delivery change set', mutation: 'deliveryChangeDecide' },
  { text: 'Only a person can release a claim', mutation: 'workClaimRelease' },
  { text: 'Only a person can restore a rejected candidate', mutation: 'workRestore' },
  { text: 'Only a person can return committed work to the candidate queue', mutation: 'workUncommit' },
  { text: 'Only a person may retract evidence', mutation: 'evidenceRetract' },
  { text: 'Only a person may accept or reject a contract amendment', mutation: 'contractAmendmentAccept' },
  { text: 'Agents cannot rewrite a committed contract; this records', mutation: 'contractAmendmentAccept' },
  { text: "Human-only. Apply an agent's proposed contract change", mutation: 'contractAmendmentAccept' },
  { text: "Human-only. Decline an agent's proposed contract change", mutation: 'contractAmendmentReject' },
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
  'run.completed': { kind: 'work', action: 'Human review', component: 'components/HumanReviewSection.tsx' },
  'work.accepted': { kind: 'info' },
  'work.review_rejected': { kind: 'info' },
  // The proposer hears the decision on its proposal (INV-968).
  'work.committed': { kind: 'info' },
  'work.rejected': { kind: 'info' },
  'work.uncommitted': { kind: 'info' },
  // A delivery authorization was decided; the agent reads it and starts, or stops (INV-990).
  'delivery.approved': { kind: 'info' },
  'delivery.declined': { kind: 'info' },
  'work.claim_released': { kind: 'info' },
  // Written to the approved executor's (an agent's) inbox: start on it (INV-993).
  'executor.dispatched': { kind: 'info' },
  'work.claim_expired': { kind: 'info' },
  // The run went quiet; the owner looks at the work page and decides (INV-996).
  'run.stale': { kind: 'info' },
  // A fixed bug waits past the review clock: the owner reviews it (INV-1002).
  'review.overdue': { kind: 'work', action: 'Human review', component: 'components/HumanReviewSection.tsx' },
  // Daily: how much waits in Review and for how long; the owner opens /in-review (INV-1002).
  'review.digest': { kind: 'inbox' },
  // The research proposer (usually an agent) closes it with work_update(state: DONE) (INV-1001).
  'research.closable': { kind: 'info' },
  'bug.sla_at_risk': { kind: 'info' },
  'bug.sla_breached': { kind: 'info' },
  'contract.amendment_proposed': { kind: 'work', action: 'Accept change', component: 'components/ContractAmendmentPanel.tsx' },
  'decision.requested': { kind: 'work', action: 'Respond to the agent', component: 'components/RespondToAgent.tsx' },
  'agent.request_input_required': { kind: 'work', action: 'Reply to agent', component: 'components/AgentRequestActions.tsx' },
  'bug.reported': { kind: 'work', action: 'Triage this candidate' },
  'agent.request_expired': { kind: 'work', action: 'Answer', component: 'components/AgentRequestActions.tsx' },
  'agent.request_handed_off': { kind: 'work', action: 'Answer', component: 'components/AgentRequestActions.tsx' },
  'webhook.disabled': { kind: 'inbox' },
  // INV-1093: decisions nobody was told about. Each is decided in Needs you (/todo).
  'work.proposed_batch': { kind: 'inbox' },
  'delivery.proposed': { kind: 'inbox' },
  // The unit ran out of attempts; the work page shows the package to re-plan.
  'executor.exhausted': { kind: 'info' },
  'ops.event.dead_letter': { kind: 'inbox' },
  'ops.webhook.disabled': { kind: 'inbox' },
  'ops.github_sync.dead_letter': { kind: 'inbox' },
  'ops.github_inbound.dead_letter': { kind: 'inbox' },
  'ops.github_inbound.payload_conflict': { kind: 'inbox' },
  'ops.github.pr_unverified_reference': { kind: 'inbox' },
};
