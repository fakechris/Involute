import { MUTATION_SURFACES } from './human-surface.js';

/** MCP write tool → the GraphQL mutation a person (the web app) uses for the same change. */
export const PAIRS: Record<string, string> = {
  agent_request_answer: 'agentRequestAnswer',
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
  work_executor_update: 'executorUpdate',
};

/** MCP write tools with no GraphQL counterpart, and why. */
export const AGENT_ONLY_TOOLS: Record<string, string> = {
  agent_request_claim: 'Agents lease a request before answering it; a person answers directly (agentRequestAnswer).',
  work_propose_amendment: 'How an agent asks for a contract edit it may not make; a person edits the contract directly (issueUpdate) or decides the proposal (contractAmendmentAccept/Reject).',
};

/** MCP argument → GraphQL field when the names differ. */
export const RENAMED: Record<string, Record<string, string>> = {
  agent_request_answer: { id: 'requestId' },
  run_report: { pr_number: 'pullRequestNumber' },
  work_file_bug: { team: 'teamId' },
  work_propose: { team: 'teamId' },
  work_update: { state: 'stateId' },
  work_comment: { work_id: 'issueId' },
  work_delivery_propose: { changes: 'changesJson' },
  work_executor_update: { details: 'detailsJson' },
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
  },
};

/** These actions intentionally stay with people. New mutations need an explicit decision here. */
export const MCP_EXEMPTIONS: Record<string, { reason: string; gate: 'administration' | 'candidate' | 'final-acceptance' | 'personal' | 'deprecated' }> = {
  deliveryChangeDecide: { gate: 'candidate', reason: 'A person approves or declines changes to delivery authority.' },
  contractAmendmentAccept: { gate: 'candidate', reason: 'A person approves a proposed committed-contract amendment.' },
  contractAmendmentReject: { gate: 'candidate', reason: 'A person declines a committed-contract amendment.' },
  workReject: { gate: 'candidate', reason: 'A person declines candidate work with a reason.' },
  workRestore: { gate: 'candidate', reason: 'A person restores rejected work to the candidate queue.' },
  workReview: { gate: 'final-acceptance', reason: 'A person accepts delivery or returns it with feedback.' },
  issueCreate: { gate: 'candidate', reason: 'People create committed work; agents use work_propose or work_file_bug.' },
  issueDelete: { gate: 'administration', reason: 'Permanent deletion is a human administrative action; agent delivery preserves history.' },
  commentDelete: { gate: 'personal', reason: 'People delete their comments; agents append an attributable correction with work_comment.' },
  agentRequestReply: { gate: 'personal', reason: 'Human follow-up questions; agents answer leased requests through agent_request_answer.' },
  fileUpload: { gate: 'personal', reason: 'Browser multipart attachment upload; agents attach durable evidence URLs.' },
  notificationMarkRead: { gate: 'personal', reason: 'Human inbox read state; agent request consumption uses agent_inbox.' },
  notificationsMarkAllRead: { gate: 'personal', reason: 'Human inbox read state.' },
  notificationPreferencesUpdate: { gate: 'personal', reason: 'Human notification preferences.' },
  userUpdate: { gate: 'personal', reason: 'Human profile settings.' },
  projectCreate: { gate: 'deprecated', reason: 'Legacy Project model; use PROJECT work via work_propose.' },
  projectUpdate: { gate: 'deprecated', reason: 'Legacy Project model; use PROJECT work via work_update.' },
  projectDelete: { gate: 'deprecated', reason: 'Legacy Project model; human issueDelete handles PROJECT work.' },
};
const administration: Record<string, string[]> = {
  'Identity, credential issuance and lifecycle belong to human administrators.': ['actorDeactivate', 'actorReactivate', 'actorTransferOwner', 'actorSetSuccessor', 'agentCredentialCreate', 'agentCredentialRevoke', 'serviceActorCreate', 'userSetGlobalRole', 'userInvite', 'userInviteRevoke', 'userReactivate', 'userSuspend'],
  'Workspace and team access or membership configuration belongs to human administrators.': ['teamMembershipRemove', 'teamMembershipUpsert', 'teamTriageRotationUpdate', 'teamUpdateAccess', 'teamArchive', 'teamCreate', 'teamJoin', 'teamLeave', 'teamUnarchive', 'teamUpdate', 'workspaceSettingsUpdate', 'workShareRemove', 'workShareUpsert'],
  'Dedicated taxonomy configuration lives in Settings; agents select catalog values, and work_propose can also create named labels.': ['cycleCreate', 'cycleDelete', 'cycleUpdate', 'labelCreate', 'labelUpdate', 'labelDelete', 'workflowStateCreate', 'workflowStateUpdate', 'workflowStateDelete'],
  'Integration credentials and operational replay are administrative controls.': ['webhookCreate', 'webhookDelete', 'webhookRotateSecret', 'webhookUpdate', 'opsSyncDeadLetterClear', 'opsInboundReplay'],
};
for (const [reason, names] of Object.entries(administration)) for (const name of names) MCP_EXEMPTIONS[name] = { gate: 'administration', reason };

