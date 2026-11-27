import tseslint from "typescript-eslint"
export default tseslint.config(
  { ignores: ["node_modules", "dist", "coverage", "src/public/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Deliberate in this codebase: unused function args document intent
      // (e.g. Express handler signatures) more than they cost anything —
      // only flag genuinely unused local variables/imports.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
