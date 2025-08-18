module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: ['tsconfig.base.json', 'tsconfig.json'],
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin', 'import'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js'],
  settings: {
    'import/resolver': {
      typescript: {
        project: ['tsconfig.base.json', 'tsconfig.json'],
      },
    },
    'import/internal-regex': '^@common/|^@cli/|^@daemon/|^@app/|^@bootstrap/',
  },
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    // https://gist.github.com/phatnguyenuit/149094cb3a28e30f5f4c891d264bf7e6
    'sort-imports': [
      'error',
      {
        ignoreCase: false,
        ignoreDeclarationSort: true, // don't want to sort import lines, use eslint-plugin-import instead
        ignoreMemberSort: false,
        memberSyntaxSortOrder: ['none', 'all', 'multiple', 'single'],
        allowSeparatedGroups: true,
      },
    ],
    // turn on errors for missing imports
    'import/no-unresolved': 'error',
    // 'import/no-named-as-default-member': 'off',
    'import/order': [
      'error',
      {
        groups: [
          'builtin',
          'external',
          'internal',
          ['parent', 'sibling', 'index'],
          'unknown'
        ],
        pathGroups: [
          { pattern: '@common/**', group: 'internal', position: 'after' },
          { pattern: '@cli/**', group: 'internal', position: 'after' },
          { pattern: '@daemon/**', group: 'internal', position: 'after' },
          { pattern: '@app/**', group: 'internal', position: 'after' },
          { pattern: '@bootstrap/**', group: 'internal', position: 'after' }
        ],
        pathGroupsExcludedImportTypes: ['builtin'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true },
      },
    ],
    'prettier/prettier': ['error'],
    '@typescript-eslint/no-unused-vars': [
      'warn',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }
    ],
  },
};
