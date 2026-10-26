#!/usr/bin/env node
import { runCli } from './cli';

const controller = new AbortController();
const abort = (): void => controller.abort();
process.once('SIGINT', abort);
process.once('SIGTERM', abort);
void runCli(process.argv.slice(2), process.env, console.log, controller.signal)
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    console.error('Conclusion: INCONCLUSIVE (CLI_EXECUTION_ERROR).');
    process.exitCode = 2;
  })
  .finally(() => {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  });
