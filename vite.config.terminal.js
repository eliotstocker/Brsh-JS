import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';

export default defineConfig({
    plugins: [
        nodePolyfills()
    ],
    resolve: {
        // Terminal.js does require('Shell') — point that at the real entry
        alias: {
            Shell: path.resolve(import.meta.dirname, 'index.js')
        }
    },
    build: {
        lib: {
            entry: path.resolve(import.meta.dirname, 'lib/Terminal.js'),
            name: 'Terminal',
            formats: ['es', 'iife'],
            fileName: (format) => format === 'iife' ? 'terminal.min.js' : 'terminal.es.js'
        },
        minify: true,
        sourcemap: true,
        outDir: 'dist',
        emptyOutDir: false
    }
});
