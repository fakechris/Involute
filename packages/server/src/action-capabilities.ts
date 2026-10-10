import { MUTATION_SURFACES } from './human-surface.js';

/** MCP write tool → the GraphQL mutation a person (the web app) uses for the same change. */
export const PAIRS: Record<string, string> = {
  agent_request_answer: 'agentRequestAnswer',
  agent_request_needinfo: 'needInfoRequest',
  agent_request_withdraw: 'needInfoWithdraw',
  notification_mark_read: 'notificationMarkRead',
  evidence_attach: 'evidenceAttach',
  run_report: 'runReport',
  work_claim: 'workClaim',
  work_claim_release: 'workClaimRelease',
  evidence_retract: 'evidenceRetract',
  work_commit: 'workCommit',
  work_uncommit: 'workUncommit',
  work_file_bug: 'bugReport',
  work_link: 'workLink',
  work_unlink: 'workLinkDelete',
  work_propose: 'workPropose',
  work_update: 'issueUpdate',
  work_comment: 'commentCreate',
  work_delivery_propose: 'deliveryChangePropose',
  work_execution_create: 'deliveryExecutionCreate',
  work_attach_file: 'fileUpload',
  work_view_save: 'savedViewUpsert',
  work_view_delete: 'savedViewDelete',
  work_timeline_star: 'issueTimelineStar',
  work_timeline_unstar: 'issueTimelineUnstar',
  work_executor_update: 'executorUpdate',
};

/**
 * MCP read tool → the GraphQL queries the web app uses for the same reads
 * (INV-1004). A query with no tool here and no entry in QUERY_EXEMPTIONS fails
 * the parity test, as a mutation would.
 */
export const READ_PAIRS: Record<string, string[]> = {
  work_search: ['search', 'issues'],
  work_catalog: ['teams', 'issueLabels', 'cycles', 'users', 'agents', 'viewerCapabilities'],
  work_read_page: ['deliveryChanges'],
  work_get_context: ['workContext', 'issue'],
  work_list_ready: ['readyWork'],
  work_delivery_context: ['deliveryContext'],
  work_executor_context: ['executorContextJson'],
  agent_inbox: ['notifications', 'unreadNotificationCount'],
  work_views: ['savedViews'],
  work_timeline: ['issueTimeline'],
};

/** MCP read tools with no GraphQL counterpart, and why. */
export const AGENT_ONLY_READ_TOOLS: Record<string, string> = {
  protocol_get_guide: 'The agent protocol as markdown; people read docs/ and the web app itself.',
  work_postmortem_draft: 'A markdown starting point an agent completes and attaches (INV-1126); people read the starred timeline on the issue page and write the postmortem from docs/postmortem.md.',
};

