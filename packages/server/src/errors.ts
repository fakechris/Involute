import { DELIVERY_VALIDATION_MESSAGES } from './delivery-error-messages.js';
import { GraphQLError } from 'graphql';

export const NOT_AUTHENTICATED_MESSAGE = 'Not authenticated';
export const TEAM_NOT_FOUND_MESSAGE = 'Team not found.';
export const ISSUE_NOT_FOUND_MESSAGE = 'Issue not found.';
export const COMMENT_NOT_FOUND_MESSAGE = 'Comment not found.';
export const COMMENT_PARENT_ISSUE_MISMATCH_MESSAGE =
  'Parent comment belongs to a different work item.';
export const MEMBERSHIP_NOT_FOUND_MESSAGE = 'Team membership not found.';
export const WORKFLOW_STATE_NOT_FOUND_MESSAGE = 'Workflow state not found.';
export const ISSUE_LABEL_NOT_FOUND_MESSAGE = 'One or more issue labels were not found.';
export const ASSIGNEE_NOT_FOUND_MESSAGE = 'Assignee not found.';
export const PROJECT_SCOPE_NOT_FOUND_MESSAGE = 'Project scope not found.';
export const PROJECT_SCOPE_CONFLICT_MESSAGE = 'Project selectors conflict.';
export const PROJECT_SCOPE_AMBIGUOUS_MESSAGE = 'Project scope is ambiguous.';
export const PROJECT_NOT_FOUND_MESSAGE = 'Project not found in the issue team.';
export const CYCLE_NOT_FOUND_MESSAGE = 'Cycle not found in the issue team.';
export const TEAM_OWNER_REQUIRED_MESSAGE = 'Each team must retain at least one owner.';
export const PARENT_ISSUE_NOT_FOUND_MESSAGE = 'Parent issue not found.';
export const PARENT_ISSUE_TEAM_MISMATCH_MESSAGE =
  'Parent issue does not belong to the issue team.';
export const PARENT_ISSUE_SELF_REFERENCE_MESSAGE = 'Issue cannot be its own parent.';
export const PARENT_ISSUE_CYCLE_MESSAGE = 'Issue parent relationship cannot create a cycle.';
export const WORKFLOW_STATE_TEAM_CREATE_MISMATCH_MESSAGE =
  'Workflow state does not belong to the specified team.';
export const WORKFLOW_STATE_TEAM_UPDATE_MISMATCH_MESSAGE =
  'Workflow state does not belong to the issue team.';
export const TEAM_HAS_NO_WORKFLOW_STATES_MESSAGE =
  'The selected team does not have any workflow states.';
export const TEAM_WRITE_FORBIDDEN_MESSAGE = 'You do not have edit access to this team.';
export const TEAM_MANAGE_FORBIDDEN_MESSAGE = 'You do not have access to manage this team.';
export const TEAM_ROSTER_HUMANS_ONLY_MESSAGE =
  'Team membership is a human roster. An agent or service is bound to a team by its credential, not by a membership role.';
export const ACTOR_MANAGE_FORBIDDEN_MESSAGE =
  'You do not have access to manage this actor: only an admin or its owner may. Owning a team it is bound to lets you revoke that team\'s credential, nothing more.';
export const WORK_LINK_NOT_FOUND_MESSAGE = 'Work link not found.';
export const WORK_LINK_SELF_REFERENCE_MESSAGE = 'Work cannot link to itself.';
export const WORK_LINK_CYCLE_MESSAGE = 'Work link cannot create a cycle.';
export const WORK_LINK_TEAM_MISMATCH_MESSAGE = 'Work links must stay within the same team.';
export const WORK_LINK_ENDPOINT_NOT_FOUND_MESSAGE = 'Work link endpoint not found.';
export const WORK_COMMIT_FORBIDDEN_MESSAGE = 'Agents cannot commit work.';
export const WORK_REJECT_FORBIDDEN_MESSAGE = 'Agents cannot reject work.';
export const WORK_ACCEPT_FORBIDDEN_MESSAGE = 'Agents cannot accept or cancel work.';
export const WORK_CONTRACT_UPDATE_FORBIDDEN_MESSAGE =
  'Agents cannot rewrite committed contract fields. Propose the change with work_propose_amendment (fields plus a reason); a person accepts or rejects it in one click under Contract on the issue page (/issue/<id>#contract).';
export const CONTRACT_AMENDMENT_AGENTS_ONLY_MESSAGE =
  'A person edits a committed contract directly under Contract on the issue page; an amendment is how an agent asks for that edit.';
export const CONTRACT_AMENDMENT_REQUIRES_COMMITTED_MESSAGE =
  "Only committed work takes a contract amendment; a candidate's contract is edited with work_update.";
export const CONTRACT_AMENDMENT_FIELDS_MESSAGE =
  'An amendment changes one or more of acceptance, scope, verification, outcome and constraints, each to a string or null.';
export const CONTRACT_AMENDMENT_REASON_REQUIRED_MESSAGE = 'An amendment needs a reason: what is wrong with the current contract.';
export const CONTRACT_AMENDMENT_NO_CHANGE_MESSAGE = 'The proposed values are the same as the current contract.';
export const CONTRACT_AMENDMENT_NOT_FOUND_MESSAGE = 'Contract amendment not found.';
export const CONTRACT_AMENDMENT_HUMAN_ONLY_MESSAGE = 'Only a person may accept or reject a contract amendment.';
export const CONTRACT_AMENDMENT_ALREADY_DECIDED_MESSAGE = 'This amendment was already decided or replaced by a newer one.';
export const CONTRACT_AMENDMENT_STALE_MESSAGE =
  'The contract changed since this amendment was proposed. Compare it with the current contract, then edit the contract directly or reject the amendment.';
