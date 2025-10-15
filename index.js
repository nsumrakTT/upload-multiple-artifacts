const core = require('@actions/core');
const path = require('path');
const fs = require('fs');
const { DefaultArtifactClient } = require('@actions/artifact');
const fg = require('fast-glob');

function isString(value) {
  return typeof value === 'string' || value instanceof String;
}

function toPathArray(maybePath) {
  if (Array.isArray(maybePath)) {
    return maybePath
      .filter((p) => p != null)
      .map((p) => String(p).trim())
      .filter((p) => p.length > 0);
  }
  if (maybePath == null) return [];
  const str = String(maybePath).trim();
  return str.length === 0 ? [] : [str];
}

async function pathExists(p) {
  try {
    await fs.promises.access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function statSafe(p) {
  try {
    return await fs.promises.lstat(p);
  } catch {
    return null;
  }
}

async function collectFilesFromDirectory(dirPath) {
  const files = [];
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

function hasGlobChars(p) {
  return /[*?[\]{}()!]/.test(p);
}

async function resolveInputPathsToFiles(workspace, inputPaths) {
  const files = [];
  for (const input of inputPaths) {
    const abs = path.isAbsolute(input) ? input : path.join(workspace, input);
    if (hasGlobChars(abs)) {
      const fileMatches = await fg(abs, {
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: true,
        unique: true,
        absolute: true
      });
      const dirMatches = await fg(abs, {
        dot: true,
        onlyDirectories: true,
        followSymbolicLinks: true,
        unique: true,
        absolute: true
      });
      for (const dir of dirMatches) {
        const dirFiles = await collectFilesFromDirectory(dir);
        files.push(...dirFiles);
      }
      if (fileMatches.length === 0 && dirMatches.length === 0) {
        core.warning(`Glob did not match any files or directories: ${input}`);
      }
      files.push(...fileMatches);
      continue;
    } else {
      const exists = await pathExists(abs);
      if (!exists) {
        core.warning(`Path not found, skipping: ${input}`);
        continue;
      }
      const st = await statSafe(abs);
      if (!st) {
        core.warning(`Unable to stat path, skipping: ${input}`);
        continue;
      }
      if (st.isDirectory()) {
        const dirFiles = await collectFilesFromDirectory(abs);
        if (dirFiles.length === 0) {
          core.warning(`Directory is empty, skipping: ${input}`);
        } else {
          files.push(...dirFiles);
        }
      } else if (st.isFile()) {
        files.push(abs);
      } else {
        core.warning(`Not a regular file or directory, skipping: ${input}`);
      }
    }
  }
  // De-duplicate and normalize
  const unique = Array.from(new Set(files.map((f) => path.normalize(f))));
  return unique;
}

function computeCommonRootDirectory(filePaths) {
  if (filePaths.length === 0) return process.cwd();
  // Work with directories containing each file
  const dirPaths = filePaths.map((p) => path.dirname(path.resolve(p)));
  const splitPaths = dirPaths.map((p) => p.split(path.sep));
  const minLen = splitPaths.reduce((min, arr) => Math.min(min, arr.length), Infinity);
  const commonParts = [];
  for (let i = 0; i < minLen; i++) {
    const part = splitPaths[0][i];
    if (splitPaths.every((arr) => arr[i] === part)) {
      commonParts.push(part);
    } else {
      break;
    }
  }
  const first = filePaths[0];
  const fallback = path.dirname(path.resolve(first));
  const common = commonParts.length > 0 ? commonParts.join(path.sep) : path.parse(fallback).root || fallback;
  return common || process.cwd();
}

function ensureArrayOfArtifacts(value) {
  if (!Array.isArray(value)) {
    throw new Error('Config JSON must be an array of artifact definitions.');
  }
  const results = [];
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (!item || typeof item !== 'object') {
      throw new Error(`Artifact at index ${index} must be an object.`);
    }
    // Ignore empty JSON objects like {}
    if (Object.keys(item).length === 0) {
      continue;
    }
    const name = item.name;
    const paths = toPathArray(item.path);
    if (!isString(name) || String(name).trim().length === 0) {
      throw new Error(`Artifact at index ${index} is missing a non-empty "name".`);
    }
    if (paths.length === 0) {
      throw new Error(`Artifact "${name}" has no valid "path" entries.`);
    }
    results.push({ name: String(name).trim(), paths });
  }
  return results;
}

async function run() {
  try {
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const configPath = core.getInput('config', { required: true });
    const continueOnErrorInput = core.getInput('continue-on-error') || 'false';
    const continueOnError = String(continueOnErrorInput).toLowerCase() === 'true';
    const compressionLevelRaw = core.getInput('compression-level') || '';
    let compressionLevel = undefined;
    if (String(compressionLevelRaw).trim().length > 0) {
      const parsed = Number.parseInt(String(compressionLevelRaw), 10);
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 9) {
        throw new Error('compression-level must be an integer between 0 and 9.');
      }
      compressionLevel = parsed;
    }

    const absoluteConfigPath = path.isAbsolute(configPath)
      ? configPath
      : path.join(workspace, configPath);

    if (!(await pathExists(absoluteConfigPath))) {
      throw new Error(`Config file not found: ${configPath}`);
    }

    const raw = await fs.promises.readFile(absoluteConfigPath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Config file is not valid JSON: ${e.message}`);
    }

    const artifacts = ensureArrayOfArtifacts(parsed);
    if (artifacts.length === 0) {
      core.info('No artifacts to upload. Exiting.');
      return;
    }

    const client = new DefaultArtifactClient();

    for (const artifactDef of artifacts) {
      const files = await resolveInputPathsToFiles(workspace, artifactDef.paths);
      if (files.length === 0) {
        const message = `Artifact "${artifactDef.name}": no files matched any provided path.`;
        if (continueOnError) {
          core.warning(message);
          continue;
        } else {
          throw new Error(message);
        }
      }

      const rootDirectory = computeCommonRootDirectory(files);
      core.info(`Uploading artifact "${artifactDef.name}" with ${files.length} file(s).`);
      const uploadOptions = { continueOnError };
      if (typeof compressionLevel === 'number') {
        uploadOptions.compressionLevel = compressionLevel;
      }
      const result = await client.uploadArtifact(
        artifactDef.name,
        files,
        rootDirectory,
        uploadOptions
      );
      core.info(`Uploaded artifact "${result.artifactName}" with ${result.successfulItems} successful item(s).`);
    }
  } catch (err) {
    core.setFailed(err.message || String(err));
  }
}

run();