/** GraphQL queries that intentionally have no MCP tool; each names the decision it rests on. */
export const QUERY_EXEMPTIONS: Record<string, { reason: string; decision: string }> = {
  viewer: { reason: 'The signed-in person; an agent is its credential (work_catalog actors).', decision: 'INV-846' },
  workspaceSettings: { reason: 'Sign-in and access policy are administration.', decision: 'INV-846' },
  serverFeatures: { reason: 'Feature flags for the web shell.', decision: 'INV-795' },
  projects: { reason: 'Legacy Project model; a project is PROJECT work (work_search kind = PROJECT).', decision: 'INV-718' },
  project: { reason: 'Legacy Project model; a project is PROJECT work (work_get_context).', decision: 'INV-718' },
  cycle: { reason: 'One cycle by id for the cycles page; agents list them with work_catalog(cycles).', decision: 'INV-795' },
  workGraph: { reason: 'The graph observation view for people; agents read relations per item (work_get_context, work_read_page).', decision: 'INV-718' },
  workHygiene: { reason: 'The /hygiene inspection view for people; agents get the per-item reminders (run_report, research closure).', decision: 'INV-721' },
  candidateSummary: { reason: 'Board-level counts for people deciding candidates.', decision: 'INV-79' },
  projectSummary: { reason: 'Portfolio summary for people.', decision: 'INV-79' },
  bugSummary: { reason: 'The /bugs statistics page for triage.', decision: 'INV-750' },
  projectForOrigin: { reason: 'Routes a page to its PROJECT for the bug-capture extension and the web; agents know their repository.', decision: 'INV-1144' },
  bugsFixedBetween: { reason: 'The deploy-range changelog on /bugs for people; agents read each bug\'s merge evidence with work_get_context.', decision: 'INV-1121' },
  serverBuild: { reason: 'The running build for the web shell (Report bug found-in default); agents read protocol.buildSha from protocol_get_guide.', decision: 'INV-1121' },
  similarBugs: { reason: 'Live suggestions while a person types a bug title; work_file_bug returns possible_duplicates on filing.', decision: 'INV-1000' },
  traceabilityAudit: { reason: 'Post-merge audit for operators.', decision: 'INV-449' },
  agentProfile: { reason: 'The agent directory page; agents identify each other through work_catalog(actors).', decision: 'INV-795' },
  agentCredentials: { reason: 'Credential issuance and lifecycle belong to human administrators.', decision: 'INV-846' },
  webhooks: { reason: 'Integration credentials are administrative controls.', decision: 'INV-796' },
  opsOverview: { reason: 'Operations runbook view for administrators.', decision: 'INV-796' },
  extensionTokens: { reason: 'A person lists their own browser-extension connections.', decision: 'INV-1145' },
  attention: { reason: 'The Needs you queue of decisions only people make; an agent learns of decisions through agent_inbox.', decision: 'INV-1090' },
  attentionSummary: { reason: 'The Needs you count for people; agents read agent_inbox.', decision: 'INV-1090' },
};

/** MCP write tools with no GraphQL counterpart, and why. */
export const AGENT_ONLY_TOOLS: Record<string, string> = {
  agent_request_claim: 'Agents lease a request before answering it; a person answers directly (agentRequestAnswer).',
  work_propose_amendment: 'How an agent asks for a contract edit it may not make; a person edits the contract directly (issueUpdate) or decides the proposal (contractAmendmentAccept/Reject).',
};

/** MCP argument → GraphQL field when the names differ. */
export const RENAMED: Record<string, Record<string, string>> = {
  agent_request_answer: { id: 'requestId' },
  agent_request_withdraw: { id: 'requestId' },
  run_report: { pr_number: 'pullRequestNumber' },
  // Names on MCP, ids in the Report bug dialog (INV-1000).
  work_file_bug: { team: 'teamId', labels: 'labelIds' },
  work_propose: { team: 'teamId' },
  work_update: { state: 'stateId' },
  work_comment: { work_id: 'issueId' },
  work_delivery_propose: { changes: 'changesJson' },
  work_executor_update: { details: 'detailsJson' },
  work_attach_file: { work_id: 'issueId', mime_type: 'mimeType' },
  // The web app sends the state as JSON text; MCP takes the object.
  work_view_save: { team_key: 'teamKey', state: 'stateJson' },
  work_timeline_star: { work_id: 'issueId' },
  work_timeline_unstar: { work_id: 'issueId' },
};