export const CONTRACT_AMENDMENT_REJECT_NOTE_REQUIRED_MESSAGE = 'Rejecting an amendment needs a note, so the agent learns why.';
export const WORK_NOT_CANDIDATE_MESSAGE = 'Only candidate work can be committed or rejected.';
export const WORK_NOT_COMMITTED_MESSAGE = 'Only committed work can be claimed.';
export const WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE =
  'Committed work requires acceptance criteria.';
export const WORK_COMMIT_REQUIRES_OWNER_MESSAGE = 'Committed work requires a human owner.';
export const WORK_COMMIT_REQUIRES_PARENT_MESSAGE =
  'Committed work requires a parent: place it under a PROJECT, MILESTONE, EPIC or parent ISSUE (CONTAINS) before committing, or pass parentId with the commit.';
export const WORK_COMMIT_PARENT_REJECTED_MESSAGE = 'The parent of committed work cannot be rejected work.';
// Hierarchy rules (graph-integrity.ts), exposed so mutations can say why.
export const CONTAINS_KINDS_MESSAGE =
  'CONTAINS allows PROJECT → MILESTONE/DECISION/EPIC/ISSUE, MILESTONE → EPIC/ISSUE, EPIC → ISSUE, ISSUE → ISSUE.';
export const CONTAINS_REPOSITORY_REQUIRED_MESSAGE = 'CONTAINS requires an explicit repository on both endpoints.';
export const CONTAINS_REPOSITORY_WHITESPACE_MESSAGE = 'CONTAINS repository values must not have surrounding whitespace.';
export const CONTAINS_CROSS_REPOSITORY_MESSAGE = 'CONTAINS cannot cross repository boundaries.';
export const CONTAINS_MULTIPLE_PARENTS_MESSAGE = 'CONTAINS cannot have multiple parents; use an explicit parent update.';
export const HIERARCHY_PARENT_MISSING_MESSAGE = 'Hierarchy parent does not exist.';
export const ISSUE_TYPE_EXCLUSIVE_MESSAGE = 'An item has at most one Type: Bug, Feature, Improvement or Research.';
export const RESEARCH_CLOSE_NOT_ISSUE_MESSAGE = 'Only an ISSUE with Type: Research can be closed by an agent; a person accepts everything else.';
export const RESEARCH_CLOSE_NOT_COMMITTED_MESSAGE = 'A research item an agent closes must be committed first: a person commits it, then the agent may move it to Done.';
export const RESEARCH_CLOSE_CLAIMED_MESSAGE = 'Another actor holds the claim on this research item; it closes when that claim ends or by its holder.';
export const RESEARCH_CLOSE_NO_DOWNSTREAM_MESSAGE = 'Research closes once it led somewhere: propose its actionable points (ISSUE) or "won\'t do" decisions (DECISION) DERIVED_FROM it, or state "无可执行点" / "no actionable points" in its description, then close it (INV-1001).';
export const RESEARCH_INITIAL_DONE_ONLY_MESSAGE = 'initial_state DONE is only for an ISSUE labelled research (Type: Research); it lands in Done when a person commits it. Other work stops at In Review.';
export const BUG_REPORT_PRIORITY_REQUIRED_MESSAGE = 'A bug report needs a priority (Urgent, High, Medium or Low).';
export const BUG_REPORT_STEPS_REQUIRED_MESSAGE = 'A bug report needs steps to reproduce.';
export const BUG_COMMIT_PRIORITY_REQUIRED_MESSAGE = 'Committing a bug needs a priority (Urgent, High, Medium or Low): it sets the SLA.';
export const FIXED_BUG_EVIDENCE_REQUIRED_MESSAGE =
  'Filing a fixed bug into Review needs its evidence: pass commit_sha, pr_number or evidence_url (INV-997).';
export const FIXED_BUG_EVIDENCE_WITHOUT_REVIEW_MESSAGE =
  'commit_sha, pr_number and evidence_url describe a fix already made: pass initial_state REVIEW with them, or leave them out.';
export const PROPOSE_PRIORITY_RANGE_MESSAGE =
  'Priority must be 0 (none), 1 (Urgent), 2 (High), 3 (Medium) or 4 (Low).';
export const BUG_PROPOSE_PRIORITY_REQUIRED_MESSAGE = 'Proposing a bug needs a priority (Urgent, High, Medium or Low): it sets the SLA.';
export const BUG_PROPOSE_PARENT_REQUIRED_MESSAGE =
  'A bug is committed directly (it does not go to Candidates): pass parent_id, or related_work_id so it can inherit a parent.';
export const BUG_PROPOSE_ACCEPTANCE_REQUIRED_MESSAGE =
  'A bug needs acceptance: what must be true when it is fixed. It is committed on filing and agents cannot add acceptance later, so without it nobody could claim it.';
export const BUG_PROPOSE_STEPS_REQUIRED_MESSAGE =
  'A bug is committed directly (it does not go to Candidates): pass steps_to_reproduce.';
export const BUG_PROPOSE_OWNER_REQUIRED_MESSAGE =
  'A bug is committed directly (it does not go to Candidates): the filing agent needs a human owner on this team.';
