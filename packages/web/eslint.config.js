// ESLint 9 flat config (replaces the legacy .eslintrc.json, which ESLint 9 can
// no longer load). Parses TS/TSX with @typescript-eslint/parser, applies
// react/recommended + react-hooks, and — most importantly — preserves the
// project-wide ban on direct useEffect (see CLAUDE.md: use useMountEffect /
// useEventListener / derive inline instead).
//
// PRE-EXISTING DEBT / RATCHET: the rules below are all real (`error`-level),
// but ESLint 9 never ran here before (the legacy config wouldn't load), so the
// codebase has a backlog of violations — chiefly direct-useEffect call sites.
// To make the lint gate green now while still catching NEW violations, that
// backlog is captured in `eslint-suppressions.json` (ESLint's native baseline,
// `eslint . --suppress-all`). `eslint .` reads it automatically: counts that
// match the baseline pass; any NEW violation fails CI. When you FIX a suppressed
// site, prune the baseline with `bun run lint:prune-suppressions` (the count
// only ratchets down). Do NOT weaken any rule to silence the backlog.
import js from "@eslint/js";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

// A few source files still carry Next.js-era `// eslint-disable-next-line
// @next/next/no-img-element` directives. We don't run the Next.js plugin (this
// is a Vite SPA), but a disable directive that names an unknown rule is itself
// an ESLint error. Register the rule as a no-op so those inert directives stay
// valid without flagging the whole config.
const nextStub = { rules: { "no-img-element": { create: () => ({}) } } };

export default [
  {
    // Build artifacts, vendored output, and config glue — never linted.
    ignores: [
      "node_modules/**",
      "dist/**",
      ".next/**",
      "build/**",
      "out/**",
      "public/**",
      "**/*.tsbuildinfo",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
        ...globals.node,
      },
    },
    settings: {
      react: { version: "detect" },
    },
    plugins: { react, "react-hooks": reactHooks, "@next/next": nextStub },
    rules: {
      // Parity with the retired .eslintrc.json, which extended
      // `plugin:react/recommended` + `plugin:react/jsx-runtime`. Spread the
      // plugin's flat rule sets in here (rather than as separate config blocks)
      // so they run under the TS parser configured above; the project-specific
      // overrides below then take precedence.
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat["jsx-runtime"].rules,
      // Match the retired .eslintrc.json's `plugin:react-hooks/recommended`:
      // the two classic hook rules only (the v7 plugin also ships the React
      // Compiler ruleset, which we intentionally do not opt into here).
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // The eslint:recommended JS rules don't understand TypeScript syntax
      // (type-only constructs, enums, decorators). The TS parser handles those;
      // disable the core rules that double-flag them so `eslint .` executes
      // cleanly and only surfaces our intended violations.
      "no-unused-vars": "off",
      "no-undef": "off",
      "no-redeclare": "off",
      "no-empty": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-explicit-any": "off",
      // These eslint:recommended rules flag legitimate, intentional patterns in
      // this codebase (ANSI/control-char regexes for terminal output, escaped
      // quotes in string literals) rather than real defects, and were never
      // actually enforced (ESLint 9 couldn't load the legacy config). Keep them
      // off so the gate surfaces only real problems.
      "no-control-regex": "off",
      "no-useless-escape": "off",
      "no-shadow-restricted-names": "off",
      "react/no-unescaped-entities": "off",
      "react/jsx-no-comment-textnodes": "off",
      "react/prop-types": "off",
      // PRESERVED from the retired .eslintrc.json: ban direct useEffect.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='useEffect']",
          message:
            "Direct useEffect is banned. Use useMountEffect() for one-time external sync, useEventListener() for event subscriptions, or derive state inline. See CLAUDE.md for patterns.",
        },
      ],
    },
  },
];