/** MCP arguments with no GraphQL field, and why a person does not need them. */
export const AGENT_ONLY_FIELDS: Record<string, Record<string, string>> = {
  work_unlink: {
    from_id: 'Selects the existing edge by endpoints; the UI selects that same edge by its id for workLinkDelete.',
    to_id: 'Selects the existing edge by endpoints; the UI selects that same edge by its id for workLinkDelete.',
    type: 'Disambiguates the existing edge; the UI selects that same edge by its id for workLinkDelete.',
  },
  agent_request_answer: {
    claim_token: 'Proves the answering execution holds the request lease; a person does not lease requests.',
    session_id: 'Identifies the agent execution that answers.',
    receipt: 'Agent decision receipt (INV-588); a person\'s answer is the comment itself.',
    evidence: 'Agent-attached references backing its answer.',
  },
  run_report: { receipt: 'Agent decision receipt (INV-588); people do not report runs.' },
  work_file_bug: {
    related_work_id: 'Agents file a bug they found while working on another item (DISCOVERED_DURING).',
    related_work_type: 'Agents file a bug they found while working on another item (DISCOVERED_DURING).',
    initial_state: 'An agent that fixed the bug on the spot files it straight into Review.',
    acceptance: 'A bug is committed on filing and agents cannot edit acceptance on committed work; a person sets it on the issue page instead.',
    verification: 'Same as acceptance: a person edits it on the issue page after reporting.',
    idempotency_key: 'Lets an agent retry a filing without duplicating it; the web app submits once.',
    source: 'Tags where an agent found the bug; a person\'s report is tagged bug-report by the server.',
    commit_sha: 'An agent files the bug it fixed on the spot with the fix (INV-997); a person attaches evidence to the issue afterwards.',
    pr_number: 'Same as commit_sha: the fix PR of a bug fixed before filing.',
    evidence_url: 'Same as commit_sha: proof of a fix made before filing.',
    summary: 'Same as commit_sha: the run summary of a fix made before filing.',
  },
};

/**
 * These actions intentionally stay with people. New mutations need an explicit
 * decision here, and each entry names the work item or DECISION that made the
 * rule (INV-1004) — a reason alone is not an exemption.
 */
export const MCP_EXEMPTIONS: Record<string, { reason: string; gate: 'administration' | 'candidate' | 'final-acceptance' | 'personal' | 'deprecated'; decision: string }> = {
  deliveryChangeDecide: { gate: 'candidate', reason: 'A person approves or declines changes to delivery authority.', decision: 'INV-941' },
  contractAmendmentAccept: { gate: 'candidate', reason: 'A person approves a proposed committed-contract amendment.', decision: 'INV-869' },
  contractAmendmentReject: { gate: 'candidate', reason: 'A person declines a committed-contract amendment.', decision: 'INV-869' },
  workReject: { gate: 'candidate', reason: 'A person declines candidate work with a reason.', decision: 'INV-79' },
  workRestore: { gate: 'candidate', reason: 'A person restores rejected work to the candidate queue.', decision: 'INV-79' },
  workReview: { gate: 'final-acceptance', reason: 'A person accepts delivery or returns it with feedback.', decision: 'INV-474' },
  issueCreate: { gate: 'candidate', reason: 'People create committed work; agents use work_propose or work_file_bug.', decision: 'INV-79' },
  extensionTokenCreate: { gate: 'personal', reason: 'A person connects their own browser extension; agents have their own credentials.', decision: 'INV-1145' },
  extensionTokenRevoke: { gate: 'personal', reason: 'A person disconnects their own browser extension.', decision: 'INV-1145' },
  issueDelete: { gate: 'administration', reason: 'Permanent deletion is a human administrative action; agent delivery preserves history.', decision: 'INV-846' },
  issueUndelete: { gate: 'administration', reason: 'Undoing a deletion is the same administrative act in reverse; agents never deleted it.', decision: 'INV-840' },
  commentDelete: { gate: 'personal', reason: 'People delete their comments; agents append an attributable correction with work_comment.', decision: 'INV-795' },
  agentRequestReply: { gate: 'personal', reason: 'Human follow-up questions; agents answer leased requests through agent_request_answer.', decision: 'INV-795' },
  notificationsMarkAllRead: { gate: 'personal', reason: 'Human inbox read state.', decision: 'INV-968' },
  notificationPreferencesUpdate: { gate: 'personal', reason: 'Human notification preferences.', decision: 'INV-795' },
  userUpdate: { gate: 'personal', reason: 'Human profile settings.', decision: 'INV-795' },
  projectCreate: { gate: 'deprecated', reason: 'Legacy Project model; use PROJECT work via work_propose.', decision: 'INV-718' },
  projectUpdate: { gate: 'deprecated', reason: 'Legacy Project model; use PROJECT work via work_update.', decision: 'INV-718' },
  projectDelete: { gate: 'deprecated', reason: 'Legacy Project model; human issueDelete handles PROJECT work.', decision: 'INV-718' },
};
const administration: Array<[string, string, string[]]> = [
  ['Identity, credential issuance and lifecycle belong to human administrators.', 'INV-846', ['actorDeactivate', 'actorReactivate', 'actorTransferOwner', 'actorSetSuccessor', 'agentCredentialCreate', 'agentCredentialRevoke', 'serviceActorCreate', 'userSetGlobalRole', 'userInvite', 'userInviteRevoke', 'userReactivate', 'userSuspend']],
  ['Workspace and team access or membership configuration belongs to human administrators.', 'INV-846', ['teamMembershipRemove', 'teamMembershipUpsert', 'teamTriageRotationUpdate', 'teamUpdateAccess', 'teamArchive', 'teamCreate', 'teamJoin', 'teamLeave', 'teamUnarchive', 'teamUpdate', 'workspaceSettingsUpdate', 'workShareRemove', 'workShareUpsert']],
  ['Dedicated taxonomy configuration lives in Settings; agents select catalog values, and work_propose can also create named labels.', 'INV-795', ['cycleCreate', 'cycleDelete', 'cycleUpdate', 'labelCreate', 'labelUpdate', 'labelDelete', 'workflowStateCreate', 'workflowStateUpdate', 'workflowStateDelete']],
  ['Integration credentials and operational replay are administrative controls.', 'INV-796', ['webhookCreate', 'webhookDelete', 'webhookRotateSecret', 'webhookUpdate', 'opsSyncDeadLetterClear', 'opsInboundReplay']],
];
for (const [reason, decision, names] of administration) for (const name of names) MCP_EXEMPTIONS[name] = { gate: 'administration', reason, decision };