export const BUG_REJECT_REASON_REQUIRED_MESSAGE = 'Declining a bug needs a reason (zero-bug: fix it or say why not).';
export const WORK_REJECT_RESOLUTION_REQUIRED_MESSAGE =
  'Rejecting a candidate needs a resolution: completed, wont_do, invalid, duplicate, cannot_reproduce or obsolete.';
export const WORK_CANCEL_RESOLUTION_REQUIRED_MESSAGE =
  'Canceling work needs a resolution: completed, wont_do, invalid, duplicate, cannot_reproduce or obsolete.';
export const BUG_CANCEL_REASON_REQUIRED_MESSAGE = 'Canceling a bug needs a reason (zero-bug: fix it or say why not).';
export const WORK_RESOLUTION_INVALID_MESSAGE =
  'Unknown resolution. Use completed, wont_do, invalid, duplicate, cannot_reproduce or obsolete.';
export const WORK_RESOLUTION_NOT_CLOSING_MESSAGE =
  'A resolution says why work was closed: set it when moving the work to a Canceled state (or when rejecting a candidate).';
export const BUG_NO_BACKLOG_MESSAGE = 'Bugs do not go to the backlog (zero-bug): commit to fixing it, or decline it with a reason.';
export const TRIAGE_ROTATION_INVALID_MESSAGE = 'A triage rotation lists human members of the team and a valid start date.';
export const CLAIM_RELEASE_FORBIDDEN_MESSAGE = 'Only a person can release a claim.';
export const ACTOR_LIFECYCLE_HUMAN_ONLY_MESSAGE =
  'Only a human may deactivate or reactivate an actor, transfer its ownership, or declare its successor.';
export const REQUEST_ANSWER_STATE_INVALID_MESSAGE = 'An answer state is completed, failed or input-required.';
export const ACTOR_SUCCESSOR_INVALID_MESSAGE = 'A successor is another active actor, not the actor itself.';
export const WORK_RESTORE_FORBIDDEN_MESSAGE = 'Only a person can restore a rejected candidate.';
export const WORK_UNCOMMIT_FORBIDDEN_MESSAGE = 'Only a person can return committed work to the candidate queue.';
export const WORK_UNCOMMIT_NOT_COMMITTED_MESSAGE = 'Only committed work can be returned to the candidate queue.';
export const WORK_UNCOMMIT_CLAIMED_MESSAGE = 'This work is leased. Release the claim before returning it to candidates.';
export const WORK_UNCOMMIT_RUN_MESSAGE = 'This work already has a run. It stays committed.';
export const WORK_UNCOMMIT_NO_SNAPSHOT_MESSAGE = 'This commit has no snapshot to reverse.';
export const WORK_RESTORE_NOT_REJECTED_MESSAGE = 'Only rejected work can be restored to a candidate.';
export const WORK_RESTORE_REASON_REQUIRED_MESSAGE = 'Restoring rejected work needs a reason.';
export const CLAIM_RELEASE_REASON_REQUIRED_MESSAGE = 'Releasing a claim needs a reason; the agent and its owner are told.';
export const CLAIM_RELEASE_NO_CLAIM_MESSAGE = 'This work has no claim to release.';
export const ISSUE_CREATE_REQUIRES_PARENT_MESSAGE =
  'New work requires a parent: choose its project (No milestone), a MILESTONE, EPIC or parent ISSUE. Only a PROJECT is created without one.';
export const WORK_COMMIT_PARENT_CONFLICT_MESSAGE =
  'This candidate already has a different parent; move it with an explicit parent update instead of passing another parentId at commit.';
export const WORK_OWNER_MUST_BE_HUMAN_MESSAGE = 'Work owner must be a human assignee.';
export const WORK_OWNER_MUST_BELONG_TO_TEAM_MESSAGE = 'Work owner must belong to the work team.';
export const WORK_READY_STATE_MISSING_MESSAGE = 'Team workflow is missing an unstarted state.';
export const WORK_REVISION_CONFLICT_MESSAGE = 'Work revision does not match expected_revision.';
export const WORK_IDEMPOTENCY_CONFLICT_MESSAGE =
  'Idempotency key was already used with a different request.';
export const WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE =
  'Idempotent operation result is no longer available.';
export const WORK_ALREADY_CLAIMED_MESSAGE = 'Work is already claimed.';
export const WORK_NOT_READY_MESSAGE = 'Work is not ready to be claimed.';
// Why it is not ready, and what to do about it (INV-808): one generic refusal
// left agents guessing — a Backlog item looked unclaimable when one work_update
// would have made it ready.
export const WORK_NOT_READY_STATE_MESSAGE =
  'Work is not ready to be claimed: it is not in Ready or In Progress (for example it is in Backlog). Move it to Ready first: MCP work_update with state "UNSTARTED", or the state menu in the web app.';
export const WORK_NOT_READY_ACCEPTANCE_MESSAGE =
  'Work is not ready to be claimed: it has no acceptance criteria. Add them first (work_update acceptance).';
export const WORK_NOT_READY_OWNER_MESSAGE =
  'Work is not ready to be claimed: it is not assigned to a person. Assign it in the web app first.';
export const WORK_NOT_READY_BLOCKED_MESSAGE =
  'Work is not ready to be claimed: an open item blocks it. Finish the blocker, or remove the BLOCKS link if it no longer applies.';
export const WORK_NOT_READY_LABEL_MESSAGE =
  'Work is not ready to be claimed: it carries the "blocked" or "needs-clarification" label. Remove the label once it is resolved.';
