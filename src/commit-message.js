import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function getCommitMessage (versions, cwd) {
	let { stdout } = await run('git', [ 'log', '--ignore-missing', '--no-merges', '-50', '--format=%s', 'HEAD', '--' ], { cwd });
	let subjects = stdout.split(/\r?\n/).filter(Boolean);
	let conventional = subjects.filter(subject => /^[a-z][a-z0-9-]*(?:\([^)]+\))?!?: \S/i.test(subject)).length > subjects.length / 2;
	let uniqueVersions = [ ...new Set(versions) ];
	let target = uniqueVersions.length === 1 ? `to v${uniqueVersions[0]}` : 'versions';
	return `${conventional ? 'chore: update' : 'Update'} node.js ${target}`;
}
