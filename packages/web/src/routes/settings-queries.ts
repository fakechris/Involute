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
