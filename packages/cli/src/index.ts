import { Command } from 'commander';
import { pathToFileURL } from 'node:url';

export function createProgram(): Command {
  return new Command()
    .name('involute')
    .description('Involute CLI scaffold')
    .version('0.0.0');
}

const currentEntryPoint = process.argv[1];

if (currentEntryPoint && import.meta.url === pathToFileURL(currentEntryPoint).href) {
  createProgram().parse(process.argv);
}
