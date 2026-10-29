import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { DockerfileParser } from 'dockerfile-ast';
import semver from 'semver';

const run = promisify(execFile);

function normalizePlatform (platform) {
	let [ os, architecture, variant ] = platform.toLowerCase().split('/');
	let aliases = {
		'aarch64': [ 'arm64', variant ],
		'x86_64': [ 'amd64', variant ],
		'x86-64': [ 'amd64', variant ],
		'i386': [ '386' ],
		'armhf': [ 'arm', 'v7' ],
		'armel': [ 'arm', 'v6' ],
	};
	[ architecture, variant ] = aliases[architecture] || [ architecture, variant ];
	let variants = {
		arm64: { '8': '', 'v8': '', 'v8.0': '', '9': 'v9', '9.0': 'v9', 'v9.0': 'v9' },
		amd64: { v1: '' },
		arm: { 5: 'v5', 6: 'v6', 7: '', 8: 'v8', v7: '' },
	};
	variant = variants[architecture]?.[variant] ?? variant;
	return [ os === 'macos' ? 'darwin' : os, architecture, variant ].filter(Boolean).join('/');
}

export function getNodeImages (source) {
	let dockerfile = DockerfileParser.parse(source);
	let stages = new Set();
	let images = new Map();

	if (!dockerfile.getFROMs().length) {
		throw new Error('Dockerfile has no FROM instruction.');
	}

	for (let from of dockerfile.getFROMs()) {
		if (from.getVariables().some(variable => variable.getModifier() !== null)) {
			throw new Error(`Unsupported Dockerfile FROM variable modifier at line ${from.getRange().start.line + 1}.`);
		}

		let image = from.getExpandedArguments()[0]?.getValue();

		if (!image || /[$'"\\`]/.test(image)) {
			throw new Error(`Unable to resolve Dockerfile FROM image at line ${from.getRange().start.line + 1}.`);
		}

		if (!stages.has(image.toLowerCase()) && /^(?:(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\/)?(?:library\/)?node(?::|@|$)/.test(image)) {
			if (!images.has(image)) {
				images.set(image, new Set());
			}

			let platform = from.getPlatformFlag()?.getValue();

			if (platform && !platform.includes('$')) {
				images.get(image).add(platform);
			}
		}

		if (from.getBuildStage()) {
			stages.add(from.getBuildStage().toLowerCase());
		}
	}

	return [ ...images ].map(([ image, platforms ]) => ({ image, platforms: [ ...platforms ] }));
}

export async function inspectImage (image, command = run) {
	try {
		let { stdout } = await command('docker', [ 'buildx', 'imagetools', 'inspect', image, '--format', '{{json .Image}}' ], {
			timeout: 60_000,
			maxBuffer: 4 * 1024 * 1024,
		});

		return JSON.parse(stdout);
	} catch (error) {
		if (/\bmanifest unknown\b|^ERROR: [^\s]+: not found\s*$/i.test(error.stderr || '')) {
			return null;
		}

		throw new Error(`Unable to inspect Docker image ${image}: ${error.code || 'invalid registry response'}.`, { cause: error });
	}
}

export async function checkDockerImages (filename, updates, inspect = inspectImage) {
	let source;

	try {
		source = await readFile(filename, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') {
			return [];
		}

		throw error;
	}

	let minimums = new Map();
	let pending = [];

	for (let { version } of updates) {
		let major = semver.major(version);
		minimums.set(major, minimums.has(major) ? semver.maxSatisfying([ minimums.get(major), version ], '*') : version);
	}

	for (let { image, platforms } of getNodeImages(source)) {
		let taggedMajor = image.match(/node:(\d+)(?:[.\-@]|$)/)?.[1];

		if (taggedMajor && !minimums.has(Number(taggedMajor))) {
			continue;
		}

		let metadata = await inspect(image);
		let configs = metadata?.config
			? [ [ [ metadata.os, metadata.architecture, metadata.variant ].filter(Boolean).join('/'), metadata ] ]
			: Object.entries(metadata || {});

		if (!configs.length) {
			pending.push(`${image}: image is not published yet`);
			continue;
		}

		let available = new Set(configs.map(([ platform ]) => normalizePlatform(platform)));

		for (let platform of platforms) {
			if (!available.has(normalizePlatform(platform))) {
				pending.push(`${image}: required platform ${platform} is not published yet`);
			}
		}

		for (let [ , config ] of configs) {
			let version = config?.config?.Env?.find(value => value.startsWith('NODE_VERSION='))?.slice('NODE_VERSION='.length);

			if (!semver.valid(version) || semver.prerelease(version)) {
				throw new Error(`Docker image ${image} has no valid stable NODE_VERSION.`);
			}

			let required = minimums.get(taggedMajor ? Number(taggedMajor) : semver.major(version));

			if (required && (semver.major(version) !== semver.major(required) || semver.lt(version, required))) {
				pending.push(`${image} (${config.os}/${config.architecture}): Node.js ${version}, waiting for ${required}`);
			}
		}
	}

	return pending;
}
