import { spawn } from 'node:child_process';

async function terminateTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    // Each command owns a process group, including Docker's Compose plugin.
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const deadline = setTimeout(() => killer.kill(), 10_000);
    killer.once('error', reject);
    killer.once('close', (code) => {
      clearTimeout(deadline);
      if (code === 0) resolve();
      else reject(new Error('Could not terminate owned process tree: ' + pid));
    });
  });
}

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  capture?: boolean;
  allowedExitCodes?: number[];
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
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let spawnError: Error | undefined;
    let termination: Promise<void> | undefined;
    const terminate = (): void => {
      if (aborted || child.exitCode !== null || child.signalCode !== null)
        return;
      aborted = true;
      if (child.pid !== undefined) {
        termination = terminateTree(child.pid).catch((error: unknown) => {
          spawnError =
            error instanceof Error ? error : new Error(String(error));
          child.kill('SIGKILL');
        });
      }
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
      options.signal?.removeEventListener('abort', terminate);
      void Promise.resolve(termination).then(() => {
        if (spawnError) reject(spawnError);
        else if (aborted)
          reject(
            new Error(
              `Command aborted or exceeded its deadline: ${executable}. ${options.capture ? stderr : ''}`,
            ),
          );
        else if (
          code === null ||
          !(options.allowedExitCodes ?? [0]).includes(code)
        )
          reject(
            new Error(
              `${executable} exited with ${code}. ${options.capture ? stderr : ''}`,
            ),
          );
        else resolve(stdout.trim());
      });
    });
  });
}
