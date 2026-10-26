import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export function newProject(): string {
  return 'faultlab-e2e-' + randomUUID().replaceAll('-', '');
}

export function assertTestProject(project: string): void {
  assert.match(
    project,
    /^faultlab-e2e-[0-9a-f]{32}$/,
    'Refusing to operate on a project outside this E2E run.',
  );
}

export function localPort(mapping: string): number {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping.trim());
  assert.ok(match, 'Expected a random port bound only to localhost.');
  const port = Number(match[1]);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  return port;
}

export function assertIsolatedCompose(value: unknown): void {
  assert.ok(value && typeof value === 'object');
  const config = value as Record<string, unknown>;
  assert.ok(
    !config['volumes'] || Object.keys(config['volumes']).length === 0,
    'E2E must not use persistent volumes.',
  );
  const services = config['services'] as Record<
    string,
    Record<string, unknown>
  >;
  const project = String(config['name']);
  assertTestProject(project);
  const networks = config['networks'] as Record<
    string,
    Record<string, unknown>
  >;
  for (const network of Object.values(networks)) {
    assert.notEqual(
      network['external'],
      true,
      'External networks are forbidden.',
    );
    assert.ok(
      typeof network['name'] === 'string' &&
        network['name'].startsWith(project + '_'),
      'Network ownership does not match this test project.',
    );
  }
  assert.deepEqual(Object.keys(services).sort(), [
    'checkout',
    'checkout-db',
    'payment-provider',
    'provider-db',
  ]);
  for (const service of Object.values(services)) {
    assert.ok(
      !service['container_name'],
      'Fixed container names are forbidden.',
    );
    assert.ok(
      !service['volumes'],
      'Host and named volume mounts are forbidden.',
    );
    assert.ok(!service['env_file'], 'Application env files are forbidden.');
  }
  for (const name of ['checkout-db', 'provider-db']) {
    assert.ok(
      Array.isArray(services[name]?.['tmpfs']) &&
        services[name]?.['tmpfs'].includes('/var/lib/postgresql/data'),
    );
  }
}
