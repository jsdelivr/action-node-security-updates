import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { create } from 'tar';
import semver from 'semver';
import { findUpdates, loadSources, updatePackage } from '../src/updates.js';

const index = [
	{ version: 'v26.2.1', date: '2026-06-02', security: true },
	{ version: 'v24.4.0', date: '2026-06-03', security: false },
	{ version: 'v24.3.1', date: '2026-06-02', security: true },
	{ version: 'v24.2.1', date: '2026-05-02', security: true },
	{ version: 'v22.8.1', date: '2026-06-02', security: true },
];

const advisories = [
	{ id: '1', patched: '^24.3.1', severity: 'high', url: 'https://github.com/nodejs/security-wg/blob/main/vuln/core/1.json', cve: [ 'CVE-2026-10001' ] },
	{ id: '2', patched: '^22.8.1', severity: 'medium', url: 'https://github.com/nodejs/security-wg/blob/main/vuln/core/2.json' },
	{ id: '3', patched: '^26.2.1', severity: 'critical', url: 'https://github.com/nodejs/security-wg/blob/main/vuln/core/3.json' },
	{ id: '4', patched: '^24.2.1', severity: 'critical', url: 'https://github.com/nodejs/security-wg/blob/main/vuln/core/4.json' },
];

async function find (range, options = {}) {
	return findUpdates(range, { index, advisories, ...options });
}

test('selects security fixes within the existing major, excluding normal releases', async () => {
	let result = await find('>=24.0.0 <25');
	assert.equal(result.range, '>=24.3.1 <25');
	assert.deepEqual(result.updates.map(update => update.version), [ '24.3.1' ]);
});

test('filters severity per major and updates independent OR branches', async () => {
	let result = await find('^22.0.0 || ^24.0.0');
	assert.equal(result.range, '^22.0.0 || ^24.3.1');
});

test('critical threshold can select an earlier qualifying security release', async () => {
	let result = await find('^24.0.0', { minimumSeverity: 'critical' });
	assert.equal(result.range, '^24.2.1');
});

test('does nothing when the minimum already includes all security fixes', async () => {
	let result = await find('>=24.3.1', {});
	assert.equal(result.range, '>=24.3.1');
	assert.deepEqual(result.updates, []);
});

test('handles common engines notations', async () => {
	assert.equal((await find('24')).range, '>=24.3.1 <25.0.0-0');
	assert.equal((await find('^24')).range, '^24.3.1');
	assert.equal((await find('>= 24')).range, '>=24.3.1');
});

test('does not turn an open-ended minimum into an upgrade to another major', async () => {
	assert.equal((await find('>=24')).range, '>=24.3.1');
});

test('advances exact versions and normalizes major wildcards without adding majors', async () => {
	assert.equal((await find('24.0.0')).range, '24.3.1');
	assert.equal((await find('24.x')).range, '>=24.3.1 <25.0.0-0');
});

for (let range of [ '~24', '~24.x', '~24.3', '~24.3.0' ]) {
	test(`preserves the upper bound when raising ${range}`, async () => {
		let result = await find(range);
		assert.equal(semver.minVersion(result.range).version, '24.3.1');

		for (let version of [ '24.3.1', '24.3.9', '24.4.0', '24.9.0', '25.0.0' ]) {
			assert.equal(semver.satisfies(version, result.range), semver.satisfies(version, range), version);
		}
	});
}

test('preserves tilde upper bounds inside OR ranges', async () => {
	let result = await find('~24 || ^26.0.0');
	assert.equal(semver.satisfies('24.9.0', result.range), true);
	assert.equal(semver.satisfies('25.0.0', result.range), false);
	assert.equal(semver.satisfies('26.3.0', result.range), true);
});

test('unpublished fixes and normal releases alone do not qualify', async () => {
	let result = await find('>=24', { index: index.filter(release => !release.security) });
	assert.deepEqual(result.updates, []);
});

test('fails visibly when a published security release has no advisory', async () => {
	await assert.rejects(find('>=24', { advisories: [] }), /classify.*24\.3\.1/i);
});

test('fails visibly when severity is unknown for a relevant security release', async () => {
	await assert.rejects(find('>=24', { advisories: [{ patched: '^24.3.1', severity: 'unknown' }] }), /severity.*24\.3\.1/i);
});

