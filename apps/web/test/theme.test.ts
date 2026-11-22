// GEN-087 theme v2: tokens.css is the single source of colours and fonts (C1), the pairs in use pass contrast (C2)
// and every focusable element gets a visible focus ring (C5).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrast, textPairs, uiPairs } from './contrast.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (path: string) => readFileSync(join(src, path), 'utf8');
const tokensCss = read('tokens.css');
const themeCss = () => read('theme.css');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** `--name: #hex` pairs inside :root of tokens.css. */
function colourTokens(): Record<string, string> {
  const root = /:root\s*\{([\s\S]*?)\}/.exec(tokensCss)?.[1] ?? '';
  return Object.fromEntries([...root.matchAll(/(--[\w-]+)\s*:\s*(#[0-9A-Fa-f]{6})\b/g)].map((m) => [m[1], m[2]]));
}

/** Every `prop: value` declaration of a stylesheet with the selector it sits in (comments removed). */
function declarations(css: string): { selector: string; prop: string; value: string }[] {
  const out: { selector: string; prop: string; value: string }[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1]!.trim();
    for (const decl of rule[2]!.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      out.push({ selector, prop: decl.slice(0, i).trim().toLowerCase(), value: decl.slice(i + 1).trim() });
    }
  }
  return out;
}

const HARD_COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;
// CSS named colours that could slip in; keywords that carry no colour (transparent, currentColor, inherit) are fine.
const NAMED_COLOUR = /\b(?:white|black|red|green|blue|gray|grey|yellow|orange|purple|pink|navy|teal|gold|silver)\b/i;
const COLOUR_PROPS = /^(?:color|background|background-color|border|border-(?:top|right|bottom|left)(?:-color)?|border-color|outline|outline-color|fill|stroke|box-shadow|text-decoration-color|caret-color|accent-color|column-rule|-webkit-text-fill-color)$/;

describe('C1 colours and fonts come from tokens.css', () => {
  it('main.tsx imports tokens.css once, before theme.css', () => {
    const main = read('main.tsx');
    const tokensAt = main.indexOf("import './tokens.css';");
    const themeAt = main.indexOf("import './theme.css';");
    expect(tokensAt).toBeGreaterThanOrEqual(0);
    expect(themeAt).toBeGreaterThan(tokensAt);
    const imports = filesUnder(src).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/(?:import\s+|@import\s+(?:url\()?)['"][^'"]*tokens\.css['"]/g)].map(() => relative(src, f)));
    expect(imports.filter((f) => f !== 'tokens.css')).toEqual(['main.tsx']);
  });

  it('no file under src/ other than tokens.css holds a colour value', () => {
    const offenders = filesUnder(src)
      .filter((f) => ['.ts', '.tsx', '.css', '.svg'].includes(extname(f)) && relative(src, f) !== 'tokens.css')
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((line, i) => ({ line, at: `${relative(src, f)}:${i + 1}` }))
          .filter(({ line }) => HARD_COLOUR.test(line))
          .map(({ at, line }) => `${at} ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });

  it('every colour declaration in theme.css uses a token (var(--…)) or a colourless keyword', () => {
    const tokens = colourTokens();
    const bad = declarations(themeCss())
      .filter((d) => COLOUR_PROPS.test(d.prop))
      .filter((d) => NAMED_COLOUR.test(d.value) || !/var\(--|\bcurrentColor\b|^(?:none|0|transparent|inherit)$/i.test(d.value))
      .map((d) => `${d.selector} { ${d.prop}: ${d.value} }`);
    expect(bad).toEqual([]);
    // and every var() it reads exists in tokens.css (a typo would fall back to the browser default colour)
    const defined = new Set([...tokensCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const localVars = new Set([...themeCss().matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const missing = [...themeCss().matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!).filter((v) => !defined.has(v) && !localVars.has(v));
    expect(missing).toEqual([]);
    expect(Object.keys(tokens).length).toBeGreaterThanOrEqual(16);
  });

  it('body uses --font-body, headings use --font-display, and no other font family is named', () => {
    const decls = declarations(themeCss());
    const families = decls.filter((d) => d.prop === 'font-family');
    expect(families.length).toBeGreaterThan(0);
    expect(families.filter((d) => !/^var\(--font-(?:body|display)\)$/.test(d.value))).toEqual([]);
    expect(families.find((d) => /\bbody\b/.test(d.selector))?.value).toBe('var(--font-body)');
    expect(families.find((d) => /\bh1\b/.test(d.selector))?.value).toBe('var(--font-display)');
    expect(decls.filter((d) => d.prop === 'font' && !/var\(--font-|^inherit$/.test(d.value))).toEqual([]);
  });

  it('fonts are self-hosted woff2 only (no ttf is referenced) and the files exist', () => {
    const urls = [...tokensCss.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThanOrEqual(5);
    for (const url of urls) {
      expect(url).toMatch(/\.woff2$/);
      expect(existsSync(join(src, url))).toBe(true);
    }
    const ttf = filesUnder(src)
      .filter((f) => ['.ts', '.tsx', '.css'].includes(extname(f)))
      .filter((f) => /\.ttf\b/.test(readFileSync(f, 'utf8')));
    expect(ttf).toEqual([]);
  });
});

describe('C2 contrast of the token pairs in use', () => {
  it('the formula matches known WCAG values', () => {
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 2);
    expect(contrast('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
    expect(contrast('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });

  it('every text pair is >= 4.5:1 and every UI pair >= 3:1 with the values in tokens.css', () => {
    const tokens = colourTokens();
    const failures: string[] = [];
    for (const [list, min] of [[textPairs, 4.5], [uiPairs, 3]] as const) {
      for (const [fg, bg, where] of list) {
        const a = tokens[fg];
        const b = tokens[bg];
        if (!a || !b) {
          failures.push(`${fg} / ${bg}: token missing (${where})`);
          continue;
        }
        const ratio = contrast(a, b);
        if (ratio < min) failures.push(`${fg} on ${bg} = ${ratio.toFixed(2)} < ${min} (${where})`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('every text/background combination written in theme.css is a checked pair', () => {
    // A rule that sets both `color` and `background(-color)` to tokens must be in textPairs.
    const checked = new Set(textPairs.map(([fg, bg]) => `${fg}|${bg}`));
    const rules = new Map<string, { color?: string; bg?: string }>();
    for (const d of declarations(themeCss())) {
      const v = /^var\((--[\w-]+)\)$/.exec(d.value)?.[1];
      if (!v) continue;
      const r = rules.get(d.selector) ?? {};
      if (d.prop === 'color') r.color = v;
      if (d.prop === 'background' || d.prop === 'background-color') r.bg = v;
      rules.set(d.selector, r);
    }
    const unchecked = [...rules]
      .filter(([, r]) => r.color && r.bg && !checked.has(`${r.color}|${r.bg}`))
      .map(([sel, r]) => `${sel}: ${r.color} on ${r.bg}`);
    expect(unchecked).toEqual([]);
  });
});

describe('C5 visible focus ring', () => {
  it('theme.css draws a 2px+ --accent outline on :focus-visible for every focusable element', () => {
    const ring = declarations(themeCss()).filter((d) => d.selector.includes(':focus-visible') && d.prop === 'outline');
    expect(ring.length).toBeGreaterThan(0);
    const [outline] = ring;
    expect(outline!.value).toContain('var(--accent)');
    expect(Number(/(\d+)px/.exec(outline!.value)?.[1] ?? 0)).toBeGreaterThanOrEqual(2);
    // the rule is global (`:focus-visible` alone), so buttons, links, inputs, summary and [tabindex] are all covered
    expect(ring.some((d) => d.selector.split(',').map((s) => s.trim()).includes(':focus-visible'))).toBe(true);
  });

  it('nothing in theme.css removes the outline', () => {
    const removed = declarations(themeCss()).filter((d) => /^outline(?:-style|-width)?$/.test(d.prop) && /^(?:none|0)$/.test(d.value));
    expect(removed).toEqual([]);
  });
});

describe('C6 tap targets at phone width', () => {
  it('buttons and .btn are at least 44 x 44 below 768px; the end-page rating radios too', () => {
    const decl = (css: string, sel: string, prop: string) => declarations(css).filter((d) => d.selector.split(',').map((s) => s.trim()).includes(sel) && d.prop === prop).map((d) => d.value);
    for (const sel of ['button', '.btn']) {
      expect(decl(themeCss(), sel, 'min-height')).toContain('44px');
      expect(decl(themeCss(), sel, 'min-width')).toContain('44px');
    }
    expect(themeCss()).toMatch(/@media \(max-width: 767px\)\s*\{\s*button,/);
    for (const prop of ['min-height', 'min-width']) expect(decl(read('ending.css'), '.rating__score', prop)).toContain('44px');
  });
});
