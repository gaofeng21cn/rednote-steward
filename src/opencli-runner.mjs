#!/usr/bin/env node
// Use one pinned OpenCLI registry and the bundled adapters. In particular, do
// not run upstream's user-runtime shim: it rewrites ~/.opencli on startup.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configureOwnedTabRetention } from '../adapters/opencli/xiaohongshu/owned-tab.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = fileURLToPath(import.meta.resolve('@jackwener/opencli/registry'));
const runtime = path.dirname(registryPath);
const opencliRoot = path.resolve(runtime, '../..');
const builtins = path.join(opencliRoot, 'clis');
const adapters = path.join(root, 'adapters/opencli');
const moduleAt = (name) => import(pathToFileURL(path.join(runtime, name)).href);
const [{ discoverClis }, { runCli }, { installNodeNetwork }] = await Promise.all([
  moduleAt('discovery.js'), moduleAt('cli.js'), moduleAt('node-network.js'),
]);
installNodeNetwork();
await discoverClis(builtins);
await discoverClis(adapters);
const { rewriteBrowserArgv } = await moduleAt('cli-argv-preprocess.js');
const argv = rewriteBrowserArgv(process.argv.slice(2));
let commandIndex = 0;
while (argv[commandIndex]?.startsWith('-')) {
  const option = argv[commandIndex++];
  if (option === '--profile') commandIndex++;
}
const { getRegistry } = await moduleAt('registry.js');
configureOwnedTabRetention(argv, getRegistry().get(`${argv[commandIndex]}/${argv[commandIndex + 1]}`));
process.argv.splice(2, process.argv.length - 2, ...argv);
await runCli(builtins, adapters);
