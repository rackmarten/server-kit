import config from "@rackmarten/eslint-config";

export default [
  ...config,
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  {
    // node:test's top-level test()/describe() return promises that the
    // runner itself awaits and reports, so they are not floating.
    files: ["test/**"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
];
