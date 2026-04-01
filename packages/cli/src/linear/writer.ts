/**
 * Writes exported Linear data to the filesystem in a structured directory layout.
 *
 * Output structure:
 *   <outputDir>/
 *     teams.json
 *     workflow_states.json
 *     labels.json
 *     users.json
 *     issues.json
 *     comments/
 *       <ISSUE_ID>.json
 *     mappings/
 *       parent_child.json
 *     validation_report.json
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  LinearTeam,
  LinearWorkflowState,
  LinearLabel,
  LinearUser,
  LinearIssue,
  LinearComment,
  ParentChildMapping,
  ExportValidationReport,
} from './types.js';

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export interface ExportData {
  teams: LinearTeam[];
  workflowStates: LinearWorkflowState[];
  labels: LinearLabel[];
  users: LinearUser[];
  issues: LinearIssue[];
  comments: Map<string, LinearComment[]>;
  parentChildMappings: ParentChildMapping[];
  validationReport: ExportValidationReport;
}

/**
 * Write all exported data to the output directory.
 */
export async function writeExportData(
  outputDir: string,
  data: ExportData,
): Promise<void> {
  // Ensure directories exist
  await ensureDir(outputDir);
  await ensureDir(join(outputDir, 'comments'));
  await ensureDir(join(outputDir, 'mappings'));

  // Write top-level JSON files
  await writeJson(join(outputDir, 'teams.json'), data.teams);
  await writeJson(join(outputDir, 'workflow_states.json'), data.workflowStates);
  await writeJson(join(outputDir, 'labels.json'), data.labels);
  await writeJson(join(outputDir, 'users.json'), data.users);
  await writeJson(join(outputDir, 'issues.json'), data.issues);

  // Write per-issue comment files
  for (const [issueId, comments] of data.comments.entries()) {
    await writeJson(join(outputDir, 'comments', `${issueId}.json`), comments);
  }

  // Write mappings
  await writeJson(
    join(outputDir, 'mappings', 'parent_child.json'),
    data.parentChildMappings,
  );

  // Write validation report
  await writeJson(
    join(outputDir, 'validation_report.json'),
    data.validationReport,
  );
}