export const WORK_CLAIM_REQUIRES_ACTOR_MESSAGE = 'Claiming work requires an authenticated actor.';
export const WORK_RELATED_NOT_FOUND_MESSAGE = 'Related work not found.';
export const WORK_RUN_NOT_FOUND_MESSAGE =
  'Work run not found. To start a new run, omit run_id (the server assigns RUN-N automatically). Only pass run_id when updating an existing run.';
export const WORK_EVIDENCE_KIND_INVALID_MESSAGE = 'Unknown evidence kind.';
export const WORK_RUN_STATUS_INVALID_MESSAGE = 'Unknown run status.';
export const WORK_RUN_REQUIRES_ACTIVE_CLAIM_MESSAGE =
  'Reporting a run requires an active claim owned by the current actor.';
export const WORK_RUN_ACTOR_MISMATCH_MESSAGE = 'Only the run actor can update this run.';
export const WORK_RUN_TERMINAL_MESSAGE = 'Completed or failed runs cannot be changed.';
export const WORK_RUN_TERMINAL_REPLAY_MESSAGE =
  'This run is already completed or failed. Only a proven idempotent replay (same idempotencyKey, identical content) is accepted; anything else is refused rather than silently dropped. Attach further evidence with evidence_attach, or comment on the work item.';
export const WORK_RUN_TRANSITION_INVALID_MESSAGE = 'Invalid work run status transition.';
export const WORK_RUN_CONFLICT_MESSAGE = 'Work run changed while the update was in progress.';
export const WORK_EVIDENCE_REQUIRES_RUN_MESSAGE = 'Evidence must reference a work run.';
export const WORK_REVIEW_REQUIRED_MESSAGE = 'Work is not awaiting review.';
export const WORK_REVIEW_STATE_MISSING_MESSAGE = 'Team workflow is missing a required semantic state.';
export const UPLOAD_TOO_LARGE_MESSAGE = 'Upload exceeds the 10 MB size limit.';
export const WEBHOOK_NOT_FOUND_MESSAGE = 'Webhook subscription not found.';
export const WEBHOOK_URL_INVALID_MESSAGE = 'Webhook URL must be a valid absolute http(s) URL.';
export const WEBHOOK_EVENT_TYPE_INVALID_MESSAGE = 'Unknown webhook event type.';
export const WEBHOOK_AGENT_NOT_FOUND_MESSAGE = 'No active agent with that handle or id; a push channel must name an agent.';
export const AGENT_SCOPE_INVALID_MESSAGE = 'Unknown agent scope.';
export const INVITE_FORBIDDEN_MESSAGE = "Only admins can invite people, unless an admin allows members to invite (Settings → Administration → Security).";
export const INVITE_ADMIN_FORBIDDEN_MESSAGE = "Only an admin can invite someone as an admin.";
export const INVITE_EMAIL_INVALID_MESSAGE = "An invite needs a valid email address.";
export const INVITE_ALREADY_MEMBER_MESSAGE = "This person is already in the workspace. Add them to a team from the team's Members page.";
export const INVITE_NOT_PENDING_MESSAGE = "Only a pending invite can be revoked. To stop someone who has signed in, suspend them.";
export const GUEST_CANNOT_OWN_TEAM_MESSAGE = "A guest cannot be a team owner.";
export const GUEST_HAS_TEAM_OWNERSHIP_MESSAGE = "This person owns a team. Hand the team to another owner before making them a guest.";
export const USER_SUSPEND_HUMANS_ONLY_MESSAGE = "Only people are suspended. Deactivate an agent from its page.";
export const USER_ALREADY_SUSPENDED_MESSAGE = "This person is already suspended.";
export const USER_NOT_SUSPENDED_MESSAGE = "This person is not suspended.";
export const USER_SUSPEND_SELF_MESSAGE = "You cannot suspend yourself.";
export const WORKSPACE_DOMAIN_INVALID_MESSAGE = "Approved domains must look like example.com.";
export const WORKSPACE_DEFAULT_TEAM_INVALID_MESSAGE = "A default team does not exist.";
export const TEAM_CREATE_FORBIDDEN_MESSAGE = "Only admins can create teams, unless an admin allows members to (Settings → Administration → Security).";
export const TEAM_KEY_FORMAT_MESSAGE = "A team key is 2 to 10 letters, such as INV. It becomes the prefix of every identifier and cannot change.";
export const TEAM_KEY_TAKEN_MESSAGE = "That key is already a team key or a project alias.";
export const TEAM_NAME_REQUIRED_MESSAGE = "A team needs a name.";
export const TEAM_ARCHIVED_MESSAGE = "This team is archived and read-only. An owner can unarchive it.";
export const TEAM_JOIN_FORBIDDEN_MESSAGE = "Only public teams can be joined; private teams add people from their Members page.";
export const TEAM_NOT_A_MEMBER_MESSAGE = "You are not a member of this team.";
export const TEAM_LAST_OWNER_LEAVE_MESSAGE = "You are this team's last owner. Make someone else an owner before leaving.";
export const WORK_SHARE_NOT_PROJECT_MESSAGE = 'Only a PROJECT node can be shared; share the project that contains this work.';
export const WORK_SHARE_NOT_FOUND_MESSAGE = 'Share not found.';
export const WORK_SHARE_SELF_MESSAGE = 'You cannot share a project with yourself.';
export const AGENT_EMAIL_INVALID_MESSAGE = 'Agent email must look like an email address (name@host).';
export const AGENT_HANDLE_INVALID_MESSAGE = 'Agent handle must be 1–32 characters of a-z, 0-9, _ or -, starting with a letter or digit.';
export const AGENT_HANDLE_TAKEN_MESSAGE = 'That handle already belongs to another actor.';
export const AGENT_CREDENTIAL_NOT_FOUND_MESSAGE = 'Agent credential not found.';
export const REQUEST_NOT_FOUND_MESSAGE = 'Request not found.';
export const NOTIFICATION_NOT_FOUND_MESSAGE = 'Notification not found.';
export const SNOOZE_REQUIRES_CANDIDATE_MESSAGE = 'Only candidate work can be snoozed.';
export const AGENT_DESCRIPTION_REQUIRED_MESSAGE =
  "Agent proposals require a rich structured Chinese description with three sections: '### 1. 目标与架构定位', '### 2. 核心功能与交付范围', and '### 3. 验收标准与验证方案'. Lazy references (e.g. 'ref docs/...') are strictly rejected.";
