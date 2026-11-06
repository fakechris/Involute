import { gql } from '@apollo/client';

// Workspace settings (INV-797): labels, workflow states, admins, server
// features, service actors and email notifications.

export type WorkflowStateType = 'BACKLOG' | 'UNSTARTED' | 'STARTED' | 'REVIEW' | 'COMPLETED' | 'CANCELED';

export interface SettingsLabel {
  id: string;
  name: string;
  issueCount: number;
}

export interface SettingsState {
  id: string;
  name: string;
  type: WorkflowStateType;
  position: number;
  issueCount: number;
}

export interface SettingsUser {
  id: string;
  name: string | null;
  email: string | null;
  actorKind: 'HUMAN' | 'AGENT' | 'SERVICE';
  globalRole: 'ADMIN' | 'USER';
  deactivatedAt?: string | null;
}

export interface ServerFeature {
  key: string;
  label: string;
  enabled: boolean;
  detail: string;
}

/** Every settings mutation payload: `success`, why it was refused, and the thing it changed. */
export type Refusable<T> = { success: boolean; message?: string | null } & T;

export const SETTINGS_LABELS_QUERY = gql`
  query SettingsLabels {
    issueLabels {
      nodes {
        id
        name
        issueCount
      }
    }
  }
`;

export const LABEL_CREATE_MUTATION = gql`
  mutation LabelCreate($name: String!) {
    labelCreate(name: $name) {
      success
      message
      label { id name issueCount }
    }
  }
`;

export const LABEL_UPDATE_MUTATION = gql`
  mutation LabelUpdate($id: String!, $name: String!) {
    labelUpdate(id: $id, name: $name) {
      success
      message
      label { id name issueCount }
    }
  }
`;

export const LABEL_DELETE_MUTATION = gql`
  mutation LabelDelete($id: String!) {
    labelDelete(id: $id) {
      success
      message
      labelId
    }
  }
`;

export const SETTINGS_STATES_QUERY = gql`
  query SettingsStates($teamKey: String!) {
    teams(filter: { key: { eq: $teamKey } }) {
      nodes {
        id
        name
        states {
          nodes { id name type position issueCount }
        }
      }
    }
  }
`;

export const WORKFLOW_STATE_CREATE_MUTATION = gql`
  mutation WorkflowStateCreate($input: WorkflowStateCreateInput!) {
    workflowStateCreate(input: $input) {
      success
      message
      state { id name type position issueCount }
    }
  }
`;

export const WORKFLOW_STATE_UPDATE_MUTATION = gql`
  mutation WorkflowStateUpdate($id: String!, $input: WorkflowStateUpdateInput!) {
    workflowStateUpdate(id: $id, input: $input) {
      success
      message
      state { id name type position issueCount }
    }
  }
`;

export const WORKFLOW_STATE_DELETE_MUTATION = gql`
  mutation WorkflowStateDelete($id: String!) {
    workflowStateDelete(id: $id) {
      success
      message
      stateId
    }
  }
`;

export const SETTINGS_PEOPLE_QUERY = gql`
  query SettingsPeople {
    users {
      nodes { id name email actorKind globalRole deactivatedAt }
    }
  }
`;

export const USER_SET_GLOBAL_ROLE_MUTATION = gql`
  mutation UserSetGlobalRole($userId: String!, $role: GlobalRole!, $reason: String) {
    userSetGlobalRole(userId: $userId, role: $role, reason: $reason) {
      success
      message
      user { id globalRole }
    }
  }
`;

export const SERVER_FEATURES_QUERY = gql`
  query ServerFeatures {
    serverFeatures { key label enabled detail }
  }
`;

export const SERVICE_ACTOR_CREATE_MUTATION = gql`
  mutation ServiceActorCreate($input: ServiceActorCreateInput!) {
    serviceActorCreate(input: $input) {
      success
      message
      actor { id handle name }
    }
  }
`;

export const EMAIL_NOTIFICATIONS_QUERY = gql`
  query EmailNotifications {
    viewer { id emailNotifications }
  }
`;

export const NOTIFICATION_PREFERENCES_UPDATE_MUTATION = gql`
  mutation NotificationPreferencesUpdate($emailNotifications: Boolean!) {
    notificationPreferencesUpdate(emailNotifications: $emailNotifications) {
      success
      message
      emailNotifications
    }
  }
`;

// Autonomy policy (INV-1489, docs/autonomy-policy.md): who decides at each
// human gate, set on the workspace, a team or a project.

export type AutonomyScope = 'WORKSPACE' | 'TEAM' | 'PROJECT';
export type AutonomyDecider = 'human' | 'auto' | 'none';

