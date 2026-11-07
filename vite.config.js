import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { viteCommonjs } from '@originjs/vite-plugin-commonjs';
import path from 'path';

const projectRoot = import.meta.dirname;

export default defineConfig({
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
                find: /^brsh\/wbt$/,
                replacement: path.resolve(projectRoot, 'lib/wbt/index.js')
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
    server: {
        fs: {
            allow: [projectRoot]
        }
    }
});