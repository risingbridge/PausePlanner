// Vite's own `vite/client` types declare `*.wasm?url` as a URL-string
// import, but that pattern matches on the literal import specifier — and
// `highs`'s package.json only exposes the wasm file via the "./runtime"
// export subpath (not a path ending in .wasm), so it needs its own
// declaration here rather than falling under Vite's generic one.
declare module "highs/runtime?url" {
  const url: string;
  export default url;
}
