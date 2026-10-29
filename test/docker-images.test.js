import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkDockerImages, getNodeImages, inspectImage } from '../src/docker-images.js';

const updates = [{ version: '22.8.1' }, { version: '24.3.1' }];

function config (version, architecture = 'amd64') {
	return { os: 'linux', architecture, config: { Env: [ 'PATH=/usr/bin', `NODE_VERSION=${version}` ] } };
}

async function fixture (t, source = 'FROM node:24-slim') {
	let directory = await mkdtemp(path.join(tmpdir(), 'node-security-docker-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let filename = path.join(directory, 'Dockerfile');
	await writeFile(filename, source);
	return filename;
}

test('parses Node base images with ARG defaults, continuations, registry aliases and stage reuse', () => {
	let source = [
		'ARG VERSION=24',
		'ARG BASE=docker.io/library/node:24-slim',
		'FROM --platform=linux/amd64 ${BASE} AS builder',
		'FROM builder AS node',
		'FROM node',
		'FROM node:${VERSION}-slim AS runtime',
		'FROM \\',
		'  node:24-slim AS repeated',
		'FROM nginx:alpine',
	].join('\n');
	assert.deepEqual(getNodeImages(source), [
		{ image: 'docker.io/library/node:24-slim', platforms: [ 'linux/amd64' ] },
		{ image: 'node:24-slim', platforms: [] },
	]);

	assert.deepEqual(getNodeImages('FROM index.docker.io/library/node:22\nFROM registry-1.docker.io/library/node:24'), [
		{ image: 'index.docker.io/library/node:22', platforms: [] },
		{ image: 'registry-1.docker.io/library/node:24', platforms: [] },
	]);
});

test('ignores unrelated images and rejects unresolved or malformed FROM instructions', () => {
	assert.deepEqual(getNodeImages('FROM example.com/node:24\nFROM directus/directus:11'), []);
	assert.throws(() => getNodeImages('ARG VERSION\nFROM node:${VERSION}-slim'), /resolve.*FROM/);
	assert.throws(() => getNodeImages('FROM'), /resolve.*FROM/);
	assert.throws(() => getNodeImages('RUN echo hello'), /no FROM/);
});

test('rejects FROM substitutions the parser cannot expand with Docker semantics', () => {
	for (let source of [
		'ARG WITH_NODE=true\nFROM ${WITH_NODE:+node:24-slim}',
		'ARG VARIANT=slim\nFROM node:24-${VARIANT:+alpine}',
		'ARG VERSION\nFROM node:${VERSION:-24}-slim',
	]) {
		assert.throws(() => getNodeImages(source), /Unsupported.*modifier/);
	}
});

test('rejects quote and escape syntax before it can hide an official Node base', () => {
	for (let source of [
		'FROM "node:24-slim"', 'FROM \'node:24-slim\'',
		'ARG IMAGE=node:24-slim\nFROM "${IMAGE}"',
		'FROM "node":24-slim',
	]) {
		assert.throws(() => getNodeImages(source), /Unable to resolve.*FROM/);
	}

	assert.deepEqual(getNodeImages('FROM n\\ode:24-slim'), [{ image: 'node:24-slim', platforms: [] }]);
});

test('uses structured Buildx config inspection without pulling or running the image', async () => {
	let metadata = { 'linux/amd64': config('24.3.1'), 'linux/arm64': config('24.3.1', 'arm64') };
	let result = await inspectImage('node:24-slim', async (command, args, options) => {
		assert.equal(command, 'docker');
		assert.deepEqual(args, [ 'buildx', 'imagetools', 'inspect', 'node:24-slim', '--format', '{{json .Image}}' ]);
		assert.ok(options.timeout > 0);
		return { stdout: JSON.stringify(metadata) };
	});
	assert.deepEqual(result, metadata);
});

test('defers missing manifests but fails on registry, authentication and command errors', async () => {
	for (let stderr of [ 'ERROR: docker.io/library/node:24-slim: not found', 'manifest unknown' ]) {
		assert.equal(await inspectImage('node:24-slim', async () => { throw Object.assign(new Error(), { stderr }); }), null);
	}

	for (let stderr of [
		'unauthorized', '429 Too Many Requests', '500 Server Error', 'network timeout',
		'docker-credential-test: executable file not found',
		'ERROR: failed to inspect manifest: error getting credentials - err: exec: "docker-credential-test": executable file not found in $PATH',
	]) {
		await assert.rejects(inspectImage('node:24-slim', async () => { throw Object.assign(new Error('private diagnostic'), { stderr }); }), /Unable to inspect.*invalid registry response/);
	}

	await assert.rejects(inspectImage('node:24-slim', async () => ({ stdout: 'invalid json' })), /invalid registry response/);
});

test('accepts the security version or later patches in every advertised platform', async (t) => {
	let filename = await fixture(t);
	assert.deepEqual(await checkDockerImages(filename, updates, async () => ({
		'linux/amd64': config('24.3.1'),
		'linux/arm64': config('24.4.0', 'arm64'),
	})), []);

	assert.deepEqual(await checkDockerImages(filename, updates, async () => config('24.3.1')), []);
});

test('waits when any advertised platform is behind or has the wrong major', async (t) => {
	let filename = await fixture(t);
	let pending = await checkDockerImages(filename, updates, async () => ({
		'linux/amd64': config('24.3.1'),
		'linux/arm64': config('24.2.1', 'arm64'),
	}));
	assert.deepEqual(pending, [ 'node:24-slim (linux/arm64): Node.js 24.2.1, waiting for 24.3.1' ]);
	assert.equal((await checkDockerImages(filename, updates, async () => config('26.2.1'))).length, 1);
});

test('deduplicates stages and ignores majors without a pending security update', async (t) => {
	let filename = await fixture(t, 'FROM node:24-slim AS builder\nFROM node:24-slim\nFROM node:26-slim');
	let calls = [];
	assert.deepEqual(await checkDockerImages(filename, updates, async (image) => {
		calls.push(image);
		return config('24.3.1');
	}), []);

	assert.deepEqual(calls, [ 'node:24-slim' ]);
});

test('waits for literal FROM platforms and deduplicates their image inspection', async (t) => {
	let filename = await fixture(t, 'FROM --platform=linux/amd64 node:24-slim AS build\nFROM --platform=linux/arm64 node:24-slim');
	let calls = 0;
	let metadata = { 'linux/amd64': config('24.3.1') };
	let inspect = async () => { calls++; return metadata; };
	assert.deepEqual(await checkDockerImages(filename, updates, inspect), [ 'node:24-slim: required platform linux/arm64 is not published yet' ]);
	assert.equal(calls, 1);
	metadata['linux/arm64'] = config('24.3.1', 'arm64');
	assert.deepEqual(await checkDockerImages(filename, updates, inspect), []);
});

test('recognizes default platform variants without accepting different variants', async (t) => {
	for (let [ required, advertised ] of [
		[ 'linux/arm64/v8', 'linux/arm64' ], [ 'linux/arm64', 'linux/arm64/v8' ],
		[ 'linux/amd64/v1', 'linux/amd64' ], [ 'linux/arm', 'linux/arm/v7' ],
		[ 'linux/x86_64', 'linux/amd64' ], [ 'linux/x86-64', 'linux/amd64' ],
		[ 'linux/aarch64', 'linux/arm64' ], [ 'linux/aarch64/v8.0', 'linux/arm64' ],
		[ 'linux/i386', 'linux/386' ], [ 'linux/armhf', 'linux/arm/v7' ],
		[ 'linux/armel', 'linux/arm/v6' ], [ 'linux/arm/7', 'linux/arm/v7' ],
		[ 'linux/arm/6', 'linux/arm/v6' ], [ 'linux/arm64/9.0', 'linux/arm64/v9' ],
		[ 'LINUX/AMD64', 'linux/amd64' ],
	]) {
		let filename = await fixture(t, `FROM --platform=${required} node:24-slim`);
		assert.deepEqual(await checkDockerImages(filename, updates, async () => ({ [advertised]: config('24.3.1') })), []);
	}

	let filename = await fixture(t, 'FROM --platform=linux/arm/v6 node:24-slim');
	assert.equal((await checkDockerImages(filename, updates, async () => ({ 'linux/arm/v7': config('24.3.1') }))).length, 1);
	assert.equal((await checkDockerImages(filename, updates, async () => ({ 'linux/amd64': config('24.3.1') }))).length, 1);
});

test('uses advertised platforms when the Dockerfile platform depends on the build', async (t) => {
	let filename = await fixture(t, 'FROM --platform=$BUILDPLATFORM node:24-slim');
	assert.deepEqual(await checkDockerImages(filename, updates, async () => ({ 'linux/amd64': config('24.3.1') })), []);
});

test('checks unversioned tags and keeps the highest security floor per major', async (t) => {
	let filename = await fixture(t, 'FROM node:lts-slim');
	let pending = await checkDockerImages(filename, [ ...updates, { version: '24.4.1' }], async () => config('24.3.1'));
	assert.match(pending[0], /waiting for 24\.4\.1/);
});

test('keeps pinned images unchanged and waits for their required security version', async (t) => {
	let filename = await fixture(t, `FROM node:24.2.1-slim@sha256:${'a'.repeat(64)}`);
	assert.equal((await checkDockerImages(filename, updates, async () => config('24.2.1'))).length, 1);
});

test('defers unpublished images and rejects missing or invalid version metadata', async (t) => {
	let filename = await fixture(t);
	assert.match((await checkDockerImages(filename, updates, async () => null))[0], /not published yet/);

	for (let metadata of [{}, { config: { Env: [] } }, config('bad'), config('24.3.1-rc.1') ]) {
		await assert.rejects(checkDockerImages(filename, updates, async () => ({ 'linux/amd64': metadata })), /valid stable NODE_VERSION/);
	}
});

test('does not require Docker when the root Dockerfile is absent or has no Node base', async (t) => {
	let filename = await fixture(t, 'FROM alpine');
	let inspect = () => { throw new Error('should not inspect'); };
	assert.deepEqual(await checkDockerImages(filename, updates, inspect), []);
	assert.deepEqual(await checkDockerImages(`${filename}.missing`, updates, inspect), []);
});
