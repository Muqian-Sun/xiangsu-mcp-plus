#!/usr/bin/env node
// Installs the editor plugin from this package into 像塑's local plugin folder on macOS, replacing
// whatever version is there. The MCP server does the same by itself at startup when the plugin is
// missing or older, so this is only needed to point the plugin back at this copy.
// Other plugins listed in plugins.config.json are preserved.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePlugin } from '../src/plugininstall.mjs';

const configPath = path.join(fileURLToPath(new URL('..', import.meta.url)), 'config.local.json');
if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify({ devEval: false }, null, 2));

console.log(JSON.stringify({ ...ensurePlugin({ force: true }), config: configPath }, null, 2));
