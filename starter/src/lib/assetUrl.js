/**
 * Resolve a path in `resources/` (Vite's publicDir) or a sibling HTML entry
 * point against the app's base path.
 *
 * A bare '/braille.png' is absolute against the ORIGIN, so on a GitHub Pages
 * project site it resolves to https://user.github.io/braille.png and 404s —
 * the site actually lives under /<repo>/. This is invisible in development,
 * where base is '/', so it only ever breaks after deploying.
 *
 * `import.meta.env.BASE_URL` is whatever `base` is set to in vite.config.js
 * (the workflow feeds it from actions/configure-pages), and always ends in '/'.
 */
export function asset(path) {
  return `${import.meta.env.BASE_URL}${String(path).replace(/^\/+/, '')}`;
}

export default asset;
