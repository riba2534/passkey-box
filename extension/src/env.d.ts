/** Injected by scripts/build.mjs from PKB_DEFAULT_SERVER_URL (empty by default). */
declare const __PKB_DEFAULT_SERVER_URL__: string;

/** PNG imports are inlined as data URLs by esbuild (loader "dataurl"). */
declare module "*.png" {
  const url: string;
  export default url;
}
