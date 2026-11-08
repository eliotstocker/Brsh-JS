import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            'brsh': path.resolve(import.meta.dirname, 'index.js')
        }
    },
    test: {
        environment: 'node',
        globals: false,
        include: ['test/**/*.test.js'],
        testTimeout: 10000,
        coverage: {
            provider: 'v8',
            include: ['index.js', 'lib/**/*.js', 'bin/exportFileSystem.js'],
            exclude: ['lib/Terminal.js', 'lib/terminal.css']
        }
    }
});
