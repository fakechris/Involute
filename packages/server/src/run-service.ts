/**
 * Run / evidence / human review kernel.
 * enqueueWorkEvent records shadow verification; only human review can accept work.
 */
export {
  attachEvidence,
  reportRun,
  reviewWork,
  type AttachEvidenceInput,
  type ReportRunInput,
  type ReviewWorkInput,
} from './run-service-body.js';
