import { createRequire } from 'module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const {skipGroup, splitStatements, hasBlock, isIncomplete} = require('../lib/shellSyntax.js');

describe('skipGroup', () => {
    it('finds the end of a $( ) group', () => {
        expect(skipGroup('$(echo hi) rest', 0)).toBe(10);
    });

    it('finds the end of a ${ } group', () => {
        expect(skipGroup('${A:-b} rest', 0)).toBe(7);
    });

    it('respects nesting and quotes', () => {
        const text = '$(echo "a)" $(echo b))';
        expect(skipGroup(text, 0)).toBe(text.length);
        expect(skipGroup('${A:-"}"} x', 0)).toBe(9);
    });

    it('returns -1 when the group never closes', () => {
        expect(skipGroup('$(echo hi', 0)).toBe(-1);
        expect(skipGroup('${A', 0)).toBe(-1);
    });
});

describe('splitStatements', () => {
    it('splits on ;', () => {
        expect(splitStatements('a; b ;c')).toEqual(['a', 'b', 'c']);
    });

    it('ignores ; inside quotes, $( ) and ${ }', () => {
        expect(splitStatements('echo "a;b"; echo \'c;d\'; echo $(x; y); echo ${A:-p;q}'))
            .toEqual(['echo "a;b"', "echo 'c;d'", 'echo $(x; y)', 'echo ${A:-p;q}']);
    });

    it('ignores an escaped ;', () => {
        expect(splitStatements('echo a\\;b; c')).toEqual(['echo a\\;b', 'c']);
    });

    it('keeps ;; together by default', () => {
        expect(splitStatements('a) x;; b) y')).toEqual(['a) x;; b) y']);
    });

    it('splits case clauses on ;; when asked', () => {
        expect(splitStatements('a) x; y;; b) z', ';;')).toEqual(['a) x; y', 'b) z']);
    });

    it('stops at a comment', () => {
        expect(splitStatements('a; b # c; d')).toEqual(['a', 'b']);
    });

    it('drops empty statements', () => {
        expect(splitStatements(';; a;;')).toEqual([';; a;;']);
        expect(splitStatements('a;;b;')).toEqual(['a;;b']);
        expect(splitStatements('')).toEqual([]);
    });
});

describe('hasBlock', () => {
    it('is true for statements that start a block', () => {
        ['if true; then echo a; fi', 'for i in 1 2; do echo $i; done', 'while false; do :; done',
            'case x in x) echo a;; esac', 'f() { echo a; }', 'function f { echo a; }', 'echo a; if true; then b; fi']
            .forEach(text => expect(hasBlock(text), text).toBe(true));
    });

    it('is true when a block starts on a later line', () => {
        expect(hasBlock('echo a\nif true')).toBe(true);
    });

    it('is false for ordinary commands', () => {
        ['echo hi', 'echo "if x; then y; fi"', 'ls -l; pwd', 'echo if', 'x=1', "echo 'for i in a'", 'iffy thing', 'formatter run']
            .forEach(text => expect(hasBlock(text), text).toBe(false));
    });
});

describe('isIncomplete', () => {
    it('is true while a block is still open', () => {
        ['if true', 'if true; then', 'if true; then echo a', 'for i in 1 2', 'for i in 1 2; do', 'while true; do echo a',
            'case x in', 'f() {', 'function f {']
            .forEach(text => expect(isIncomplete(text), text).toBe(true));
    });

    it('is false once the block is closed', () => {
        ['if true; then echo a; fi', 'for i in 1; do echo; done', 'case x in x) echo;; esac', 'f() { echo; }', 'echo hi']
            .forEach(text => expect(isIncomplete(text), text).toBe(false));
    });

    it('works across lines', () => {
        expect(isIncomplete('if true\nthen\necho a')).toBe(true);
        expect(isIncomplete('if true\nthen\necho a\nfi')).toBe(false);
        expect(isIncomplete('case x in\nx) echo a;;')).toBe(true);
        expect(isIncomplete('case x in\nx) echo a;;\nesac')).toBe(false);
    });

    it('counts nested blocks', () => {
        expect(isIncomplete('for i in 1; do\nif true; then\necho a\nfi')).toBe(true);
        expect(isIncomplete('for i in 1; do\nif true; then\necho a\nfi\ndone')).toBe(false);
        expect(isIncomplete('if a; then if b; then c; fi')).toBe(true);
        expect(isIncomplete('if a; then if b; then c; fi; fi')).toBe(false);
    });

    it('a stray closer does not go negative', () => {
        expect(isIncomplete('fi')).toBe(false);
        expect(isIncomplete('fi\nif true')).toBe(true);
    });

    it('keywords inside quotes or other words do not count', () => {
        expect(isIncomplete('echo "if true"')).toBe(false);
        expect(isIncomplete('echo fi done')).toBe(false);
    });
});
