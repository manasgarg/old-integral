import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

// Layers in src/, from the top down. A module may import from its own layer
// and from layers below it, never from a layer above it. See
// docs/architecture.md.
const layers = [
  "pi-extensions",
  "cli",
  "services",
  "integrations",
  "stores",
  "domain",
  "platform",
];

function layerBoundary(layer) {
  // Pi extensions are bundled and run inside Pi, so they import nothing else
  // from src/.
  const forbidden =
    layer === "pi-extensions"
      ? layers.slice(1)
      : layers.slice(0, layers.indexOf(layer));
  return {
    files: [`src/${layer}/**/*.ts`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: `(^|/)(${forbidden.join("|")})/`,
              message: `src/${layer} must not import from a higher layer (${forbidden.join(", ")}). See docs/architecture.md.`,
            },
          ],
        },
      ],
    },
  };
}

export default defineConfig(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  {
    files: ["bin/**/*.js"],
    extends: [js.configs.recommended, prettier],
    languageOptions: {
      globals: {
        process: "readonly",
      },
    },
  },
  {
    files: ["{scripts,src,test}/**/*.ts"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      prettier,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
      "no-control-regex": "off",
    },
  },
  ...layers.map(layerBoundary),
);
