import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { viteCommonjs } from '@originjs/vite-plugin-commonjs';
import path from 'path';

const projectRoot = import.meta.dirname;

export default defineConfig({
    root: path.resolve(projectRoot, 'demo'),
    plugins: [
        nodePolyfills(),
        viteCommonjs()
    ],
    resolve: {
        alias: [
            {
                find: /^brsh\/terminal$/,
                replacement: path.resolve(projectRoot, 'lib/Terminal.js')
            },
            {
                find: /^brsh$/,
                replacement: path.resolve(projectRoot, 'index.js')
            },
            {
                find: /^Shell$/,
                replacement: path.resolve(projectRoot, 'index.js')
            }
        ]
    },
    base: './',
    build: {
        outDir: path.resolve(projectRoot, 'dist-demo'),
        emptyOutDir: true,
    }
});
