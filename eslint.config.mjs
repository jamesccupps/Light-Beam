// Lint (1.15.0, the audit's D-3): ESLint's recommended rules, with each part's own globals. `npx eslint .`; the CI
// workflow (.github/workflows/ci.yml) runs it with the server and Family tests on every push.
import js from '@eslint/js';
import globals from 'globals';

const shared = {
  // (arguments named for what they are, kept unused; an ignored error in a catch says what it ignores; `_` reads
  // something through)
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  // Left out on purpose: control characters in patterns are how names and texts are cleaned of them; errors are
  // wrapped in friendlier words where they're caught; and "useless assignment" misreads values a finally uses.
  'no-control-regex': 'off',
  'preserve-caught-error': 'off',
  'no-useless-assignment': 'off',
};

export default [
  { ignores: ['**/node_modules/**', 'android/**', 'windows/bin/**', 'windows/obj/**', 'windows/lib/**', 'dist/**', 'data/**', '**/build/**', 'public/novnc/**'] },
  js.configs.recommended,
  {
    // Node, CommonJS: both servers and their modules, the CLI, the server tests
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: { ecmaVersion: 2025, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: shared,
  },
  {
    // Node, ES modules: scripts and test tools
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2025, sourceType: 'module', globals: { ...globals.node } },
    rules: shared,
  },
  {
    // the browser tests: some of their functions run in the page
    files: ['test/web/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Beam's web app: plain scripts sharing one scope (core.js, model.js, …): one file defines what the others use, so
    // "undefined" and "unused" can't be told file by file
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
    rules: { 'no-undef': 'off', 'no-unused-vars': 'off', 'no-redeclare': 'off', 'no-control-regex': 'off' },
  },
  {
    // Beam Family's web app: ES modules
    files: ['family/public/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    // (1.23) the Linux computers' viewer: an ES module (it imports noVNC, public/novnc, which lint leaves alone) that uses
    // the web app's shared scope like the plain scripts do
    files: ['public/vnc.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
    rules: { 'no-undef': 'off', 'no-unused-vars': 'off' },
  },
  {
    // the service workers
    files: ['public/sw.js', 'family/public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    // the Windows app's capture page (embedded in Beam.exe): a browser script
    files: ['windows/rc/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, chrome: 'readonly' } },
  },
];
