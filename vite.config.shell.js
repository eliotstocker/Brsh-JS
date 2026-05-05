import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';

export default defineConfig({
    plugins: [
        nodePolyfills()
    ],
    build: {
        lib: {
            entry: path.resolve(import.meta.dirname, 'index.js'),
            name: 'Shell',
            formats: ['es', 'iife'],
            fileName: (format) => format === 'iife' ? 'shell.min.js' : 'shell.es.js'
        },
        minify: true,
        sourcemap: true,
        outDir: 'dist',
        emptyOutDir: false
    }
});
