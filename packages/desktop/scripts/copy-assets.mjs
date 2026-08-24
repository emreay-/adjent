import { cpSync, mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer', 'dist/renderer', { recursive: true });
copyFileSync('src/preload.cjs', 'dist/preload.cjs');
// The renderer shows the brand mark; copy it rather than keeping a second copy in src.
copyFileSync('../../brand/assets/logo/adjent-logo.svg', 'dist/renderer/adjent-logo.svg');
console.log('renderer assets + preload copied');
