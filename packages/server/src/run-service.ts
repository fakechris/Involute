/**
 * Run / evidence / human review kernel.
 * INV-11: enqueueWorkEvent is routed through inv11-hooks so CLEAR evidence can auto-Done.
 */
export {
  attachEvidence,
  reportRun,
  reviewWork,
  type AttachEvidenceInput,
  type ReportRunInput,
  type ReviewWorkInput,
} from './run-service-body.js';
