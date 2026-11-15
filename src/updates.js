import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyEdits, modify } from 'jsonc-parser';
import semver from 'semver';
import { checkDockerImages } from './docker-images.js';

export async function loadSources () {
	let url = 'https://nodejs.org/dist/index.json';
	let response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

	if (!response.ok) {
		throw new Error(`Unable to fetch ${url}: HTTP ${response.status}`);
	}

	return { index: await response.json() };
}

export async function findUpdates (range, options = {}) {
	if (typeof range !== 'string' || !semver.validRange(range)) {
		throw new Error('package.json must declare a valid engines.node minimum.');
	}

	let branches = range.split('||').map(part => part.trim());
	let minimums = branches.map(branch => semver.minVersion(branch));

	if (minimums.some(minimum => !minimum || minimum.major === 0 || minimum.prerelease.length)) {
		throw new Error('Each engines.node branch must have a stable, explicit Node.js major minimum.');
	}

	let { index } = options.index === undefined ? await loadSources() : options;

	if (!Array.isArray(index) || !index.length) {
		throw new Error('Invalid Node.js release index.');
	}

	let updates = [];

	for (let i = 0; i < branches.length; i++) {
		let minimum = minimums[i];
		let candidates = index.filter(release => release.security === true && semver.valid(release.version)
			&& semver.major(release.version) === minimum.major && semver.gt(release.version, minimum))
			.sort((a, b) => semver.rcompare(a.version, b.version));

		for (let candidate of candidates) {
			let version = semver.clean(candidate.version);

			let branch = branches[i];

			if (!semver.valid(branch) && !semver.satisfies(version, branch)) {
				throw new Error(`Security fix ${version} is outside the engines.node upper bound ${branch}; update that range manually.`);
			}

			if (semver.valid(branch)) {
				branches[i] = version;
			} else if (/^\^\s*\S+/.test(branch)) {
				branches[i] = branch.replace(/^\^\s*\S+/, `^${version}`);
			} else if (/^>=\s*\S+/.test(branch)) {
				branches[i] = branch.replace(/^>=\s*\S+/, `>=${version}`);
			} else {
				let upperBounds = new semver.Range(branch).set[0].filter(comparator => comparator.operator.startsWith('<'));
				branches[i] = [ `>=${version}`, ...upperBounds.map(comparator => comparator.value) ].join(' ');
			}

			let caret = `^${version}`;

			if (semver.validRange(branches[i]) === semver.validRange(caret)) {
				branches[i] = caret;
			}

			updates.push({ version, previous: minimum.version });
			break;
		}
	}

	return { range: updates.length ? branches.join(' || ') : range, updates };
}

export async function updatePackage (filename, options = {}) {
	let source = await readFile(filename, 'utf8');
	let manifest = JSON.parse(source);
	let result = await findUpdates(manifest.engines?.node, options);
	let files = [];

	if (!result.updates.length) {
		return { ...result, files };
	}

	let pendingImages = await checkDockerImages(path.join(options.workspace || path.dirname(filename), 'Dockerfile'), result.updates, options.inspectImage);

	if (pendingImages.length) {
		return { range: manifest.engines.node, updates: [], files, pendingImages };
	}

	let pending = [{ filename, source, jsonPath: [ 'engines', 'node' ] }];

	for (let name of [ 'package-lock.json', 'npm-shrinkwrap.json' ]) {
		let lockfile = path.join(path.dirname(filename), name);
		let lockSource;

		try {
			lockSource = await readFile(lockfile, 'utf8');
		} catch (error) {
			if (error.code === 'ENOENT') {
				continue;
			}

			throw error;
		}

		let lock = JSON.parse(lockSource);

		if (lock.packages?.['']) {
			pending.push({ filename: lockfile, source: lockSource, jsonPath: [ 'packages', '', 'engines', 'node' ] });
		}
	}

	for (let file of pending) {
		let updated = applyEdits(file.source, modify(file.source, file.jsonPath, result.range, {
			formattingOptions: {
				insertSpaces: !/^\t/m.test(file.source),
				tabSize: file.source.match(/^ +(?! )/m)?.[0].length ?? 2,
				eol: file.source.includes('\r\n') ? '\r\n' : '\n',
			},
		}));

		if (updated !== file.source) {
			await writeFile(file.filename, updated);
			files.push(file.filename);
		}
	}

	return { ...result, files };
}
