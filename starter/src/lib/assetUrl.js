/**
 * Resolve a path in `resources/` (Vite's publicDir) or a sibling HTML entry
 * point against the app's base path.
 *
 * A bare '/braille.png' is absolute against the ORIGIN, so on a GitHub Pages
 * project site it resolves to https://user.github.io/braille.png and 404s —
 * the site actually lives under /<repo>/. This is invisible in development,
 * where base is '/', so it only ever breaks after deploying.
 *
 * `import.meta.env.BASE_URL` is whatever `base` is set to in vite.config.js.
 * Do NOT assume it ends in '/': the workflow feeds it from
 * actions/configure-pages, whose `base_path` output is '/AccessMapBeyondTheCurb'
 * with no trailing slash, which naively concatenated gives
 * '/AccessMapBeyondTheCurbbraille.png'. Strip and re-add the separator so the
 * result is correct for '/', '/repo' and '/repo/' alike.
 */
export function asset(path) {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

export default asset;
