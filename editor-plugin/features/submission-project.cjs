'use strict';
const fs = require('fs');
const path = require('path');

// Douyin AR 9.8.3 DYEHEffectSubmissionWindow.uploadProject compares the actual project.zip
// size with 209715200 using >. This is separate from maxEffectPackageSize (the runtime package).
const PROJECT_PACKAGE_LIMIT_BYTES = 209715200;
// The native shouldIncludeInProjectZip excludes this staging tree, including from projectBuffer.
const STAGING = '.dyeh-h5/staging';
const included = (rel) => rel !== STAGING && !rel.startsWith(`${STAGING}/`);

function projectInventory(root) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (!included(rel)) continue;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw Error(`PROJECT_INVENTORY_UNSUPPORTED: symbolic link ${rel}; resolve it before submission`);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) files.push({ path: rel, bytes: stat.size });
      else throw Error(`PROJECT_INVENTORY_UNSUPPORTED: ${rel} is not a regular file or directory`);
    }
  }
  visit(root);
  return {
    project_directory_bytes: files.reduce((total, file) => total + file.bytes, 0),
    project_file_count: files.length,
    // A report bound, not a size threshold: the largest ten files make cleanup actionable.
    largest_project_files: files.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)).slice(0, 10),
  };
}

async function beforeDeadline(promise, deadline, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), Math.max(0, deadline - Date.now())); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function preparedProjectPackage(win, deadline, pollMs) {
  if (!win.exportPromise || typeof win.exportPromise.then !== 'function') throw Error('INCOMPATIBLE_EDITOR: submit window has no native exportPromise');
  try {
    await beforeDeadline(win.exportPromise, deadline, 'native project export timed out');
    // The page's delegateShowNativeWebView starts zipProjectPromise after exportPromise.
    while (!win.zipProjectPromise) {
      if (win.isClosed) throw Error('submit window was closed');
      if (Date.now() >= deadline) throw Error(`native project ZIP was not prepared${win.lastErrorMessage ? `: ${win.lastErrorMessage}` : ''}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    }
    const file = await beforeDeadline(win.zipProjectPromise, deadline, 'native project ZIP timed out');
    if (typeof file !== 'string' || !file) throw Error('native project ZIP path is missing');
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw Error('native project ZIP is not a regular file');
    return { project_package_bytes: stat.size, project_package_limit_bytes: PROJECT_PACKAGE_LIMIT_BYTES };
  } catch (error) {
    throw Error(`PROJECT_EXPORT_FAILED: ${error.message}`);
  }
}

function projectSizeIssue(info) {
  return info.project_package_bytes > PROJECT_PACKAGE_LIMIT_BYTES
    ? `PROJECT_PACKAGE_TOO_LARGE: 工程源文件包 ${info.project_package_bytes} bytes exceeds ${PROJECT_PACKAGE_LIMIT_BYTES} bytes (200 MiB); remove unused resources, recordings and frame captures from the project before submitting`
    : null;
}

module.exports = { PROJECT_PACKAGE_LIMIT_BYTES, projectInventory, beforeDeadline, preparedProjectPackage, projectSizeIssue };