/**
 * Where the same field is deliberately typed differently on the two surfaces
 * (INV-1004); anything else that differs fails the parity test.
 */
export const FIELD_TYPE_EXCEPTIONS: Record<string, Record<string, string>> = {};

/** Explicit GraphQL-only inputs. No wildcard exemption: a newly added field fails coverage. */
export const GRAPHQL_ONLY_FIELDS: Record<string, Record<string, string>> = {
  agentRequestAnswer: { overrideReason: 'Human override of an agent request claim; agents must hold their claim token.' },
  bugReport: { labelIds: 'The dedicated bug tool sets Type Bug. Apply existing extra labels with work_update(label_ids), or use work_propose(labels) with the same bug rules.', capture: 'Browser environment collected by the capture extension from a page a person is looking at; an agent describes its reproduction in steps_to_reproduce (INV-1146, decision INV-1144).' },
  workLinkDelete: { id: 'MCP work_unlink selects the same edge by its directed endpoints and type.' },
  issueUpdate: { assigneeId: 'Human accountability is managed in the web UI; a claim never changes the assignee.', projectId: 'Legacy Project association; work hierarchy uses parentId on both surfaces.', autoAcceptBugs: 'Whether verified fixes may close themselves is a person\'s decision on the Projects page; an agent cannot widen its own acceptance (INV-1075).', resolution: 'Only a person cancels work (agents never set CANCELED, INV-912); the resolution goes with that move (INV-1118).', reason: 'The close reason that goes with a person\'s cancel (INV-1118); agents explain themselves in run summaries and comments.' },
};

