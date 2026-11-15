import path from 'node:path';
import * as core from '@actions/core';
import { getCommitMessage } from './commit-message.js';
import { updatePackage } from './updates.js';

try {
	let workspace = process.env.GITHUB_WORKSPACE || process.cwd();
	let filename = path.resolve(workspace, process.env.PACKAGE_FILE || 'package.json');
	let relative = path.relative(workspace, filename);

	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error('package-file must be inside the caller checkout.');
	}

	let result = await updatePackage(filename, { workspace });

	core.setOutput('deferred', Boolean(result.pendingImages?.length));
	core.setOutput('updated', result.updates.length > 0);
	core.setOutput('node-range', result.range);
	core.setOutput('changed-files', result.files.map(file => path.relative(workspace, file).split(path.sep).join('/')).join('\n'));
	core.setOutput('commit-message', await getCommitMessage(result.updates.map(update => update.version), workspace));

	let body = [
		'Raise the minimum supported Node.js version for security fixes.',
		'',
		...result.updates.map(update => `- Node.js ${update.previous} → ${update.version}.`),
	].join('\n');

	core.setOutput('pr-body', body);

	if (result.pendingImages?.length) {
		core.info(`Waiting for Docker image publication; leaving the existing PR untouched:\n${result.pendingImages.join('\n')}`);
	} else {
		core.info(result.updates.length ? `Updated engines.node to ${result.range}` : 'No qualifying Node.js security updates.');
	}
} catch (error) {
	core.setFailed(error.message);
}
