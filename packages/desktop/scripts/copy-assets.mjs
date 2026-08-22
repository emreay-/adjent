import { cpSync, mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer', 'dist/renderer', { recursive: true });
copyFileSync('src/preload.cjs', 'dist/preload.cjs');
console.log('renderer assets + preload copied');
