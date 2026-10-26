import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execute, exitCode, ExecutionFailure, type Scenario } from '../src';

const rule = {
  id: 'limit',
  description: 'The observed value must not exceed one.',
};
void describe('Sequential executor without domain knowledge', () => {
  void it('awaits steps in order, snapshots evidence, then evaluates the rule', async () => {
    const sequence: string[] = [];
    const state = { count: 0 };
    const scenario: Scenario<typeof state> = {
      id: 'sample',
      rule,
      steps: [
        {
          id: 'one',
          title: 'One',
          run: async (ctx) => {
            await Promise.resolve();
            sequence.push('one');
            ctx.state.count++;
            ctx.record('before', ctx.state);
          },
        },
        {
          id: 'two',
          title: 'Two',
          run: (ctx) => {
            assert.equal(ctx.state.count, 1);
            sequence.push('two');
            ctx.state.count = 0;
            return Promise.resolve();
          },
        },
      ],
      verify: (ctx) => {
        sequence.push('verify');
        return Promise.resolve({
          satisfied: ctx.state.count <= 1,
          actual: ctx.state.count,
          expected: 1,
        });
      },
    };
    const report = await execute(scenario, state);
    assert.deepEqual(sequence, ['one', 'two', 'verify']);
    assert.equal(report.outcome, 'satisfied');
    assert.deepEqual(report.evidence['before'], { count: 1 });
    assert.deepEqual(
      report.timeline.map((row) => row.id),
      ['one', 'two', 'evaluate-rule'],
    );
    assert.ok(report.timeline.every((row) => row.status === 'passed'));
    assert.equal(report.schemaVersion, 1);
    assert.match(report.runId, /^[0-9a-f-]{36}$/);
    assert.equal(exitCode(report.outcome), 0);
  });
  void it('reports a violated rule as a completed execution, not an executor failure', async () => {
    const report = await execute(
      {
        id: 'violation',
        rule,
        steps: [],
        verify: () =>
          Promise.resolve({ satisfied: false, actual: 2, expected: 1 }),
      },
      {},
    );
    assert.equal(report.outcome, 'violated');
    assert.equal(report.rule.actual, 2);
    assert.equal(report.failure, undefined);
    assert.equal(report.timeline[0]?.status, 'passed');
    assert.equal(exitCode(report.outcome), 1);
  });
  void it('stops at an execution error and does not evaluate the rule or expose exceptions', async () => {
    let later = false;
    const report = await execute(
      {
        id: 'broken',
        rule,
        steps: [
          {
            id: 'failing',
            title: 'Fail',
            run: () =>
              Promise.reject(new Error('password=private-secret SQL failed')),
          },
          {
            id: 'later',
            title: 'Later',
            run: () => {
              later = true;
              return Promise.resolve();
            },
          },
        ],
        verify: () => {
          later = true;
          return Promise.resolve({ satisfied: true, actual: 0, expected: 1 });
        },
      },
      {},
    );
    assert.equal(later, false);
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.rule.status, 'not_evaluated');
    assert.equal(report.failure?.code, 'EXECUTION_ERROR');
    assert.equal(report.timeline[0]?.status, 'failed');
    assert.ok(!JSON.stringify(report).includes('private-secret'));
    assert.equal(exitCode(report.outcome), 2);
  });
  void it('preserves static preparation codes and distinguishes a failed verification from a violation', async () => {
    const report = await execute(
      {
        id: 'unprepared',
        rule,
        steps: [],
        verify: () => Promise.reject(new ExecutionFailure('NOT_READY')),
      },
      {},
    );
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.failure?.code, 'NOT_READY');
  });
  void it('bounds a stuck step and never starts the following step', async () => {
    const report = await execute(
      {
        id: 'deadline',
        rule,
        steps: [
          {
            id: 'stuck',
            title: 'Stuck',
            run: () =>
              new Promise<void>(() => {
                /* Deliberately never completes. */
              }),
          },
        ],
        verify: () =>
          Promise.resolve({ satisfied: true, actual: 0, expected: 1 }),
      },
      {},
      { timeoutMs: 15 },
    );
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.failure?.code, 'EXECUTION_ABORTED');
    assert.equal(report.timeline.length, 1);
  });
});