// Dynamic IQL failures carry this prefix; getExposedError lets them through so
// agents see exactly which term failed to parse.
export const IQL_PARSE_ERROR_PREFIX = 'Invalid IQL query:';

// Project reference alias (INV-793): the prefix PRs may use instead of the team key.
export const PROJECT_ALIAS_FORMAT_MESSAGE = 'A project alias is 2 to 10 letters, such as LUM.';
export const PROJECT_ALIAS_KIND_MESSAGE = 'Only a PROJECT can have a reference alias.';
export const PROJECT_ALIAS_TAKEN_MESSAGE = 'That alias is already a team key or another project\'s alias.';

// Workspace settings (INV-797).
export const SETTINGS_ADMIN_ONLY_MESSAGE = 'Workspace settings can be changed by admins only.';
export const LABEL_NOT_FOUND_MESSAGE = 'Label not found.';
export const LABEL_NAME_INVALID_MESSAGE = 'A label name is 1 to 50 characters.';
export const LABEL_NAME_TAKEN_MESSAGE = 'A label with that name already exists (names ignore case).';
export const LABEL_PROTECTED_MESSAGE =
  'Bug, Feature, Improvement and research are built in: the Type group and the research rules depend on them, so they cannot be renamed or deleted.';
export const LABEL_TYPE_NAME_RESERVED_MESSAGE = 'Bug, Feature and Improvement are the Type labels; another label cannot take those names.';
export const USER_NOT_FOUND_MESSAGE = 'User not found.';
export const WORKFLOW_STATE_NAME_INVALID_MESSAGE = 'A state name is 1 to 40 characters and unique within its team.';
export const WORKFLOW_STATE_IN_USE_MESSAGE = 'This state still holds work; move that work to another state first.';
export const WORKFLOW_STATE_LAST_OF_TYPE_MESSAGE =
  'Each team keeps at least one state of every type: agents and GitHub move work by type, not by name.';
export const GLOBAL_ROLE_TARGET_HUMAN_MESSAGE = 'Admin rights go to people; agents and services act through their credentials.';
export const GLOBAL_ROLE_LAST_ADMIN_MESSAGE = 'The workspace needs at least one admin.';

// The ops page (INV-796).
export const OPS_ADMIN_ONLY_MESSAGE = 'The ops page and its actions are for workspace admins.';
export const OPS_REASON_REQUIRED_MESSAGE = 'Say why, in 1 to 2000 characters: it is kept on the ops audit.';
export const OPS_DEAD_LETTER_NOT_FOUND_MESSAGE = 'That sync dead letter no longer exists; it may already have been cleared.';
export const OPS_INBOUND_NOT_REPLAYABLE_MESSAGE =
  'Only a dead inbound delivery that still has its payload can be replayed, and it changed since the page loaded; refresh and try again.';

// needinfo (INV-1119)
export const NEEDINFO_QUESTION_REQUIRED_MESSAGE = 'A needinfo needs a question: say what you need to know.';
export const NEEDINFO_TARGET_NOT_FOUND_MESSAGE = 'No active person or agent matches that target (id, @handle or email).';
export const NEEDINFO_TARGET_SELF_MESSAGE = 'You cannot raise a needinfo to yourself.';
export const NEEDINFO_TARGET_SERVICE_MESSAGE = 'A service actor cannot answer questions; choose a person or an agent.';
export const NEEDINFO_AGENT_TO_AGENT_MESSAGE =
  'One agent cannot raise a needinfo to another (docs/54 §C keeps a person at the head of every chain of questions); address the agent\'s owner instead.';
export const NEEDINFO_TARGET_CANNOT_ANSWER_MESSAGE =
  'That target cannot write on this team, so they could not answer here. Choose someone who is an editor or owner of the team (or an agent with the answer scope).';
export const NEEDINFO_ALREADY_OPEN_MESSAGE = 'There is already an open needinfo to that target on this work; wait for it or withdraw it first.';
export const NEEDINFO_NOT_A_NEEDINFO_MESSAGE = 'This request is not a needinfo; only a needinfo can be withdrawn.';
export const NEEDINFO_WITHDRAW_NOT_REQUESTER_MESSAGE =
  'Only whoever raised this needinfo can withdraw it; an admin can withdraw it with a reason.';
export const NEEDINFO_WITHDRAW_REASON_REQUIRED_MESSAGE = 'Withdrawing someone else\'s needinfo requires a reason.';

