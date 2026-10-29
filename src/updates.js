import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Parser } from 'tar';
import { applyEdits, modify } from 'jsonc-parser';
import semver from 'semver';
import { checkDockerImages } from './docker-images.js';

const severities = [ 'low', 'medium', 'high', 'critical' ];

async function getResponse (url) {
	let response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

	if (!response.ok) {
		throw new Error(`Unable to fetch ${url}: HTTP ${response.status}`);
	}

	return response;
}

export async function loadSources () {
	let [ indexResponse, archive ] = await Promise.all([
		getResponse('https://nodejs.org/dist/index.json'),
		getResponse('https://codeload.github.com/nodejs/security-wg/tar.gz/refs/heads/main'),
	]);
	let advisories = [];

	// Read individual records; the generated core/index.json can lag behind them.
	// Parse in memory without extracting any archive paths onto the caller's disk.
	let parser = new Parser({
		strict: true,
		onReadEntry (entry) {
			let match = entry.path.match(/^[^/]+\/vuln\/core\/(\d+)\.json$/);

			if (!match || entry.type !== 'File') {
				entry.resume(); return;
			}

			let chunks = [];
			entry.on('data', (chunk) => { chunks.push(chunk); });

			entry.on('end', () => {
				try {
					let advisory = JSON.parse(Buffer.concat(chunks).toString('utf8'));

					if (!semver.validRange(advisory.patched)) {
						throw new Error(`Invalid patched range in advisory ${match[1]}.`);
					}

					advisories.push({ ...advisory, id: match[1], url: `https://github.com/nodejs/security-wg/blob/main/vuln/core/${match[1]}.json` });
				} catch (error) {
					parser.abort(error);
				}
			});
		},
	});

	await pipeline(Readable.fromWeb(archive.body), parser);

	if (!advisories.length) {
		throw new Error('Node.js security archive has no individual core advisories.');
	}

	return { index: await indexResponse.json(), advisories };
}

export async function findUpdates (range, options = {}) {
	let { minimumSeverity = 'high' } = options;

	if (!severities.includes(minimumSeverity)) {
		throw new Error(`Invalid minimum severity: ${minimumSeverity}`);
	}

	if (typeof range !== 'string' || !semver.validRange(range)) {
		throw new Error('package.json must declare a valid engines.node minimum.');
	}

	let branches = range.split('||').map(part => part.trim());
	let minimums = branches.map(branch => semver.minVersion(branch));

	if (minimums.some(minimum => !minimum || minimum.major === 0 || minimum.prerelease.length)) {
		throw new Error('Each engines.node branch must have a stable, explicit Node.js major minimum.');
	}

	let { index, advisories } = options.index && options.advisories ? options : await loadSources();

	if (!Array.isArray(index) || !index.length || !Array.isArray(advisories)) {
		throw new Error('Invalid Node.js release index or security advisories.');
	}

	let fixes = new Map();

	for (let advisory of advisories) {
		if (typeof advisory.patched !== 'string' || !semver.validRange(advisory.patched)) {
			throw new Error('Invalid advisory patched range.');
		}

		for (let branch of advisory.patched.split('||')) {
			let fixed = semver.minVersion(branch);

			if (!fixed || fixed.prerelease.length) {
				throw new Error('Invalid advisory fixed version.');
			}

			if (!fixes.has(fixed.version)) {
				fixes.set(fixed.version, []);
			}

			fixes.get(fixed.version).push(advisory);
		}
	}

	let updates = [];

	for (let i = 0; i < branches.length; i++) {
		let minimum = minimums[i];
		let candidates = index.filter(release => release.security === true && semver.valid(release.version)
			&& semver.major(release.version) === minimum.major && semver.gt(release.version, minimum))
			.sort((a, b) => semver.rcompare(a.version, b.version));

		for (let candidate of candidates) {
			let version = semver.clean(candidate.version);
			let releaseAdvisories = fixes.get(version);

			if (!releaseAdvisories) {
				throw new Error(`Unable to classify published Node.js security release ${version}.`);
			}

			if (releaseAdvisories.some(advisory => !severities.includes(advisory.severity))) {
				throw new Error(`Unknown advisory severity for Node.js ${version}.`);
			}

			let severity = severities[Math.max(...releaseAdvisories.map(advisory => severities.indexOf(advisory.severity)))];

			if (severities.indexOf(severity) < severities.indexOf(minimumSeverity)) {
				continue;
			}

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

			updates.push({ version, severity, advisories: releaseAdvisories, previous: minimum.version });
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
