#!/usr/bin/env node
// Pi Remote Hub launcher: runs the TypeScript sources through jiti, the
// same loader Pi uses for extensions, so there is no build step.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { main } = await jiti.import("./main.ts");
process.exitCode = await main(process.argv.slice(2));
