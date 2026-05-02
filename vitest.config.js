import { defineConfig } from 'vitest/config';

export default defineConfig({
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
