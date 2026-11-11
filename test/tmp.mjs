// Every temp dir a test file creates lives under one root that is removed when the test process exits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-test-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

export const tmpdir = (prefix) => fs.mkdtempSync(path.join(ROOT, prefix));

// Every test file imports this module first, so the plugin state directory (live editor windows,
// download registry) points at an empty folder before src/ modules read it: tests never see the
// windows of an editor running on this machine.
process.env.XIANGSU_MCP_EXT_STATE = tmpdir('xs-state-');
// A server process started by a test installs the editor plugin at startup; with no editor app it
// fails instead of repointing the plugin of the 像塑 installed on this machine at the test checkout.
process.env.XIANGSU_APP = path.join(ROOT, 'no-editor.app');
