import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { getCommitMessage } from '../src/commit-message.js';

const run = promisify(execFile);

async function git (cwd, ...args) {
	return run('git', args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Test',
			GIT_AUTHOR_EMAIL: 'test@example.com',
			GIT_COMMITTER_NAME: 'Test',
			GIT_COMMITTER_EMAIL: 'test@example.com',
		},
	});
}

async function repository (t, subjects) {
	let directory = await mkdtemp(path.join(tmpdir(), 'node-commit-style-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await git(directory, 'init', '--quiet');
	let tree = (await git(directory, 'write-tree')).stdout.trim();
	let parent;

	for (let subject of subjects) {
		parent = (await git(directory, 'commit-tree', tree, ...parent ? [ '-p', parent ] : [], '-m', subject)).stdout.trim();
	}

	if (parent) {
		await git(directory, 'update-ref', 'HEAD', parent);
	}

	return directory;
}

for (let { name, subjects, versions, expected } of [
	{ name: 'plain majority', subjects: [ 'Update dependencies', 'fix: handle failures', 'Add tests' ], versions: [ '24.22.1' ], expected: 'Update node.js to v24.22.1' },
	{ name: 'conventional majority including scopes and breaking changes', subjects: [ 'fix: handle failures', 'feat(api)!: change response', 'refactor!: simplify', 'Update dependencies' ], versions: [ '24.22.1' ], expected: 'chore: update node.js to v24.22.1' },
	{ name: 'mixed-case conventional majority', subjects: [ 'FIX: handle failures', 'Feat(api)!: change response', 'Update dependencies' ], versions: [ '24.22.1' ], expected: 'chore: update node.js to v24.22.1' },
	{ name: 'tie', subjects: [ 'fix: handle failures', 'Update dependencies' ], versions: [ '24.22.1' ], expected: 'Update node.js to v24.22.1' },
	{ name: 'empty history', subjects: [], versions: [ '24.22.1' ], expected: 'Update node.js to v24.22.1' },
	{ name: 'includes this action’s commits', subjects: [ 'chore: update node.js to v24.3.1', 'chore: update node.js versions', 'Update dependencies' ], versions: [ '24.22.1' ], expected: 'chore: update node.js to v24.22.1' },
	{ name: 'several versions with plain style', subjects: [ 'Update dependencies' ], versions: [ '22.23.4', '24.22.1' ], expected: 'Update node.js versions' },
	{ name: 'several versions with conventional style', subjects: [ 'fix: handle failures' ], versions: [ '22.23.4', '24.22.1' ], expected: 'chore: update node.js versions' },
	{ name: 'one distinct version in overlapping ranges', subjects: [ 'Update dependencies' ], versions: [ '24.22.1', '24.22.1' ], expected: 'Update node.js to v24.22.1' },
]) {
	test(`formats the update message using ${name}`, async (t) => {
		let directory = await repository(t, subjects);
		assert.equal(await getCommitMessage(versions, directory), expected);
	});
}

test('ignores merge commits when detecting the majority style', async (t) => {
	let directory = await repository(t, [ 'fix: handle failures', 'Update dependencies' ]);
	let tree = (await git(directory, 'write-tree')).stdout.trim();
	let head = (await git(directory, 'rev-parse', 'HEAD')).stdout.trim();
	let root = (await git(directory, 'rev-parse', 'HEAD~1')).stdout.trim();
	let merge = (await git(directory, 'commit-tree', tree, '-p', head, '-p', root, '-m', 'feat: merge changes')).stdout.trim();
	await git(directory, 'update-ref', 'HEAD', merge);
	assert.equal(await getCommitMessage([ '24.22.1' ], directory), 'Update node.js to v24.22.1');
});

test('uses only the most recent 50 non-merge commits', async (t) => {
	let subjects = [ 'fix: older change', ...Array(25).fill('fix: recent change'), ...Array(25).fill('Update dependencies') ];
	let directory = await repository(t, subjects);
	assert.equal(await getCommitMessage([ '24.22.1' ], directory), 'Update node.js to v24.22.1');
});

test('does not disguise a Git failure as plain-style history', async (t) => {
	let directory = await mkdtemp(path.join(tmpdir(), 'node-not-a-repository-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await assert.rejects(getCommitMessage([ '24.22.1' ], directory), /not a git repository/i);
});