type ActionDetails = { prerequisites: string[]; permission: string; concurrency: string; receipt: string; recovery: string; humanGate: string };
const detail = (prerequisites: string[], permission: string, concurrency: string, receipt: string, recovery: string, humanGate = 'none'): ActionDetails => ({ prerequisites, permission, concurrency, receipt, recovery, humanGate });
const DETAILS: Record<string, ActionDetails> = {
  work_update: detail(['work_get_context', 'work_catalog'], 'Write access; committed contract changes require a proposal; only Research can be completed by agents.', 'expected_revision is required by MCP.', 'Updated work and revision; refusal reason.', 'Refresh context after conflict. Reopen with an allowed nonterminal state; final acceptance stays separate.'),
  work_link: detail(['work_get_context'], 'Write both endpoints; hierarchy, repository and cycle checks.', 'Set insertion is idempotent.', 'Directed relation.', 'Read relations; work_unlink removes a wrong edge; move parents through work_update.'),
  work_unlink: detail(['work_get_context'], 'Write both endpoints; CONTAINS cannot be removed here.', 'Deleting an absent relation is idempotent.', 'removed boolean.', 'Read relations and add the corrected edge; use work_update for placement.'),
  work_comment: detail(['work_get_context'], 'Write access; comment authored by the caller.', 'Optional idempotency_key; changed content with same key refused.', 'Authored comment.', 'Reuse the same key on an uncertain response; append a correction for wrong content.'),
  work_claim: detail(['work_get_context', 'work_list_ready'], 'Committed, ready, unblocked work; approved executor when delegated.', 'Atomic lease; claim_token required to renew existing execution.', 'Lease, private claim token and suggested branch.', 'Renew before expiry or release explicitly; never reuse a revoked token.'),
  work_claim_release: detail(['work_get_context'], 'Owning execution token for agents; people can release with reason.', 'Lease identity and claim token.', 'Released claim.', 'Read context before claiming a fresh execution.'),
  run_report: detail(['work_get_context'], 'Active owning execution token.', 'Bound run and execution; completion releases the claim but permits evidence until superseded.', 'Run status and work Review transition.', 'Read run history; a completed run is not human acceptance.'),
  evidence_attach: detail(['work_get_context'], 'Owning execution token and matching work/run.', 'Optional idempotency_key.', 'Durable evidence identifier and provenance.', 'Read evidence before retry; retract incorrect evidence with a reason.'),
  evidence_retract: detail(['work_get_context'], 'Evidence author or authorized human; reason required.', 'Evidence identity; audit retains original.', 'Retraction state and reason.', 'Attach corrected evidence; never erase provenance.'),
  work_propose: detail(['work_search', 'work_get_context'], 'Propose scope and parent access; bug exception preserves direct commitment.', 'Optional idempotency_key.', 'Candidate work, or directly committed Bug / Incident under existing rules.', 'Read proposal before retry; a person decides candidates.', 'candidate'),
  work_file_bug: detail(['work_search', 'work_get_context'], 'Parent, priority, reproduction and acceptance required.', 'Optional idempotency_key.', 'Committed Bug; final acceptance remains human.', 'Read returned work and claim it; corrections obey committed-contract rules.'),
  work_commit: detail(['work_get_context'], 'Human commitment authority.', 'expected_revision.', 'Committed work.', 'Refresh candidate before retry; human undo uses work_uncommit.', 'candidate'),
  work_uncommit: detail(['work_get_context'], 'Human commitment authority and eligible undo state.', 'expected_revision.', 'Restored candidate.', 'Read context; progressed work cannot be silently uncommitted.', 'candidate'),
  work_delivery_propose: detail(['work_delivery_context'], 'Write access; proposals cannot expand authority themselves.', 'expected_revision.', 'Candidate delivery change.', 'Read delivery changes; a person approves or declines.', 'candidate'),
  work_view_save: detail(['work_views', 'work_catalog'], 'Read access to the team; TEAM visibility needs write access.', 'Pass id to update; otherwise each call creates a view.', 'The saved view.', 'Read work_views before retrying an uncertain save.'),
  work_view_delete: detail(['work_views'], 'Owner of the view, or a team owner for a shared view.', 'Deleting an absent view returns removed: false.', 'removed boolean.', 'Read work_views; recreate with work_view_save if removed by mistake.'),
  work_timeline_star: detail(['work_timeline'], 'Write access to the work.', 'Starring a starred entry keeps the first star.', 'starred entry key, starred_at, starred_by.', 'Read work_timeline(starred_only) before retrying.'),
  work_timeline_unstar: detail(['work_timeline'], 'Write access to the work.', 'Unstarring an unstarred entry returns removed: false.', 'removed boolean.', 'Star it again with work_timeline_star if removed by mistake.'),
  work_attach_file: detail(['work_get_context'], 'Write access to the work; the file is readable by whoever can read the work.', 'Each call stores a new file; attach once.', 'Attachment id and url.', 'Read Issue.attachments before retrying an uncertain upload; cite the url as artifact evidence.'),
  work_execution_create: detail(['work_delivery_context'], 'Valid candidate-approved grant and unit prerequisites.', 'expected_grant_revision; one implementation per unit/grant.', 'Implementation work.', 'Read existing unit after an uncertain result.'),
  work_executor_update: detail(['work_executor_context', 'work_delivery_context'], 'Approved executor and execution token; human reconciliation is exceptional.', 'expectedRevision, generation, effect key and receipt idempotencyKey.', 'Versioned dispatch, effect or delivery receipt.', 'Never replay unknown effects. Stop and reconcile with evidence; recover within approved budget.'),
  work_propose_amendment: detail(['work_get_context'], 'Propose an amendment; no direct rewrite of committed contract.', 'Records a contract snapshot; a newer proposal replaces the open proposal from the same actor.', 'Proposed amendment with source reason.', 'Read contractAmendments for the human decision before continuing.', 'candidate'),
  agent_request_claim: detail(['agent_inbox'], 'Only the addressed active agent may lease a request.', 'Request lease and claim_token on renewal.', 'Private claim token and leased request.', 'Renew before expiry or answer with input-required to hand control back.'),
  notification_mark_read: detail(['agent_inbox'], 'Only your own notifications.', 'Idempotent: already read stays read.', 'Notification id and read time.', 'Read agent_inbox again; an unknown id is not yours or does not exist.'),
  agent_request_needinfo: detail(['work_get_context', 'work_catalog'], 'Write access to the work; the target must be able to write on its team; an agent may raise one to a person, not to another agent.', 'One open needinfo per target and work; optional idempotency_key.', 'Request id, root comment and deadline.', 'Read work_get_context / agent_inbox before retrying; withdraw a needinfo raised by mistake.'),
  agent_request_withdraw: detail(['agent_inbox', 'work_get_context'], 'Whoever raised it; an admin with a reason.', 'CAS on an open state; a closed needinfo is refused.', 'Withdrawn request state.', 'Raise a new needinfo if it was withdrawn by mistake.'),
  agent_request_answer: detail(['agent_inbox'], 'Claim token for agent answers; human answer through UI.', 'Request lease and claim_token.', 'Authored answer and request state.', 'Read request state after uncertain response; renew or hand back the lease.'),
};