export interface WorkflowPolicyRow {
  id: string;
  scope: AutonomyScope;
  scopeId: string;
  level: number;
  gates: Record<string, { decider: AutonomyDecider; condition?: unknown }>;
  intake: unknown | null;
  locked: string[];
  version: number;
  reason: string | null;
  observeUntil: string | null;
  active: boolean;
  paused: boolean;
  defaultLevel: number;
  templates: unknown;
  createdAt: string;
}

export interface AutonomyLevelInfo { level: number; name: string; descriptionEn: string; descriptionZh: string; gates: Array<{ gate: string; decider: AutonomyDecider }> }
export interface AutonomyTemplate { name: string; level: number; gates?: unknown | null }

export interface AutonomySettingsData {
  autonomySettings: {
    scope: AutonomyScope;
    scopeId: string;
    active: WorkflowPolicyRow | null;
    history: WorkflowPolicyRow[];
    ceiling: number;
    paused: boolean;
    defaultLevel: number;
    templates: AutonomyTemplate[];
    completionReply: string | null;
    levels: AutonomyLevelInfo[];
    builtInLocks: Array<{ id: string; gate: string; reason: string }>;
    gates: string[];
    conditionFields: string[];
  };
}

/** The resolved autonomy of a work item, as `Issue.autonomy` returns it. */
export interface IssueAutonomy { level: number; source: string; name: string; requested: number; requestedBy: string; observing?: boolean }

export const WORKSPACE_SETTINGS_SCOPE_ID = 'workspace';

const WORKFLOW_POLICY_FIELDS = `
  id scope scopeId level gates intake locked version reason observeUntil active paused defaultLevel templates createdAt
`;

export const AUTONOMY_SETTINGS_QUERY = gql`
  query AutonomySettings($scope: AutonomyScope!, $scopeId: String!) {
    autonomySettings(scope: $scope, scopeId: $scopeId) {
      scope
      scopeId
      active { ${WORKFLOW_POLICY_FIELDS} }
      history { ${WORKFLOW_POLICY_FIELDS} }
      ceiling
      paused
      defaultLevel
      templates { name level gates }
      completionReply
      levels { level name descriptionEn descriptionZh gates { gate decider } }
      builtInLocks { id gate reason }
      gates
      conditionFields
    }
  }
`;

export const WORKFLOW_POLICY_SET_MUTATION = gql`
  mutation WorkflowPolicySet($input: WorkflowPolicySetInput!) {
    workflowPolicySet(input: $input) {
      success
      message
      policy { ${WORKFLOW_POLICY_FIELDS} }
    }
  }
`;

export const WORKFLOW_POLICY_CLEAR_MUTATION = gql`
  mutation WorkflowPolicyClear($input: WorkflowPolicyClearInput!) {
    workflowPolicyClear(input: $input) {
      success
      message
      cleared
    }
  }
`;

// --- Field definitions (INV-1503 / INV-1504, docs/field-definitions.md) -------

export type FieldType = 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'DATE' | 'ENUM' | 'MULTI_ENUM' | 'WORK_REF' | 'USER_REF' | 'URL';
export type WorkKindName = 'PROJECT' | 'MILESTONE' | 'EPIC' | 'ISSUE' | 'DECISION';

export interface FieldDefinitionRow {
  id: string;
  key: string;
  label: string;
  description: string | null;
  type: FieldType;
  options: Array<{ value: string; label: string; archived: boolean | null }>;
  appliesTo: { kinds: WorkKindName[]; types: string[] };
  required: boolean;
  defaultValue: unknown;
  searchable: boolean;
  active: boolean;
  version: number;
  previousKey: string | null;
  lastWrittenAt: string | null;
  usageCount: number;
  stale: boolean;
  indexJob: 'BACKFILL' | 'CLEANUP' | null;
  indexProcessed: number;
}

export interface FieldSettingsData {
  fieldLimits: { activePerScope: number; enumOptions: number; staleDays: number };
  fieldDefinitions: FieldDefinitionRow[];
}

export const FIELD_SETTINGS_QUERY = gql`
  query FieldSettings($scope: AutonomyScope!, $scopeId: String!) {
    fieldLimits { activePerScope enumOptions staleDays }
    fieldDefinitions(scope: $scope, scopeId: $scopeId, includeInactive: true) {
      id key label description type required defaultValue searchable active version previousKey lastWrittenAt usageCount stale indexJob indexProcessed
      options { value label archived }
      appliesTo { kinds types }
    }
  }
`;

