/**
 * CLI export command — exports data from Linear workspace to a local directory.
 *
 * Usage: involute export --token <linear-token> --team <key> --output <dir>
 */

import type { Command } from 'commander';
import {
  LinearClient,
  exportTeams,
  exportWorkflowStates,
  exportLabels,
  exportUsers,
  exportIssues,
  exportAllComments,
  filterExportDataToTeamScope,
  buildParentChildMapping,
  generateValidationReport,
  writeExportData,
} from '../linear/index.js';

export interface ExportOptions {
  token: string;
  team: string;
  output: string;
}

/**
 * Run the export pipeline — extracted for testability.
 */
export async function runExport(options: ExportOptions): Promise<void> {
  const { token, team, output } = options;

  const client = new LinearClient({ apiToken: token });

  const log = (msg: string): void => {
    process.stdout.write(msg + '\n');
  };

  log(`Exporting data from Linear for team "${team}" to ${output}...`);
  log('');

  // Export each entity type with progress
  const allTeams = await exportTeams(client, log);
  const selectedTeams = allTeams.filter((t) => t.key === team);

  if (selectedTeams.length === 0) {
    throw new Error(
      `Team with key "${team}" not found. Available teams: ${allTeams.map((t) => t.key).join(', ') || '(none)'}`,
    );
  }

  const workflowStates = await exportWorkflowStates(client, log);
  const labels = await exportLabels(client, log);
  const users = await exportUsers(client, log);
  const issues = await exportIssues(client, log);
  const comments = await exportAllComments(client, issues, log);

  log('');
  log('Building parent-child mappings...');
  const parentChildMappings = buildParentChildMapping(issues);
  const scopedData = filterExportDataToTeamScope(team, {
    teams: allTeams,
    workflowStates,
    labels,
    users,
    issues,
    comments,
    parentChildMappings,
  });
  log(`  Found ${String(scopedData.parentChildMappings.length)} parent-child relationships`);

  log('');
  log('Generating validation report...');
  const validationReport = generateValidationReport(
    scopedData.teams,
    scopedData.workflowStates,
    scopedData.labels,
    scopedData.users,
    scopedData.issues,
    scopedData.comments,
    scopedData.parentChildMappings,
  );

  log('');
  log('Writing export data...');
  await writeExportData(output, {
    teams: scopedData.teams,
    workflowStates: scopedData.workflowStates,
    labels: scopedData.labels,
    users: scopedData.users,
    issues: scopedData.issues,
    comments: scopedData.comments,
    parentChildMappings: scopedData.parentChildMappings,
    validationReport,
  });

  log('');
  log('Export complete!');
  log('');
  log('Summary:');
  log(`  Teams:             ${String(validationReport.counts.teams)}`);
  log(`  Workflow states:   ${String(validationReport.counts.workflowStates)}`);
  log(`  Labels:            ${String(validationReport.counts.labels)}`);
  log(`  Users:             ${String(validationReport.counts.users)}`);
  log(`  Issues:            ${String(validationReport.counts.issues)}`);
  log(`  Comments:          ${String(validationReport.counts.comments)}`);
  log(`  Parent-child rels: ${String(validationReport.counts.parentChildRelationships)}`);
  log('');
  log(`Output directory: ${output}`);
}

/**
 * Register the `export` command on the Commander program.
 */
export function registerExportCommand(program: Command): void {
  program
    .command('export')
    .description('Export data from Linear workspace to a local directory')
    .requiredOption('--token <linear-token>', 'Linear API token')
    .requiredOption('--team <key>', 'Team key to export (e.g., SON)')
    .requiredOption('--output <dir>', 'Output directory for export data')
    .action(async (opts: ExportOptions) => {
      try {
        await runExport(opts);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Error: ${message}\n`);
        process.exitCode = 1;
      }
    });
}
