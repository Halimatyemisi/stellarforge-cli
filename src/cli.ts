#!/usr/bin/env node

import { isDebugEnabled, runWithCliErrorBoundary } from './errors/index.js';
import { EXIT_CODES } from './errors/errors.js';
import { runCli } from './main.js';

const boundaryExitCode = await runWithCliErrorBoundary(
  () => runCli(),
  undefined,
  { debug: isDebugEnabled(process.env.DEBUG) },
);
if (boundaryExitCode !== EXIT_CODES.success) {
  process.exitCode = boundaryExitCode;
}