export const FIELD_DEFINITION_SET_MUTATION = gql`
  mutation FieldDefinitionSet($input: FieldDefinitionSetInput!) {
    fieldDefinitionSet(input: $input) { success message definition { id key version } }
  }
`;

export const FIELD_DEFINITION_DEACTIVATE_MUTATION = gql`
  mutation FieldDefinitionDeactivate($input: FieldDefinitionDeactivateInput!) {
    fieldDefinitionDeactivate(input: $input) { success message definition { id key active } }
  }
`;

export const FIELD_DEFINITION_RENAME_MUTATION = gql`
  mutation FieldDefinitionRename($input: FieldDefinitionRenameInput!) {
    fieldDefinitionRename(input: $input) { success message definition { id key previousKey } }
  }
`;

export const FIELD_PROJECTS_QUERY = gql`
  query FieldProjects($teamKey: String) {
    issues(first: 100, filter: { kind: PROJECT, team: { key: { eq: $teamKey } } }) {
      nodes { id identifier title commitmentStatus }
    }
  }
`;

// --- GitHub (INV-1677) -----------------------------------------------------------

export interface GitHubAppInfo {
  appId: string;
  slug: string;
  name: string;
  htmlUrl: string;
  ownerLogin: string;
  installUrl: string;
  createdAt: string;
}

export interface GitHubSetup {
  secretKeyConfigured: boolean;
  webhookUrl: string;
  envWebhookSecret: boolean;
  envToken: boolean;
  app: GitHubAppInfo | null;
  lastDeliveryAt: string | null;
  viewerCanCreateApp: boolean;
  teams: GitHubTeamSetup[];
}

export interface GitHubConnectionInfo {
  id: string;
  kind: 'APP_INSTALLATION' | 'TOKEN';
  accountLogin: string;
  accountType: string | null;
  repositorySelection: string | null;
  status: 'ACTIVE' | 'DISCONNECTED';
  lastError: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
}

export interface GitHubRepositoryHealth {
  repository: string;
  project: { id: string; identifier: string };
  syncedThrough: string | null;
  lastSyncAt: string | null;
  deadLetters: number;
  credential: 'app' | 'team-token' | 'env' | 'none';
}

export interface GitHubTeamSetup {
  team: { id: string; key: string; name: string };
  viewerCanManage: boolean;
  connections: GitHubConnectionInfo[];
  repositories: GitHubRepositoryHealth[];
}

export interface GitHubRepositoryInfo {
  fullName: string;
  private: boolean;
  project: { id: string; identifier: string } | null;
}

export const GITHUB_SETUP_QUERY = gql`
  query GitHubSetup {
    githubSetup {
      secretKeyConfigured
      webhookUrl
      envWebhookSecret
      envToken
      app { appId slug name htmlUrl ownerLogin installUrl createdAt }
      lastDeliveryAt
      viewerCanCreateApp
      teams {
        team { id key name }
        viewerCanManage
        connections { id kind accountLogin accountType repositorySelection status lastError lastCheckedAt createdAt }
        repositories { repository project { id identifier } syncedThrough lastSyncAt deadLetters credential }
      }
    }
  }
`;

export const GITHUB_APP_MANIFEST_START_MUTATION = gql`
  mutation GitHubAppManifestStart($input: GitHubAppManifestStartInput!) {
    githubAppManifestStart(input: $input) {
      success
      message
      postUrl
      manifest
    }
  }
`;

export const GITHUB_INSTALL_START_MUTATION = gql`
  mutation GitHubInstallStart($teamId: String!) {
    githubInstallStart(teamId: $teamId) {
      success
      message
      url
    }
  }
`;

export const GITHUB_TOKEN_CONNECT_MUTATION = gql`
  mutation GitHubTokenConnect($input: GitHubTokenConnectInput!) {
    githubTokenConnect(input: $input) {
      success
      message
      connection { id }
    }
  }
`;

export const GITHUB_CONNECTION_REMOVE_MUTATION = gql`
  mutation GitHubConnectionRemove($id: String!) {
    githubConnectionRemove(id: $id) {
      success
      message
      removed
    }
  }
`;

export const GITHUB_CONNECTION_REPOSITORIES_QUERY = gql`
  query GitHubConnectionRepositories($connectionId: String!) {
    githubConnectionRepositories(connectionId: $connectionId) {
      fullName
      private
      project { id identifier }
    }
  }
`;

/** A PROJECT for a repository the team can read, so its PRs route to the team (INV-1677). */
export const GITHUB_PROJECT_CREATE_MUTATION = gql`
  mutation GitHubProjectCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      message
      issue { id identifier }
    }
  }
`;
