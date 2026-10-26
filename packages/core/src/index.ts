import { randomUUID } from 'node:crypto';

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type Outcome = 'satisfied' | 'violated' | 'inconclusive';
export interface Failure {
  code: string;
  message: string;
}
export interface TimelineEntry {
  id: string;
  title: string;
  startedAt: string;
  finishedAt: string;
  status: 'passed' | 'failed';
  failure?: Failure;
}
export interface RuleDefinition {
  id: string;
  description: string;
}
export interface Verification {
  satisfied: boolean;
  actual: Json;
  expected: Json;
}
export interface RunReport {
  schemaVersion: 1;
  runId: string;
  scenario: string;
  startedAt: string;
  finishedAt: string;
  outcome: Outcome;
  timeline: TimelineEntry[];
  evidence: Record<string, Json>;
  rule: RuleDefinition & {
    status: 'satisfied' | 'violated' | 'not_evaluated';
    actual?: Json;
    expected?: Json;
  };
  failure?: Failure;
}
export interface Context<State> {
  readonly state: State;
  readonly runId: string;
  readonly signal: AbortSignal;
  record(key: string, value: Json): void;
}
export interface Step<State> {
  id: string;
  title: string;
  run(context: Context<State>): Promise<void>;
}
export interface Scenario<State> {
  id: string;
  rule: RuleDefinition;
  steps: Step<State>[];
  verify(context: Context<State>): Promise<Verification>;
}
export interface Progress {
  id: string;
  title: string;
  status: 'started' | 'passed' | 'failed';
}

// Only scenario-authored, static codes are public. Raw exceptions are never serialized.
export class ExecutionFailure extends Error {
  constructor(readonly code: string) {
    super('The execution could not be completed.');
  }
}

export async function execute<State>(
  scenario: Scenario<State>,
  state: State,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    onProgress?: (event: Progress) => void;
  } = {},
): Promise<RunReport> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 120000,
  );
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const report: RunReport = {
    schemaVersion: 1,
    runId: randomUUID(),
    scenario: scenario.id,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    outcome: 'inconclusive',
    timeline: [],
    evidence: {},
    rule: { ...scenario.rule, status: 'not_evaluated' },
  };
  const context: Context<State> = {
    state,
    runId: report.runId,
    signal,
    record: (key, value) => {
      signal.throwIfAborted();
      report.evidence[key] = structuredClone(value);
    },
  };
  const perform = async (step: Step<State>): Promise<void> => {
    const startedAt = new Date().toISOString();
    options.onProgress?.({ id: step.id, title: step.title, status: 'started' });
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = (): void =>
          reject(new ExecutionFailure('EXECUTION_ABORTED'));
        signal.addEventListener('abort', abort, { once: true });
        void Promise.resolve()
          .then(() => step.run(context))
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
      signal.throwIfAborted();
      report.timeline.push({
        id: step.id,
        title: step.title,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: 'passed',
      });
      options.onProgress?.({
        id: step.id,
        title: step.title,
        status: 'passed',
      });
    } catch (error) {
      const failure: Failure = {
        code: signal.aborted
          ? 'EXECUTION_ABORTED'
          : error instanceof ExecutionFailure &&
              /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
            ? error.code
            : 'EXECUTION_ERROR',
        message: 'The execution could not be completed.',
      };
      report.timeline.push({
        id: step.id,
        title: step.title,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: 'failed',
        failure,
      });
      options.onProgress?.({
        id: step.id,
        title: step.title,
        status: 'failed',
      });
      throw new ExecutionFailure(failure.code);
    }
  };
  try {
    for (const step of scenario.steps) await perform(step);
    await perform({
      id: 'evaluate-rule',
      title: 'Evaluate rule',
      run: async () => {
        const verification = await scenario.verify(context);
        signal.throwIfAborted();
        const status = verification.satisfied ? 'satisfied' : 'violated';
        report.rule = {
          ...scenario.rule,
          status,
          actual: structuredClone(verification.actual),
          expected: structuredClone(verification.expected),
        };
        report.outcome = status;
      },
    });
  } catch (error) {
    report.outcome = 'inconclusive';
    report.rule.status = 'not_evaluated';
    report.failure = {
      code: error instanceof ExecutionFailure ? error.code : 'EXECUTION_ERROR',
      message: 'The execution could not be completed.',
    };
  } finally {
    clearTimeout(timeout);
    report.finishedAt = new Date().toISOString();
  }
  return report;
}

export function exitCode(outcome: Outcome): 0 | 1 | 2 {
  return outcome === 'satisfied' ? 0 : outcome === 'violated' ? 1 : 2;
}
