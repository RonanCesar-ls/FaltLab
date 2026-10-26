import { exitCode, type RunReport } from '@faultlab/core';
import { runDuplicateCharge } from '@faultlab/scenarios';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function saveReport(
  report: RunReport,
  directory: string,
): Promise<string> {
  const target = resolve(directory);
  await mkdir(target, { recursive: true });
  const path = resolve(target, report.runId + '.json');
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return path;
}

export async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  output: (line: string) => void = console.log,
  signal?: AbortSignal,
): Promise<0 | 1 | 2> {
  if (args.length !== 1 || args[0] !== 'duplicate-charge') {
    output('Usage: pnpm faultlab duplicate-charge');
    output('Exit codes: 0 satisfied, 1 violated, 2 inconclusive.');
    return 2;
  }
  output(
    'Scenario: duplicate-charge (run exclusively; no concurrent payments).',
  );
  let number = 0;
  const report = await runDuplicateCharge(env, {
    ...(signal ? { signal } : {}),
    onProgress: (event) => {
      if (event.status === 'started') output(`[${++number}/9] ${event.title}`);
      else
        output(
          `  ${event.status === 'passed' ? 'DONE' : event.status.toUpperCase()}`,
        );
    },
  });
  let path: string;
  try {
    path = await saveReport(
      report,
      env['FAULTLAB_REPORT_DIR'] ?? 'reports/duplicate-charge',
    );
  } catch {
    output(
      'Conclusion: INCONCLUSIVE (REPORT_WRITE_FAILED). No report could be saved.',
    );
    return 2;
  }
  output(`Run: ${report.runId}`);
  output(`Conclusion: ${report.outcome.toUpperCase()}`);
  output(`Rule: ${report.rule.description}`);
  if (typeof report.rule.actual === 'number')
    output(
      `Observed SUCCEEDED charges: ${report.rule.actual}; maximum allowed: 1.`,
    );
  if (report.failure)
    output(
      `Execution issue: ${report.failure.code}. See observations; the rule was not evaluated.`,
    );
  output(`Report: ${path}`);
  return exitCode(report.outcome);
}
