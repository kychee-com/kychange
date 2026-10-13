// Bundle each function into one file for the release: the gateway takes a
// single `source` per function, and `@run402/functions` is resolved at deploy.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

const FUNCTIONS = ["quote", "swap-sats-in", "swap-status", "payout-usdc"];
mkdirSync("dist", { recursive: true });
for (const name of FUNCTIONS) {
  await build({
    entryPoints: [`functions/${name}.mjs`],
    outfile: `dist/${name}.mjs`,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["@run402/functions", "node:*"],
    legalComments: "none",
    logLevel: "warning",
  });
  console.log(`bundled dist/${name}.mjs`);
}
