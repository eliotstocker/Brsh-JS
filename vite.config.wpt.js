import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';

export default defineConfig({
    plugins: [
        nodePolyfills()
    ],
    build: {
        lib: {
            entry: path.resolve(import.meta.dirname, 'lib/wpt/index.js'),
            name: 'Wpt',
            formats: ['es', 'iife'],
            fileName: (format) => format === 'iife' ? 'wpt.min.js' : 'wpt.es.js'
        },
        minify: true,
        sourcemap: true,
        outDir: 'dist',
        emptyOutDir: false
    }
});
