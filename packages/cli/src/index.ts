import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { registerExportCommand } from './commands/export.js';
import { registerImportCommand } from './commands/import.js';

export function createProgram(): Command {
  const program = new Command()
    .name('involute')
    .description('Involute CLI — manage your Linear-compatible project management service')
    .version('0.0.0')
    .enablePositionalOptions();

  registerExportCommand(program);
  registerImportCommand(program);

  return program;
}

const currentEntryPoint = process.argv[1];

if (currentEntryPoint && import.meta.url === pathToFileURL(currentEntryPoint).href) {
  createProgram().parse(process.argv);
}
