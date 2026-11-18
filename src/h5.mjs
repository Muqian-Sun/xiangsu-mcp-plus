// Wrap the H5 authoring scripts that lived under ~/Downloads/xiangsu-h5-src and 像塑's BuiltinResource
// skills: bundle build (compress → audit → compile → deterministic zip → publish) and font subsetting.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appRoot } from './editorres.mjs';

const run = promisify(execFile);

const skillsRoot = () => path.join(appRoot(), 'Contents/Resources/BuiltinResource/McpTool/resources/skills');

function mustExist(p, code) {
  if (!fs.existsSync(p)) throw Error(`${code}: ${p}`);
  return p;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function nodeScript(cwd, script, args, { exec = run } = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, ...args], { cwd, maxBuffer: 32 * 1024 * 1024 });
    return { stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (e) {
    throw Error(`H5_NODE_FAILED(${path.basename(script)}): ${String(e.stderr || e.stdout || e.message).trim().slice(0, 2000)}`);
  }
}

async function pythonScript(cwd, script, args, { exec = run } = {}) {
  try {
    const { stdout, stderr } = await exec('python3', [script, ...args], { cwd, maxBuffer: 32 * 1024 * 1024 });
    return { stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (e) {
    throw Error(`H5_PYTHON_FAILED(${path.basename(script)}): ${String(e.stderr || e.stdout || e.message).trim().slice(0, 2000)}`);
  }
}

async function auditBundle(compDir, target, edge, fps, tmp, { exec = run } = {}) {
  const auditJs = path.join(compDir, 'scripts/audit_bundle.mjs');
  const out = path.join(tmp, 'audit.json');
  try {
    await exec(process.execPath, [auditJs, target, '--target-short-edge', String(edge), '--target-fps', String(fps)], {
      cwd: compDir,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    // audit_bundle writes JSON even on failure in the shell script (|| true); capture stdout if any.
    const text = String(e.stdout || '');
    if (text.trim()) fs.writeFileSync(out, text);
    else throw Error(`H5_AUDIT_FAILED: ${String(e.stderr || e.message).trim().slice(0, 1500)}`);
  }
  // Re-run capturing stdout explicitly when the process exits 0.
  if (!fs.existsSync(out)) {
    const { stdout } = await exec(process.execPath, [auditJs, target, '--target-short-edge', String(edge), '--target-fps', String(fps)], {
      cwd: compDir,
      maxBuffer: 16 * 1024 * 1024,
    });
    fs.writeFileSync(out, stdout);
  }
  const compliance = readJson(out).compliance || {};
  const bad = Object.entries(compliance).filter(([, v]) => v !== true).map(([k]) => k);
  if (bad.length) throw Error(`H5_AUDIT_FAILED: ${bad.join(', ')}`);
  return readJson(out);
}

export async function buildH5Bundle({
  source_dir,
  brief_path,
  project_path,
  instance_id,
  request_id,
  short_edge = 720,
  fps = 24,
  exec = run,
  skills = skillsRoot(),
} = {}) {
  let tmp;
  try {
    if (!path.isAbsolute(source_dir)) throw Error(`SOURCE_DIR_NOT_ABSOLUTE: ${source_dir}`);
    if (!path.isAbsolute(brief_path)) throw Error(`BRIEF_PATH_NOT_ABSOLUTE: ${brief_path}`);
    mustExist(source_dir, 'SOURCE_DIR_NOT_FOUND');
    mustExist(brief_path, 'BRIEF_PATH_NOT_FOUND');
    if (!request_id) throw Error('REQUEST_ID_REQUIRED');

    const comp = mustExist(path.join(skills, 'ability/HyperFramesCompression'), 'H5_SKILLS_MISSING');
    const auth = mustExist(path.join(skills, 'workflow/dyeh-h5-authoring'), 'H5_SKILLS_MISSING');
    const conv = mustExist(path.join(skills, 'workflow/dyeh-h5-convert'), 'H5_SKILLS_MISSING');
    const pub = mustExist(path.join(skills, 'workflow/H5ImportWorkflow/scripts/publish-h5-artifact.cjs'), 'H5_SKILLS_MISSING');

    if (!project_path) throw Error('PROJECT_PATH_REQUIRED: h5_bundle_build needs the 像塑工程目录 to publish the zip into ArtifactStore');
    if (!path.isAbsolute(project_path)) throw Error(`PROJECT_PATH_NOT_ABSOLUTE: ${project_path}`);
    const dyeh = mustExist(project_path, 'PROJECT_PATH_NOT_FOUND');
    const projectId = instance_id || path.basename(dyeh);

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-h5-'));
    await nodeScript(comp, path.join(comp, 'scripts/compress_project.mjs'), [source_dir, '--target-short-edge', String(short_edge), '--target-fps', String(fps)], { exec });
    await auditBundle(comp, source_dir, short_edge, fps, tmp, { exec });

    const compilePy = path.join(auth, 'scripts/compile_hyperframes_compatibility.py');
    // First run may need --self-check so the 30s import timeout does not trip on a cold start.
    const compileArgs = ['--project', source_dir, '--brief', brief_path, '--target-short-edge', String(short_edge), '--target-fps', String(fps)];
    let compileOut;
    try {
      compileOut = await pythonScript(auth, compilePy, compileArgs, { exec });
    } catch {
      await pythonScript(auth, compilePy, ['--self-check'], { exec }).catch(() => {});
      compileOut = await pythonScript(auth, compilePy, compileArgs, { exec });
    }
    const compileFile = path.join(tmp, 'compile.json');
    fs.writeFileSync(compileFile, compileOut.stdout || '{}');
    const compiled = readJson(compileFile);
    if (!compiled.ok || compiled.data?.runtimeCompliance !== 'passed') {
      return { outcome: 'error', stage: 'compile', diagnostics: compiled.error || compiled };
    }
    const slot_fit_passed = (compiled.data?.diagnostics || []).filter((d) => d.code === 'HF_IMAGE_SLOT_ADAPTATION_PASSED').length;

    const convertPy = path.join(conv, 'scripts/build_import_bundle.py');
    const digests = [];
    let zipPath = null;
    for (const i of [1, 2]) {
      const out = await pythonScript(conv, convertPy, [
        '--project', source_dir,
        '--normalized-project', path.join(source_dir, '.dyeh-h5/normalized-h5-project.json'),
        '--dyeh-project-root', dyeh,
      ], { exec });
      const parsed = JSON.parse(out.stdout);
      digests.push(parsed.bundleDigest);
      zipPath = parsed.bundleLocalPath;
      fs.writeFileSync(path.join(tmp, `convert${i}.json`), out.stdout);
    }
    if (digests[0] !== digests[1]) {
      return { outcome: 'error', stage: 'convert', diagnostics: { message: `convert not deterministic: ${digests[0]} vs ${digests[1]}` } };
    }
    const { stdout: shaOut } = await exec('shasum', ['-a', '256', zipPath]);
    const actual = shaOut.trim().split(/\s+/)[0];
    if (actual !== digests[0]) {
      return { outcome: 'error', stage: 'convert', diagnostics: { message: `zip sha256 ${actual} != digest ${digests[0]}` } };
    }

    const unz = path.join(tmp, 'unz');
    fs.mkdirSync(unz);
    await exec('unzip', ['-q', zipPath, '-d', unz]);
    await auditBundle(comp, unz, short_edge, fps, tmp, { exec });

    const rel = path.relative(dyeh, zipPath);
    const artifact_id = `${request_id}-${digests[0].slice(0, 8)}`;
    await nodeScript(dyeh, pub, [
      '--project-root', '.',
      '--project-id', projectId,
      '--request-id', request_id,
      '--artifact-id', artifact_id,
      '--expected-digest', digests[0],
      '--zip', rel,
    ], { exec });

    return {
      outcome: 'ok',
      artifact_id,
      expected_digest: digests[0],
      zip_relative_path: rel,
      bytes: fs.statSync(zipPath).size,
      slot_fit_passed,
    };
  } catch (e) {
    return { outcome: 'error', stage: 'pipeline', diagnostics: { message: String(e.message || e) } };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function subsetH5Font({ font_path, license_path, source_dir, output_name, extra_text = '', exec = run } = {}) {
  for (const [p, code] of [
    [font_path, 'FONT_PATH_NOT_ABSOLUTE'],
    [license_path, 'LICENSE_PATH_NOT_ABSOLUTE'],
    [source_dir, 'SOURCE_DIR_NOT_ABSOLUTE'],
  ]) {
    if (!path.isAbsolute(p)) throw Error(`${code}: ${p}`);
  }
  mustExist(font_path, 'FONT_NOT_FOUND');
  mustExist(license_path, 'LICENSE_NOT_FOUND');
  mustExist(source_dir, 'SOURCE_DIR_NOT_FOUND');
  const html = path.join(source_dir, 'index.html');
  mustExist(html, 'INDEX_HTML_NOT_FOUND');

  const text = fs.readFileSync(html, 'utf8') + (extra_text || '');
  const printable = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
  const chars = new Set([...text].filter((c) => c.charCodeAt(0) > 0x7f));
  for (const c of printable) chars.add(c);
  chars.add(' ');
  chars.add('\u3000');

  const fontsDir = path.join(source_dir, 'fonts');
  fs.mkdirSync(fontsDir, { recursive: true });
  const outName = output_name.endsWith('.woff2') ? output_name : `${output_name}.woff2`;
  const out = path.join(fontsDir, outName);

  // fonttools via uv keeps the same dependency surface as subset_font.py without a global install.
  const py = `
import shutil, sys
from fontTools import subset
font, license_file, out, text = sys.argv[1:5]
opts = subset.Options()
opts.flavor = "woff2"
opts.layout_features = ["*"]
opts.name_IDs = ["*"]
opts.notdef_outline = True
ft = subset.load_font(font, opts)
sub = subset.Subsetter(opts)
sub.populate(text=text)
sub.subset(ft)
subset.save_font(ft, out, opts)
shutil.copyfile(license_file, __import__("pathlib").Path(out).with_name("OFL.txt"))
cmap = ft.getBestCmap() or {}
missing = sorted(c for c in text if ord(c) not in cmap and not c.isspace())
print(out, __import__("os").path.getsize(out), len(set(text)), "".join(missing), sep="\\n")
`;
  let stdout;
  try {
    const r = await exec('uv', ['run', '-q', '--with', 'fonttools', '--with', 'brotli', 'python', '-c', py, font_path, license_path, out, [...chars].sort().join('')], {
      maxBuffer: 16 * 1024 * 1024,
    });
    stdout = String(r.stdout || '');
  } catch (e) {
    throw Error(`H5_FONT_SUBSET_FAILED: ${String(e.stderr || e.message).trim().slice(0, 1500)}`);
  }
  const lines = stdout.trim().split('\n');
  const missing = lines[3] || '';
  if (missing) {
    return { outcome: 'error', missing_chars: [...missing], output: out };
  }
  return { outcome: 'ok', output: out, bytes: Number(lines[1]), char_count: Number(lines[2]), license: path.join(fontsDir, 'OFL.txt') };
}
