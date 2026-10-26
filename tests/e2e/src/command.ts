import { spawn } from 'node:child_process';

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  capture?: boolean;
}

export function command(
  executable: string,
  args: string[],
  options: CommandOptions,
): Promise<string> {
  if (options.signal?.aborted)
    return Promise.reject(new Error('Command aborted before spawn.'));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let spawnError: Error | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const terminate = (): void => {
      if (aborted || child.exitCode !== null || child.signalCode !== null)
        return;
      aborted = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 3000);
    };
    const timeout = setTimeout(terminate, options.timeoutMs ?? 120_000);
    options.signal?.addEventListener('abort', terminate, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-2_000_000);
      if (!options.capture) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-100_000);
      if (!options.capture) process.stderr.write(chunk);
    });
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener('abort', terminate);
      if (spawnError) reject(spawnError);
      else if (aborted)
        reject(
          new Error(
            `Command aborted or exceeded its deadline: ${executable}. ${options.capture ? stderr : ''}`,
          ),
        );
      else if (code !== 0)
        reject(
          new Error(
            `${executable} exited with ${code}. ${options.capture ? stderr : ''}`,
          ),
        );
      else resolve(stdout.trim());
    });
  });
}
