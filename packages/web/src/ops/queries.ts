import { gql } from '@apollo/client';

// The ops page (INV-796): what AGENTS.md §9 used to do in SQL or the CLI.

const WEBHOOK_FIELDS = `
  id
  label
  url
  teamId
  eventTypes
  filterQuery
  enabled
  consecutiveFailures
  createdAt
`;

export const OPS_OVERVIEW_QUERY = gql`
  query OpsOverview {
    opsOverview {
      watermarks { key repository watermark updatedAt }
      syncDeadLetters { id repository itemRef error attempts lastFailedAt }
      inbound {
        counts { status count }
        oldestPendingAt
        dead { id deliveryId eventType repository attempts lastErrorCode receivedAt replayable }
      }
      outboxFailures { id type attempts lastError createdAt deadLetteredAt }
      webhooks { ${WEBHOOK_FIELDS} }
      audits { id action subject reason createdAt byActor { id name } }
    }
  }
`;

export const OPS_SYNC_DEAD_LETTER_CLEAR_MUTATION = gql`
  mutation OpsSyncDeadLetterClear($id: String!, $reason: String!) {
    opsSyncDeadLetterClear(id: $id, reason: $reason) { success message }
  }
`;

export const OPS_INBOUND_REPLAY_MUTATION = gql`
  mutation OpsInboundReplay($id: String!, $reason: String!, $expectedAttempts: Int!) {
    opsInboundReplay(id: $id, reason: $reason, expectedAttempts: $expectedAttempts) { success message }
  }
`;

export const WEBHOOK_CREATE_MUTATION = gql`
  mutation WebhookCreate($input: WebhookCreateInput!) {
    webhookCreate(input: $input) { success message secret subscription { ${WEBHOOK_FIELDS} } }
  }
`;

export const WEBHOOK_UPDATE_MUTATION = gql`
  mutation WebhookUpdate($id: String!, $input: WebhookUpdateInput!) {
    webhookUpdate(id: $id, input: $input) { success message subscription { ${WEBHOOK_FIELDS} } }
  }
`;

export const WEBHOOK_ROTATE_SECRET_MUTATION = gql`
  mutation WebhookRotateSecret($id: String!) {
    webhookRotateSecret(id: $id) { success message secret }
  }
`;

export const WEBHOOK_DELETE_MUTATION = gql`
  mutation WebhookDelete($id: String!) {
    webhookDelete(id: $id) { success message }
  }
`;

export const TRACEABILITY_AUDIT_QUERY = gql`
  query TraceabilityAudit($days: Int) {
    traceabilityAudit(days: $days) {
      scannedPrCount
      days
      anomalies { repository prNumber prTitle prUrl identifier reason }
      repoErrors { repository message }
    }
  }
`;

// A person records evidence after the fact, e.g. a merged PR the audit found unrecorded.
export const EVIDENCE_ATTACH_MUTATION = gql`
  mutation EvidenceAttach($input: EvidenceAttachInput!) {
    evidenceAttach(input: $input) { success message }
  }
`;

export interface OpsWebhook {
  id: string;
  label: string | null;
  url: string;
  teamId: string | null;
  eventTypes: string[];
  filterQuery: string | null;
  enabled: boolean;
  consecutiveFailures: number;
  createdAt: string;
}

export interface OpsOverviewData {
  opsOverview: {
    watermarks: Array<{ key: string; repository: string; watermark: string; updatedAt: string }>;
    syncDeadLetters: Array<{ id: string; repository: string; itemRef: string; error: string; attempts: number; lastFailedAt: string }>;
    inbound: {
      counts: Array<{ status: string; count: number }>;
      oldestPendingAt: string | null;
      dead: Array<{
        id: string;
        deliveryId: string;
        eventType: string;
        repository: string;
        attempts: number;
        lastErrorCode: string | null;
        receivedAt: string;
        replayable: boolean;
      }>;
    };
    outboxFailures: Array<{ id: string; type: string; attempts: number; lastError: string | null; createdAt: string; deadLetteredAt: string | null }>;
    webhooks: OpsWebhook[];
    audits: Array<{ id: string; action: string; subject: string; reason: string | null; createdAt: string; byActor: { id: string; name: string | null } | null }>;
  };
}

export interface TraceabilityAuditData {
  traceabilityAudit: {
    scannedPrCount: number;
    days: number;
    anomalies: Array<{ repository: string; prNumber: number; prTitle: string; prUrl: string; identifier: string | null; reason: string }>;
    repoErrors: Array<{ repository: string; message: string }>;
  };
}

export interface MutationResult {
  success: boolean;
  message?: string | null;
}
