// surface-nets pulls in typedarray-pool, which reads Browserify's `global` when it loads.
// The production build replaces `global` through Vite's define; the dev server does not
// rewrite pre-bundled dependencies, so this runs first and supplies it. Node already has it.
(globalThis as { global?: typeof globalThis }).global ??= globalThis;