/** Explicit GraphQL-only inputs. No wildcard exemption: a newly added field fails coverage. */
export const GRAPHQL_ONLY_FIELDS: Record<string, Record<string, string>> = {
  agentRequestAnswer: { overrideReason: 'Human override of an agent request claim; agents must hold their claim token.' },
  bugReport: { labelIds: 'The dedicated bug tool sets Type Bug. Apply existing extra labels with work_update(label_ids), or use work_propose(labels) with the same bug rules.' },
  workLinkDelete: { id: 'MCP work_unlink selects the same edge by its directed endpoints and type.' },
  issueUpdate: { assigneeId: 'Human accountability is managed in the web UI; a claim never changes the assignee.', projectId: 'Legacy Project association; work hierarchy uses parentId on both surfaces.' },
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
  work_propose: detail(['work_search', 'work_get_context'], 'Propose scope and parent access; bug exception preserves direct commitment.', 'Optional idempotency_key.', 'Candidate work, or directly committed Bug under existing rules.', 'Read proposal before retry; a person decides candidates.', 'candidate'),
  work_file_bug: detail(['work_search', 'work_get_context'], 'Parent, priority, reproduction and acceptance required.', 'Optional idempotency_key.', 'Committed Bug; final acceptance remains human.', 'Read returned work and claim it; corrections obey committed-contract rules.'),
  work_commit: detail(['work_get_context'], 'Human commitment authority.', 'expected_revision.', 'Committed work.', 'Refresh candidate before retry; human undo uses work_uncommit.', 'candidate'),
  work_uncommit: detail(['work_get_context'], 'Human commitment authority and eligible undo state.', 'expected_revision.', 'Restored candidate.', 'Read context; progressed work cannot be silently uncommitted.', 'candidate'),
  work_delivery_propose: detail(['work_delivery_context'], 'Write access; proposals cannot expand authority themselves.', 'expected_revision.', 'Candidate delivery change.', 'Read delivery changes; a person approves or declines.', 'candidate'),
  work_execution_create: detail(['work_delivery_context'], 'Valid candidate-approved grant and unit prerequisites.', 'expected_grant_revision; one implementation per unit/grant.', 'Implementation work.', 'Read existing unit after an uncertain result.'),
  work_executor_update: detail(['work_executor_context', 'work_delivery_context'], 'Approved executor and execution token; human reconciliation is exceptional.', 'expectedRevision, generation, effect key and receipt idempotencyKey.', 'Versioned dispatch, effect or delivery receipt.', 'Never replay unknown effects. Stop and reconcile with evidence; recover within approved budget.'),
  work_propose_amendment: detail(['work_get_context'], 'Propose an amendment; no direct rewrite of committed contract.', 'Records a contract snapshot; a newer proposal replaces the open proposal from the same actor.', 'Proposed amendment with source reason.', 'Read contractAmendments for the human decision before continuing.', 'candidate'),
  agent_request_claim: detail(['agent_inbox'], 'Only the addressed active agent may lease a request.', 'Request lease and claim_token on renewal.', 'Private claim token and leased request.', 'Renew before expiry or answer with input-required to hand control back.'),
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