export const NEEDINFO_CLOSED_MESSAGE = 'This needinfo is already answered, withdrawn or expired.';
export const NEEDINFO_IDEMPOTENCY_MISMATCH_MESSAGE = 'That idempotency key was used for a different request; do not replay it.';

export function createScopeForbiddenError(scope: string): GraphQLError {
  return new GraphQLError(`Agent credential lacks required scope: ${scope}.`, {
    extensions: { code: 'FORBIDDEN' },
  });
}

const exposedErrorCodes = new Map<string, string>([
  ...DELIVERY_VALIDATION_MESSAGES.map((message): [string, string] => [message, 'BAD_USER_INPUT']),
  [NOT_AUTHENTICATED_MESSAGE, 'UNAUTHENTICATED'],
  [TEAM_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [ISSUE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [REQUEST_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [COMMENT_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [COMMENT_PARENT_ISSUE_MISMATCH_MESSAGE, 'BAD_USER_INPUT'],
  [MEMBERSHIP_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORKFLOW_STATE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [ISSUE_LABEL_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [ASSIGNEE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [PROJECT_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [PROJECT_SCOPE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [PROJECT_SCOPE_CONFLICT_MESSAGE, 'PROJECT_SCOPE_CONFLICT'],
  [PROJECT_SCOPE_AMBIGUOUS_MESSAGE, 'PROJECT_SCOPE_AMBIGUOUS'],
  [CYCLE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [TEAM_OWNER_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [PARENT_ISSUE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [PARENT_ISSUE_TEAM_MISMATCH_MESSAGE, 'BAD_USER_INPUT'],
  [PARENT_ISSUE_SELF_REFERENCE_MESSAGE, 'BAD_USER_INPUT'],
  [PARENT_ISSUE_CYCLE_MESSAGE, 'BAD_USER_INPUT'],
  [WORKFLOW_STATE_TEAM_CREATE_MISMATCH_MESSAGE, 'BAD_USER_INPUT'],
  [WORKFLOW_STATE_TEAM_UPDATE_MISMATCH_MESSAGE, 'BAD_USER_INPUT'],
  [TEAM_HAS_NO_WORKFLOW_STATES_MESSAGE, 'BAD_USER_INPUT'],
  [TEAM_WRITE_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [TEAM_MANAGE_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [ACTOR_MANAGE_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [WORK_LINK_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORK_LINK_SELF_REFERENCE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_LINK_CYCLE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_LINK_TEAM_MISMATCH_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_LINK_ENDPOINT_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORK_COMMIT_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [WORK_REJECT_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [WORK_ACCEPT_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [WORK_CONTRACT_UPDATE_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [CONTRACT_AMENDMENT_AGENTS_ONLY_MESSAGE, 'BAD_USER_INPUT'],
  [CONTRACT_AMENDMENT_REQUIRES_COMMITTED_MESSAGE, 'BAD_USER_INPUT'],
  [CONTRACT_AMENDMENT_FIELDS_MESSAGE, 'BAD_USER_INPUT'],
  [CONTRACT_AMENDMENT_REASON_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [CONTRACT_AMENDMENT_NO_CHANGE_MESSAGE, 'BAD_USER_INPUT'],
  [CONTRACT_AMENDMENT_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [CONTRACT_AMENDMENT_HUMAN_ONLY_MESSAGE, 'BAD_USER_INPUT'],
  [CONTRACT_AMENDMENT_ALREADY_DECIDED_MESSAGE, 'BAD_USER_INPUT'],
  [CONTRACT_AMENDMENT_STALE_MESSAGE, 'BAD_USER_INPUT'],
  [CONTRACT_AMENDMENT_REJECT_NOTE_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_NOT_CANDIDATE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_NOT_COMMITTED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_COMMIT_REQUIRES_OWNER_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_COMMIT_REQUIRES_PARENT_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_COMMIT_PARENT_REJECTED_MESSAGE, 'BAD_USER_INPUT'],
  [ISSUE_CREATE_REQUIRES_PARENT_MESSAGE, 'BAD_USER_INPUT'],
  [ISSUE_TYPE_EXCLUSIVE_MESSAGE, 'BAD_USER_INPUT'],
  [CLAIM_RELEASE_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [WORK_RESTORE_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [WORK_UNCOMMIT_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [WORK_UNCOMMIT_NOT_COMMITTED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_UNCOMMIT_CLAIMED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_UNCOMMIT_RUN_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_UNCOMMIT_NO_SNAPSHOT_MESSAGE, 'BAD_USER_INPUT'],
  [ACTOR_LIFECYCLE_HUMAN_ONLY_MESSAGE, 'FORBIDDEN'],
  [ACTOR_SUCCESSOR_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [REQUEST_ANSWER_STATE_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RESTORE_NOT_REJECTED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RESTORE_REASON_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [CLAIM_RELEASE_REASON_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [CLAIM_RELEASE_NO_CLAIM_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_COMMIT_PRIORITY_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [PROPOSE_PRIORITY_RANGE_MESSAGE, 'BAD_USER_INPUT'],
  [FIXED_BUG_EVIDENCE_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [FIXED_BUG_EVIDENCE_WITHOUT_REVIEW_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_PROPOSE_PRIORITY_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_PROPOSE_PARENT_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_PROPOSE_STEPS_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_PROPOSE_ACCEPTANCE_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_PROPOSE_OWNER_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_REJECT_REASON_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_NO_BACKLOG_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_REJECT_RESOLUTION_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_CANCEL_RESOLUTION_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_CANCEL_REASON_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RESOLUTION_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RESOLUTION_NOT_CLOSING_MESSAGE, 'BAD_USER_INPUT'],
  [RESEARCH_CLOSE_NOT_ISSUE_MESSAGE, 'FORBIDDEN'],
  [RESEARCH_CLOSE_NOT_COMMITTED_MESSAGE, 'FORBIDDEN'],
  [RESEARCH_CLOSE_CLAIMED_MESSAGE, 'FORBIDDEN'],
  [RESEARCH_CLOSE_NO_DOWNSTREAM_MESSAGE, 'FORBIDDEN'],
  [RESEARCH_INITIAL_DONE_ONLY_MESSAGE, 'BAD_USER_INPUT'],
  [TRIAGE_ROTATION_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_REPORT_PRIORITY_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_REPORT_STEPS_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [CONTAINS_KINDS_MESSAGE, 'BAD_USER_INPUT'],
  [CONTAINS_REPOSITORY_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [CONTAINS_REPOSITORY_WHITESPACE_MESSAGE, 'BAD_USER_INPUT'],
  [CONTAINS_CROSS_REPOSITORY_MESSAGE, 'BAD_USER_INPUT'],
  [CONTAINS_MULTIPLE_PARENTS_MESSAGE, 'BAD_USER_INPUT'],
  [HIERARCHY_PARENT_MISSING_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_COMMIT_PARENT_CONFLICT_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_OWNER_MUST_BE_HUMAN_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_OWNER_MUST_BELONG_TO_TEAM_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_READY_STATE_MISSING_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_REVISION_CONFLICT_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_IDEMPOTENCY_CONFLICT_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_ALREADY_CLAIMED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_NOT_READY_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_NOT_READY_STATE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_NOT_READY_ACCEPTANCE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_NOT_READY_OWNER_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_NOT_READY_BLOCKED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_NOT_READY_LABEL_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_CLAIM_REQUIRES_ACTOR_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RELATED_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORK_RUN_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORK_EVIDENCE_KIND_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RUN_STATUS_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RUN_REQUIRES_ACTIVE_CLAIM_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RUN_ACTOR_MISMATCH_MESSAGE, 'FORBIDDEN'],
  [WORK_RUN_TERMINAL_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RUN_TRANSITION_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RUN_CONFLICT_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_EVIDENCE_REQUIRES_RUN_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_REVIEW_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_REVIEW_STATE_MISSING_MESSAGE, 'BAD_USER_INPUT'],
  [UPLOAD_TOO_LARGE_MESSAGE, 'BAD_USER_INPUT'],
  [WEBHOOK_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WEBHOOK_URL_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WEBHOOK_AGENT_NOT_FOUND_MESSAGE, 'BAD_USER_INPUT'],
  [WEBHOOK_EVENT_TYPE_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [AGENT_SCOPE_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [AGENT_EMAIL_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_SHARE_NOT_PROJECT_MESSAGE, 'BAD_USER_INPUT'],
  [TEAM_CREATE_FORBIDDEN_MESSAGE, 'BAD_USER_INPUT'],
  [TEAM_KEY_FORMAT_MESSAGE, 'BAD_USER_INPUT'],
  [TEAM_KEY_TAKEN_MESSAGE, 'BAD_USER_INPUT'],
  [TEAM_NAME_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [TEAM_ARCHIVED_MESSAGE, 'BAD_USER_INPUT'],
  [TEAM_JOIN_FORBIDDEN_MESSAGE, 'BAD_USER_INPUT'],
  [TEAM_NOT_A_MEMBER_MESSAGE, 'BAD_USER_INPUT'],
  [TEAM_LAST_OWNER_LEAVE_MESSAGE, 'BAD_USER_INPUT'],
  [INVITE_FORBIDDEN_MESSAGE, 'BAD_USER_INPUT'],
  [INVITE_ADMIN_FORBIDDEN_MESSAGE, 'BAD_USER_INPUT'],
  [INVITE_EMAIL_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [INVITE_ALREADY_MEMBER_MESSAGE, 'BAD_USER_INPUT'],
  [INVITE_NOT_PENDING_MESSAGE, 'BAD_USER_INPUT'],
  [GUEST_CANNOT_OWN_TEAM_MESSAGE, 'BAD_USER_INPUT'],
  [GUEST_HAS_TEAM_OWNERSHIP_MESSAGE, 'BAD_USER_INPUT'],
  [USER_SUSPEND_HUMANS_ONLY_MESSAGE, 'BAD_USER_INPUT'],
  [USER_ALREADY_SUSPENDED_MESSAGE, 'BAD_USER_INPUT'],
  [USER_NOT_SUSPENDED_MESSAGE, 'BAD_USER_INPUT'],
  [USER_SUSPEND_SELF_MESSAGE, 'BAD_USER_INPUT'],
  [WORKSPACE_DOMAIN_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WORKSPACE_DEFAULT_TEAM_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_SHARE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORK_SHARE_SELF_MESSAGE, 'BAD_USER_INPUT'],
  [AGENT_HANDLE_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [AGENT_HANDLE_TAKEN_MESSAGE, 'BAD_USER_INPUT'],
  [AGENT_CREDENTIAL_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [NOTIFICATION_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [SNOOZE_REQUIRES_CANDIDATE_MESSAGE, 'BAD_USER_INPUT'],
  [AGENT_DESCRIPTION_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [PROJECT_ALIAS_FORMAT_MESSAGE, 'BAD_USER_INPUT'],
  [PROJECT_ALIAS_KIND_MESSAGE, 'BAD_USER_INPUT'],
  [PROJECT_ALIAS_TAKEN_MESSAGE, 'BAD_USER_INPUT'],
  [SETTINGS_ADMIN_ONLY_MESSAGE, 'FORBIDDEN'],
  [LABEL_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [LABEL_NAME_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [LABEL_NAME_TAKEN_MESSAGE, 'BAD_USER_INPUT'],
  [LABEL_PROTECTED_MESSAGE, 'BAD_USER_INPUT'],
  [LABEL_TYPE_NAME_RESERVED_MESSAGE, 'BAD_USER_INPUT'],
  [USER_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORKFLOW_STATE_NAME_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WORKFLOW_STATE_IN_USE_MESSAGE, 'BAD_USER_INPUT'],
  [WORKFLOW_STATE_LAST_OF_TYPE_MESSAGE, 'BAD_USER_INPUT'],
  [GLOBAL_ROLE_TARGET_HUMAN_MESSAGE, 'BAD_USER_INPUT'],
  [GLOBAL_ROLE_LAST_ADMIN_MESSAGE, 'BAD_USER_INPUT'],
  [OPS_ADMIN_ONLY_MESSAGE, 'FORBIDDEN'],
  [OPS_REASON_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [OPS_DEAD_LETTER_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [OPS_INBOUND_NOT_REPLAYABLE_MESSAGE, 'BAD_USER_INPUT'],
  [NEEDINFO_QUESTION_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [NEEDINFO_TARGET_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [NEEDINFO_TARGET_SELF_MESSAGE, 'BAD_USER_INPUT'],
  [NEEDINFO_TARGET_SERVICE_MESSAGE, 'BAD_USER_INPUT'],
  [NEEDINFO_AGENT_TO_AGENT_MESSAGE, 'BAD_USER_INPUT'],
  [NEEDINFO_TARGET_CANNOT_ANSWER_MESSAGE, 'BAD_USER_INPUT'],
  [NEEDINFO_ALREADY_OPEN_MESSAGE, 'BAD_USER_INPUT'],
  [NEEDINFO_NOT_A_NEEDINFO_MESSAGE, 'BAD_USER_INPUT'],
  [NEEDINFO_WITHDRAW_NOT_REQUESTER_MESSAGE, 'BAD_USER_INPUT'],
  [NEEDINFO_WITHDRAW_REASON_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [NEEDINFO_CLOSED_MESSAGE, 'BAD_USER_INPUT'],
  [NEEDINFO_IDEMPOTENCY_MISMATCH_MESSAGE, 'BAD_USER_INPUT'],
]);

/**
 * Let a module that keeps its own refusal texts have them reach GraphQL
 * callers as `message` instead of "Unexpected error." (INV-1119: the agent
 * request refusals had been masked on the web).
 */
export function exposeErrorMessages(messages: readonly string[], code = 'BAD_USER_INPUT'): void {
  for (const message of messages) if (!exposedErrorCodes.has(message)) exposedErrorCodes.set(message, code);
}

export function createNotAuthenticatedError(): GraphQLError {
  return createExposedError(NOT_AUTHENTICATED_MESSAGE);
}

export function createNotFoundError(message: string): GraphQLError {
  return createExposedError(message);
}

export function createValidationError(message: string): GraphQLError {
  return createExposedError(message);
}

export function getExposedError(error: unknown): GraphQLError | null {
  if (
    error instanceof GraphQLError &&
    typeof error.extensions?.code === 'string' &&
    exposedErrorCodes.get(error.message) === error.extensions.code
  ) {
    return createExposedError(error.message);
  }

  // IQL parse failures survive masking by message prefix: wrappers may drop
  // extensions or re-class the error across module copies, but the message
  // text is always preserved.
  const iqlMessage = error instanceof Error && error.message.startsWith(IQL_PARSE_ERROR_PREFIX)
    ? error.message
    : error instanceof GraphQLError &&
        error.originalError instanceof Error &&
        error.originalError.message.startsWith(IQL_PARSE_ERROR_PREFIX)
      ? error.originalError.message
      : null;
  if (iqlMessage) {
    return new GraphQLError(iqlMessage, {
      extensions: { code: 'IQL_PARSE' },
    });
  }

  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const exposedCause = cause ? getExposedError(cause) : null;

    if (exposedCause) {
      return exposedCause;
    }

    if (exposedErrorCodes.has(error.message)) {
      return createExposedError(error.message);
    }
  }

  return null;
}

/**
 * Checks whether an error is a Prisma error caused by invalid input
 * (e.g., passing a non-UUID string to a UUID column). These should be
 * treated as graceful failures rather than server crashes.
 *
 * Covers:
 * - PrismaClientValidationError (malformed input like non-UUID strings)
 * - PrismaClientKnownRequestError with code P2023 (inconsistent column data)
 * - PrismaClientKnownRequestError with code P2025 (record not found)
 */
export function isPrismaInvalidInputError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const tag = (error as { [Symbol.toStringTag]?: string })[Symbol.toStringTag];

  if (tag === 'PrismaClientValidationError') {
    return true;
  }

  if (tag === 'PrismaClientKnownRequestError') {
    const code = (error as { code?: string }).code;

    return code === 'P2023' || code === 'P2025';
  }

  return false;
}

function createExposedError(message: string): GraphQLError {
  return new GraphQLError(message, {
    extensions: {
      code: exposedErrorCodes.get(message) ?? 'BAD_USER_INPUT',
    },
  });
}
