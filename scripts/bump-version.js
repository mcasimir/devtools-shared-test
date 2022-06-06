const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const assert = require('assert');

const gitLogParser = require('git-log-parser');
const semver = require('semver');

const LAST_BUMP_COMMIT_MESSAGE = 'chore(ci): bump packages';

async function main() {
  if (!fs.existsSync('./package.json') || !fs.existsSync('.git')) {
    throw new Error('this command can only be run from the root of a monorepo');
  }

  const monorepoRootPath = process.cwd();
  const packages = getPackages(monorepoRootPath);

  const newVersions = [];
  for (const packageInfo of packages) {
    await processPackage(
      path.relative(monorepoRootPath, packageInfo.location),
      newVersions
    );
  }

  childProcess.spawnSync('npm', ['install', '--package-lock-only']);
}

main(...process.argv.slice(2));

function getPackages(cwd) {
  const { stdout } = childProcess.spawnSync(
    'npx',
    ['lerna', 'list', '--toposort', '--all', '--json'],
    { cwd }
  );

  return JSON.parse(stdout);
}

async function getCommits({ path }) {
  return new Promise((resolve) => {
    const stream = gitLogParser.parse({
      _: ['remotes/origin/main', path],
    });

    const commits = [];

    stream.on('data', (commit) => commits.push(commit));
    stream.on('end', () => resolve(commits));
  });
}

function maxIncrement(inc1, inc2) {
  if (inc1 && inc2) {
    return semver.gt(semver.inc('1.0.0', inc1), semver.inc('1.0.0', inc2))
      ? inc1
      : inc2;
  }

  // return the first defined or undefined in neither are set
  return inc1 || inc2;
}

function updateDeps(packageJson, newVersions) {
  const newPackageJson = { ...packageJson };

  let inc;

  for (const sectionName of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const section = newPackageJson[sectionName];
    if (!section) {
      continue;
    }

    for (const [depName, { version, inc: depInc }] of Object.entries(
      newVersions
    )) {
      section[depName] = version;

      // we increment the package version based on the bump on dependencies:
      // if a devDependency was bumped, regardless of the increment we increment of a
      // patch, otherwise we replicate the increment of the dependency. We always keep
      // the biggest increase.

      inc =
        section === 'devDependencies'
          ? maxIncrement('patch', inc)
          : maxIncrement(depInc, inc);
    }
  }

  if (inc) {
    newPackageJson.version = semver.inc(packageJson.version, inc);
  }

  return newPackageJson;
}

async function bumpVersionBasedOnCommits(packagePath, oldVersion) {
  const allCommits = await getCommits({
    path: packagePath,
  });

  const lastBumpIndex = allCommits.findIndex((c) =>
    c.subject.startsWith(LAST_BUMP_COMMIT_MESSAGE)
  );

  const commits =
    lastBumpIndex === -1 ? allCommits : allCommits.slice(0, lastBumpIndex);

  if (!commits.length) {
    return oldVersion;
  }

  let inc = 'patch';

  // calculate bump as follows:
  // if any commit body contains BREAKING CHANGE or BREAKING CHANGES
  // -> then is a major bump
  // if subject starts with feat or fix
  // -> then is a minor bump
  // everything else is a patch.
  //
  for (const { subject, body } of commits) {
    if (
      /\bBREAKING CHANGES?\b/.test(subject) ||
      /\bBREAKING CHANGES?\b/.test(body)
    ) {
      inc = 'major';
      break;
    }

    if (/^(feat|fix)[:(]/.test(subject)) {
      inc = maxIncrement(inc, 'minor');
      continue;
    }

    inc = maxIncrement(inc, 'patch');
  }

  return semver.inc(oldVersion, inc);
}

// walk the dep tree up

async function processPackage(packagePath, newVersions, options) {
  const packageJsonPath = path.join(packagePath, 'package.json');

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath));

  const packageJsonAfterDepBump = updateDeps(packageJson, newVersions);

  const conventionalVersion = await bumpVersionBasedOnCommits(
    packagePath,
    packageJson.version,
    options
  );

  const newVersion = semver.gt(
    conventionalVersion,
    packageJsonAfterDepBump.version
  )
    ? conventionalVersion
    : packageJsonAfterDepBump.version;

  if (semver.gt(newVersion, packageJson.version)) {
    newVersions[packageJson.name] = {
      version: newVersion,
      bump: semver.diff(newVersion, packageJson.version),
    };
  }

  const newPackageJson = { ...packageJsonAfterDepBump, version: newVersion };

  if (!deepEqual(newPackageJson, packageJson)) {
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify(newPackageJson, null, 2),
      'utf-8'
    );
  }
}

const deepEqual = (obj1, obj2) => {
  try {
    assert.deepEqual(obj1, obj2);
    return true;
  } catch (error) {
    return false;
  }
};
