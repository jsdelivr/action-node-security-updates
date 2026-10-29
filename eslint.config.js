import { defineConfig } from 'eslint/config';
import javascript from '@martin-kolarik/eslint-config';

export default defineConfig([
	{
		ignores: [ 'coverage/**', 'test/fixtures/**' ],
	},
	...javascript,
	{
		rules: {
			'@stylistic/curly-newline': [ 'error', {
				multiline: true,
				consistent: true,
				IfStatementConsequent: 'always',
				IfStatementAlternative: 'always',
			}],
		},
	},
	{
		files: [ 'test/**' ],

		rules: {
			'@stylistic/array-element-newline': 'off',
		},
	},
]);
