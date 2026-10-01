import antfu from '@antfu/eslint-config';

export default antfu({
	stylistic: {
		indent: 'tab',
		quotes: 'single',
		semi: true,
	},

	typescript: true,

	ignores: [
		'build/dist/',
		'coverage/',
		'dist/',
		'node_modules/',
		'.eslintcache',
		'debug.log',
		// 测试用例由 esbuild 打包生成的中间产物，不参与风格检查
		'tests/*.mjs',
	],

	rules: {
		'no-console': ['warn', { allow: ['log', 'warn', 'error'] }],
	},
});
