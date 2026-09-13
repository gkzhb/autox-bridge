import type { Command } from 'commander';
import type { BridgeAction, TargetSelection } from '../types.js';
import { errorMessage } from '../errors.js';
import { compileScript, parseScriptInput, validateScriptTemplate } from './compile.js';
import { discoverScripts, MAX_SCRIPT_BYTES, readScriptFile, resolveScript } from './registry.js';

interface NamedScriptOptions extends TargetSelection { input: string }
export function registerScriptCommands(program: Command, print: (value: unknown) => void, action: (input: BridgeAction) => Promise<void>) {
  const scripts = program.command('scripts').description('Discover and run user-configured AutoX scripts (one directory level)');
  scripts.command('list').description('List local manifest metadata and diagnostics without contacting bridge')
    .option('--query <text>', 'Filter by name or description')
    .action(async (options: { query?: string }) => {
      const registry = await discoverScripts();
      const query = options.query?.toLowerCase();
      print({ root: registry.root, scripts: registry.scripts
        .filter(item => !query || `${item.manifest.name} ${item.manifest.description}`.toLowerCase().includes(query))
        .map(item => ({ name: item.manifest.name, description: item.manifest.description, directory: item.directory,
          valid: !registry.diagnostics.some(issue => issue.name === item.manifest.name) })), diagnostics: registry.diagnostics });
    });
  scripts.command('show <name>').description('Show a local manifest, paths and stable script identity (not source)')
    .action(async (name: string) => print(resolveScript(await discoverScripts(), name)));
  scripts.command('validate').description('Validate local manifests, files and input templates; never execute')
    .action(async () => {
      const registry = await discoverScripts();
      for (const script of registry.scripts) {
        try { validateScriptTemplate(script, await readScriptFile(registry.root, script.entryPath, MAX_SCRIPT_BYTES)); }
        catch (error) { registry.diagnostics.push({ name: script.manifest.name, directory: script.directory, error: errorMessage(error) }); }
      }
      const ok = registry.diagnostics.length === 0;
      print({ root: registry.root, ok, checked: registry.scripts.length, diagnostics: registry.diagnostics });
      if (!ok) process.exitCode = 1;
    });
  const target = (command: Command) => command.option('-d, --device <id-or-name>', 'Target device ID or unique name')
    .option('-a, --all', 'Explicitly target all attached devices');
  for (const operation of ['run', 'rerun', 'x'] as const) {
    const parent = operation === 'x' ? program : scripts;
    target(parent.command(`${operation} <name>`).description(operation === 'x' ? 'Shorthand for scripts run <name>' : `${operation} a user-configured AutoX script`))
      .option('--input <json>', 'Input object validated against manifest parameters', '{}')
      .action(async (name: string, options: NamedScriptOptions) => {
        const input = parseScriptInput(options.input);
        const registry = await discoverScripts();
        const script = resolveScript(registry, name);
        const compiled = await compileScript(registry.root, script, input);
        await action({ action: operation === 'rerun' ? 'rerun' : 'run', ...compiled, device: options.device, all: options.all ?? false });
      });
  }
  target(scripts.command('stop <name>').description('Stop a registered script by its stable identity'))
    .action(async (name: string, options: TargetSelection) => {
      const script = resolveScript(await discoverScripts(), name);
      await action({ action: 'stop', id: script.id, device: options.device, all: options.all ?? false });
    });
}