export function actionCapabilities() {
  const reverse = Object.fromEntries(Object.entries(PAIRS).map(([tool, mutation]) => [mutation, tool]));
  const mutations = Object.entries(MUTATION_SURFACES).map(([mutation, surface]) => {
    const mcpTool = reverse[mutation] ?? null;
    const exemption = MCP_EXEMPTIONS[mutation];
    const workflow = mcpTool ? DETAILS[mcpTool] : undefined;
    return { mutation, mcpTool, mcpExemption: exemption?.reason ?? null,
      web: surface.kind === 'web' ? { components: surface.components, control: surface.label ?? null } : null,
      webExemption: surface.kind === 'api-only' ? surface.reason : surface.kind === 'gap' ? surface.tracking : null,
      ...workflow, humanGate: exemption?.gate ?? workflow?.humanGate ?? null,
      fieldRenames: mcpTool ? RENAMED[mcpTool] ?? {} : {}, graphqlOnlyFields: GRAPHQL_ONLY_FIELDS[mutation] ?? {} };
  });
  return [...mutations, ...Object.entries(AGENT_ONLY_TOOLS).map(([mcpTool, reason]) => ({ mutation: null, mcpTool, mcpExemption: null, web: null, webExemption: reason, ...DETAILS[mcpTool]!, fieldRenames: RENAMED[mcpTool] ?? {}, graphqlOnlyFields: {} }))];
}
