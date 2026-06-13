#!/usr/bin/env node
/**
 * _html-bundle.cjs — Bundle qry/web apps into single self-contained HTML files
 *
 * Inlines local CSS and JS, bundles ES modules with esbuild, keeps CDN
 * resources external. The resulting HTML opens in any browser (double-click,
 * upload anywhere, send by email) — no server needed.
 *
 * Usage:
 *   node _html-bundle.cjs          → bundle every app declared in APPS
 *   npm run bundle                → same, via package.json script
 *
 * Requires: npm install -D esbuild
 *
 * @author Jean-Luc Bloechle with Claude.ai
 */

const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const APPS = [
    { input: 'web/mocap/index.html', output: 'dist/kinesa.html' },
    // { input: 'web/apps/zigzag/index.html', output: 'dist/zigzag.html' },
];

const MINIFY = true;

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const isLocal = href =>
    href && !href.startsWith('http') && !href.startsWith('//') && !href.startsWith('data:');

const readLocal = (basedir, href) => {
    const abs = path.resolve(basedir, href);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
};

const relPath = p => path.relative(process.cwd(), p);

/** Extract the bare specifiers declared in an importmap (e.g. "three", "d3"). */
const parseImportMap = html => {
    const m = html.match(/<script\s+type="importmap"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return [];
    try { return Object.keys(JSON.parse(m[1]).imports || {}); }
    catch { return []; }
};

// ═══════════════════════════════════════════════════════════════════════════
// MODULE BUNDLER (esbuild API — no temp files, no subprocess)
// ═══════════════════════════════════════════════════════════════════════════

let esbuild;
const loadEsbuild = () => {
    if (esbuild) return esbuild;
    try { esbuild = require('esbuild'); return esbuild; }
    catch {
        console.error('\n  ✗ esbuild not installed. Run: npm install -D esbuild\n');
        process.exit(1);
    }
};

/**
 * Bundle an inline ES module that imports local files.
 * Uses a virtual stdin entry — imports resolve relative to `basedir`.
 * `externals` are kept as bare specifiers (resolved at runtime via importmap).
 */
const bundleModule = (code, basedir, externals) => {
    const result = loadEsbuild().buildSync({
        stdin: { contents: code, resolveDir: basedir, loader: 'js' },
        bundle: true,
        format: 'esm',
        platform: 'browser',
        external: externals,
        minify: MINIFY,
        write: false,
    });
    return result.outputFiles[0].text;
};

// ═══════════════════════════════════════════════════════════════════════════
// HTML TRANSFORMS
// ═══════════════════════════════════════════════════════════════════════════

/** Inline `<link rel="stylesheet" href="local.css">` → `<style>...</style>`. */
const inlineStyles = (html, basedir, stats) =>
    html.replace(
        /<link\s+[^>]*?href="([^"]+)"[^>]*?rel="stylesheet"[^>]*>|<link\s+[^>]*?rel="stylesheet"[^>]*?href="([^"]+)"[^>]*>/gi,
        (tag, h1, h2) => {
            const href = h1 || h2;
            if (!isLocal(href)) { stats.kept++; return tag; }
            const css = readLocal(basedir, href);
            if (!css) { console.log(`    ⚠ not found: ${href}`); return tag; }
            stats.css++;
            return `<style>/* ${path.basename(href)} */\n${css}\n</style>`;
        }
    );

/** Inline `<script src="local.js"></script>` → `<script>...</script>`. */
const inlineScripts = (html, basedir, stats) =>
    html.replace(
        /<script\s+([^>]*?)src="([^"]+)"([^>]*)><\/script>/gi,
        (tag, pre, src, post) => {
            if (!isLocal(src)) { stats.kept++; return tag; }
            const js = readLocal(basedir, src);
            if (!js) { console.log(`    ⚠ not found: ${src}`); return tag; }
            stats.js++;
            const allAttrs = pre + post;
            const isModule = allAttrs.includes('module');
            const otherAttrs = allAttrs.replace(/type="module"/gi, '').trim();
            const typeAttr = isModule ? ' type="module"' : '';
            const extra = otherAttrs ? ' ' + otherAttrs : '';
            return `<script${typeAttr}${extra}>/* ${path.basename(src)} */\n${js}\n</script>`;
        }
    );

/** Bundle inline `<script type="module">…</script>` blocks that import local files. */
const bundleInlineModules = (html, basedir, externals, stats) =>
    html.replace(
        /<script\s+type="module">([\s\S]*?)<\/script>/gi,
        (tag, code) => {
            // Only bundle if the module has at least one local import
            if (!/import\s+.*from\s+['"]\./.test(code)) return tag;
            try {
                const bundled = bundleModule(code, basedir, externals);
                stats.modules++;
                return `<script type="module">\n${bundled}\n</script>`;
            } catch (err) {
                console.log(`    ✗ bundle failed: ${err.message}`);
                return tag;
            }
        }
    );

// ═══════════════════════════════════════════════════════════════════════════
// MAIN BUILD STEP
// ═══════════════════════════════════════════════════════════════════════════

const buildApp = (inputPath, outputPath) => {
    const basedir = path.dirname(inputPath);
    const stats = { css: 0, js: 0, modules: 0, kept: 0 };

    console.log(`\n  ${relPath(inputPath)}`);
    let html = fs.readFileSync(inputPath, 'utf8');

    const externals = parseImportMap(html);

    html = inlineStyles(html, basedir, stats);
    html = inlineScripts(html, basedir, stats);
    html = bundleInlineModules(html, basedir, externals, stats);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, html, 'utf8');

    const kb = (fs.statSync(outputPath).size / 1024).toFixed(1);
    console.log(
        `    → ${relPath(outputPath)} (${kb} KB) — ` +
        `${stats.css} css, ${stats.js} js, ${stats.modules} modules inlined, ${stats.kept} external`
    );
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

console.log('📦 _html-bundle');

let built = 0, skipped = 0;
for (const app of APPS) {
    const input = path.resolve(app.input);
    const output = path.resolve(app.output);
    if (!fs.existsSync(input)) {
        console.log(`\n  ⚠ skipped: ${app.input} (not found)`);
        skipped++;
        continue;
    }
    try {
        buildApp(input, output);
        built++;
    } catch (err) {
        console.error(`\n  ✗ error bundling ${app.input}: ${err.message}`);
    }
}

console.log(`\n✅ done — ${built} built${skipped ? `, ${skipped} skipped` : ''}\n`);
