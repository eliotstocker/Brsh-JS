import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    build: {
        lib: {
            entry: path.resolve(import.meta.dirname, 'lib/Terminal.js'),
            name: 'Terminal',
            formats: ['es', 'iife'],
            fileName: (format) => format === 'iife' ? 'terminal.min.js' : 'terminal.es.js'
        },
        rollupOptions: {
            external: ['brsh', 'Shell'],
            output: {
                globals: {
                    brsh: 'globalThis.Shell',
                    Shell: 'globalThis.Shell'
                }
            }
        },
        minify: true,
        sourcemap: true,
        outDir: 'dist',
        emptyOutDir: false
    }
});
