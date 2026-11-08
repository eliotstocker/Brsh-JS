import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    build: {
        lib: {
            entry: path.resolve(import.meta.dirname, 'lib/Terminal.js'),
            name: 'Terminal',
            formats: ['es', 'cjs', 'iife'],
            fileName: (format) => {
                if (format === 'iife') return 'terminal.min.js';
                if (format === 'cjs') return 'terminal.cjs.js';
                return 'terminal.es.js';
            }
        },
        rollupOptions: {
            external: ['brsh', 'Shell'],
            output: {
                exports: 'auto',
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
