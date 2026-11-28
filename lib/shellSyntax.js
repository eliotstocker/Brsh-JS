'use strict';

//returns the index after the group opened by the $( or ${ at start, or -1 if never closed.
//quotes and nested groups are respected so a ) or } inside them doesnt end it early
function skipGroup(str, start) {
    const stack = [];
    for(let i = start; i < str.length; i++) {
        const ch = str[i];
        const top = stack[stack.length -1];
        if(top === "'") {
            ch === "'" && stack.pop();
        } else if(ch === '\\') {
            i++;
        } else if(ch === '"') {
            top === '"' ? stack.pop() : stack.push('"');
        } else if(ch === "'" && top !== '"') {
            stack.push("'");
        } else if(ch === '$' && (str[i + 1] === '{' || str[i + 1] === '(')) {
            stack.push(str[i + 1] === '{' ? '}' : ')');
            i++;
        } else if(ch === '(' && top !== '"') {
            stack.push(')');
        } else if(ch === top) {
            stack.pop();
            if(stack.length < 1) {
                return i + 1;
            }
        }
    }
    return -1;
}

//split on top level ; only, not inside quotes, $(...) or ${...}. By default the ;; of a
//case is left in place, pass ';;' as the separator to split case clauses instead
function splitStatements(line, separator = ';') {
    const statements = [];
    let current = '';
    let sq = false;
    let dq = false;

    for(let i = 0; i < line.length; i++) {
        const ch = line[i];
        if(!sq && ch === '$' && (line[i + 1] === '(' || line[i + 1] === '{')) {
            const end = skipGroup(line, i);
            if(end > -1) {
                current += line.slice(i, end);
                i = end -1;
                continue;
            }
        }
        if(ch === '\\' && !sq && i + 1 < line.length) {
            current += ch + line[++i];
            continue;
        }
        if(ch === "'" && !dq) {
            sq = !sq;
        } else if(ch === '"' && !sq) {
            dq = !dq;
        } else if(ch === '#' && !sq && !dq && (i === 0 || /\s/.test(line[i - 1]))) {
            break;
        } else if(ch === ';' && !sq && !dq) {
            const double = line[i + 1] === ';';
            if(double !== (separator === ';;')) {
                current += double ? ';;' : ';';
                i += double ? 1 : 0;
                continue;
            }
            current.trim() && statements.push(current.trim());
            current = '';
            i += double ? 1 : 0;
            continue;
        }
        current += ch;
    }
    current.trim() && statements.push(current.trim());
    return statements;
}

const funcDef = /^(?:function\s+\w+|\w+\s*\(\s*\))/;

//then/else/do can be followed straight away by another statement
const stripLead = st => st.replace(/^(?:then|else|do)(?=\s|$)\s*/, '');

const opensBlock = st => /^(?:if|for|while)(?=\s)/.test(st)
    || (/^case(?=\s)/.test(st) && !/\besac$/.test(st))
    || funcDef.test(st);

//true if the text starts an if/for/while/case/function anywhere at statement level
function hasBlock(text) {
    return text.split('\n').some(line => splitStatements(line)
        .some(st => {
            const body = stripLead(st);
            return /^(?:if|for|while|case)(?=\s)/.test(body) || funcDef.test(body);
        }));
}

//true if a block was opened and not closed yet, ie the prompt should ask for more lines
function isIncomplete(text) {
    let depth = 0;
    text.split('\n').forEach(line => splitStatements(line).forEach(st => {
        const body = stripLead(st);
        if(opensBlock(body)) {
            depth++;
        } else if(/^(?:fi|done|esac|\})(?=\s|$)/.test(body)) {
            depth = Math.max(0, depth - 1);
        }
    }));
    return depth > 0;
}

module.exports = {skipGroup, splitStatements, hasBlock, isIncomplete};