test('does not classify later releases as fixes merely because a patched range includes them', async () => {
	await assert.rejects(find('>=24', { advisories: advisories.filter(item => item.id !== '1') }), /classify.*24\.3\.1/i);
});

test('loads individual official JSON advisories, ignoring a stale aggregate index', async (t) => {
	let directory = await mkdtemp(path.join(tmpdir(), 'node-security-source-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let fixture = await readFile(new URL('./fixtures/security-wg/vuln/core/196.json', import.meta.url));
	await writeFile(path.join(directory, 'index.json'), '[]');
	await writeFile(path.join(directory, '196.json'), fixture);
	let chunks = [];

	for await (let chunk of create({ gzip: true, cwd: directory, prefix: 'security-wg-main/vuln/core' }, [ 'index.json', '196.json' ])) { chunks.push(chunk); }

	let archive = Buffer.concat(chunks);
	t.mock.method(globalThis, 'fetch', async url => new Response(url.endsWith('index.json') ? JSON.stringify(index) : archive));
	let sources = await loadSources();
	assert.deepEqual(sources.index, index);
	assert.equal(sources.advisories.length, 1);
	assert.equal(sources.advisories[0].patched, '^22.23.4 || ^24.22.1 || ^26.12.1');
	assert.deepEqual(sources.advisories[0].cve, [ 'CVE-2026-105482' ]);
	let result = await findUpdates('^24.0.0', { ...sources, index: [{ version: 'v24.22.1', security: true }] });
	assert.equal(result.range, '^24.22.1');
	assert.equal(result.updates[0].severity, 'high');
});

test('rejects invalid archives instead of reporting no updates', async (t) => {
	t.mock.method(globalThis, 'fetch', async url => new Response(url.endsWith('index.json') ? JSON.stringify(index) : 'not a tar archive'));
	await assert.rejects(loadSources());
});

for (let source of [ '{', '{"patched":"not a semver range"}' ]) {
	test(`rejects a malformed advisory after a valid record: ${source}`, async (t) => {
		let directory = await mkdtemp(path.join(tmpdir(), 'node-security-source-'));
		t.after(() => rm(directory, { recursive: true, force: true }));
		await writeFile(path.join(directory, '1.json'), JSON.stringify({ patched: '^24.3.1', severity: 'high' }));
		await writeFile(path.join(directory, '2.json'), source);
		let chunks = [];

		for await (let chunk of create({ gzip: true, cwd: directory, prefix: 'security-wg-main/vuln/core' }, [ '1.json', '2.json' ])) { chunks.push(chunk); }

		t.mock.method(globalThis, 'fetch', async url => new Response(url.endsWith('index.json') ? JSON.stringify(index) : Buffer.concat(chunks)));
		await assert.rejects(loadSources(), /JSON|patched range/);
	});
}

test('network errors remain errors rather than being treated as no update', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));
	await assert.rejects(loadSources(), /HTTP 503/);
});

test('does not widen an upper bound to fit a security update', async () => {
	await assert.rejects(find('>=24.0.0 <24.2'), /upper bound|outside/i);
});

test('rejects missing version floors and invalid thresholds', async () => {
	await assert.rejects(find('*'), /minimum/i);
	await assert.rejects(find('>=24', { minimumSeverity: 'urgent' }), /severity/i);
});

test('updates only engine values, keeps formatting, and synchronizes lockfile metadata', async (t) => {
	let directory = await mkdtemp(path.join(tmpdir(), 'node-security-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let original = '{\r\n  "name": "service",\r\n  "engines": { "node": ">=24", "npm": ">=10" }\r\n}\r\n';
	await writeFile(path.join(directory, 'package.json'), original);
	await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { engines: { node: '>=24' } }, 'node_modules/test': { version: '1.0.0' } } }));
	let result = await updatePackage(path.join(directory, 'package.json'), { index, advisories });
	assert.equal(await readFile(path.join(directory, 'package.json'), 'utf8'), original.replace('>=24', '>=24.3.1'));
	let lock = JSON.parse(await readFile(path.join(directory, 'package-lock.json'), 'utf8'));
	assert.equal(lock.packages[''].engines.node, '>=24.3.1');
	assert.equal(lock.packages['node_modules/test'].version, '1.0.0');
	assert.equal(result.files.length, 2);
});
