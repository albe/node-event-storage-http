#!/usr/bin/env node
/**
 * Dependency-boundary checker for the layered package.
 *
 * Enforces two rules and fails (exit 1) on any violation:
 *
 *   1. No module physically under `src/protocol/` or `src/client/` may import
 *      `express` (or any `express/...` subpath), nor import anything located
 *      under `src/server/`.
 *
 *   2. Starting from the `./protocol` and `./client` public entry points, the
 *      transitive static-import graph must never reach `express` or any file
 *      under `src/server/`. This is the "client-only import loads zero server
 *      code / zero express" guarantee, checked statically (a bundler-style
 *      reachability analysis) so it needs neither express installed nor a
 *      running server.
 *
 * Static parsing is intentionally simple (regex over `from '...'`,
 * `import '...'`, and `import('...')`). That is sufficient for this codebase,
 * which uses only string-literal specifiers.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const srcDir = resolve(pkgRoot, 'src');
const serverDir = resolve(srcDir, 'server');

const FORBIDDEN_BARE = specifier => specifier === 'express' || specifier.startsWith('express/');

/** @returns {string[]} All `.js` files under `dir`, recursively. */
function listJsFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...listJsFiles(full));
        } else if (entry.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}

/** @returns {string[]} Import/export specifiers referenced by a source file. */
function parseSpecifiers(file) {
    const code = readFileSync(file, 'utf8');
    const specifiers = new Set();
    const patterns = [
        /\bfrom\s*['"]([^'"]+)['"]/g,            // import/export ... from '...'
        /\bimport\s*['"]([^'"]+)['"]/g,          // bare side-effect import '...'
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g // dynamic import('...')
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(code)) !== null) {
            specifiers.add(match[1]);
        }
    }
    return [...specifiers];
}

function isRelative(specifier) {
    return specifier.startsWith('./') || specifier.startsWith('../');
}

function underServer(file) {
    const rel = relative(serverDir, file);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^\.\.[\\/]/.test(rel));
}

const violations = [];

function record(file, message) {
    violations.push(`  ${relative(pkgRoot, file).split(sep).join('/')}: ${message}`);
}

// --- Rule 1: direct scan of protocol/ and client/ source files -------------
for (const layer of ['protocol', 'client']) {
    const dir = resolve(srcDir, layer);
    for (const file of listJsFiles(dir)) {
        for (const specifier of parseSpecifiers(file)) {
            if (FORBIDDEN_BARE(specifier)) {
                record(file, `imports forbidden package "${specifier}" (express must not be reachable from ${layer}/).`);
                continue;
            }
            if (isRelative(specifier)) {
                const target = resolve(dirname(file), specifier);
                if (underServer(target)) {
                    record(file, `imports server-layer module "${specifier}" (src/server/ is off-limits to ${layer}/).`);
                }
            }
        }
    }
}

// --- Rule 2: transitive reachability from the public entry points ----------
function walk(entry, label) {
    const seen = new Set();
    const stack = [entry];
    while (stack.length > 0) {
        const file = stack.pop();
        if (seen.has(file)) {
            continue;
        }
        seen.add(file);
        if (underServer(file)) {
            violations.push(`  [${label}] reaches server-layer module ${relative(pkgRoot, file).split(sep).join('/')}`);
            continue;
        }
        for (const specifier of parseSpecifiers(file)) {
            if (FORBIDDEN_BARE(specifier)) {
                violations.push(`  [${label}] transitively imports "${specifier}" via ${relative(pkgRoot, file).split(sep).join('/')}`);
                continue;
            }
            if (isRelative(specifier)) {
                stack.push(resolve(dirname(file), specifier));
            }
        }
    }
}

walk(resolve(srcDir, 'protocol/index.js'), 'protocol');
walk(resolve(srcDir, 'client/index.js'), 'client');

if (violations.length > 0) {
    console.error('Dependency-boundary check FAILED:\n' + violations.join('\n'));
    process.exit(1);
}

console.log('Dependency-boundary check passed: protocol/ and client/ load zero express and zero server code.');
