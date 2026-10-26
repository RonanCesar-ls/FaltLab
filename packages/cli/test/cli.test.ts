import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { RunReport } from '@faultlab/core';
import { runCli, saveReport } from '../src/cli';

void describe('CLI reporting', () => {
  void it('prints usage and returns 2 for an unsupported command', async () => {
    const output: string[] = [];
    assert.equal(await runCli(['unknown'], {}, (line) => output.push(line)), 2);
    assert.match(output.join('\n'), /duplicate-charge/);
  });
  void it('saves a versioned inconclusive report without credentials and never overwrites evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'faultlab-cli-test-'));
    const output: string[] = [];
    let file: string | undefined;
    try {
      const code = await runCli(
        ['duplicate-charge'],
        {
          FAULTLAB_CHECKOUT_URL: 'http://user:private-secret@localhost',
          FAULTLAB_REPORT_DIR: directory,
        },
        (line) => output.push(line),
      );
      assert.equal(code, 2);
      const files = await readdir(directory);
      assert.equal(files.length, 1);
      file = join(directory, files[0] ?? '');
      const contents = await readFile(file, 'utf8');
      assert.ok(!contents.includes('private-secret'));
      const report = JSON.parse(contents) as RunReport;
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.scenario, 'duplicate-charge');
      assert.equal(report.outcome, 'inconclusive');
      assert.equal(report.failure?.code, 'INVALID_CONFIGURATION');
      assert.match(output.join('\n'), /INCONCLUSIVE/);
      await assert.rejects(saveReport(report, directory), { code: 'EEXIST' });
    } finally {
      if (file) await rm(file);
      await rmdir(directory);
    }
  });
});
