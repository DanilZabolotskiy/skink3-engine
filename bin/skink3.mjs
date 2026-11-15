#!/usr/bin/env node
// Command-line entry of skink3-engine. The engine is TypeScript run directly by
// Node (built-in type stripping), so this file only hands over to it.
import { main } from '../src/cli/main.ts';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`skink3: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
