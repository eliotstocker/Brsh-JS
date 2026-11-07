import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';

export default defineConfig({
    plugins: [
        nodePolyfills()
    ],
    build: {
        lib: {
            entry: path.resolve(import.meta.dirname, 'lib/wbt/index.js'),
            name: 'Wbt',
            formats: ['es', 'iife'],
            fileName: (format) => format === 'iife' ? 'wbt.min.js' : 'wbt.es.js'
        },
        minify: true,
        sourcemap: true,
        outDir: 'dist',
        emptyOutDir: false
    }
});
