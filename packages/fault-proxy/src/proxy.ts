import { randomUUID } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ProxyConfig } from './config';

const correlationHeader = 'x-correlation-id';
const correlationPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const armPath = '/__faults/drop-next-charge-response';
const maxChargeResponseBytes = 1024 * 1024;
const hopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

export type LogSink = (entry: Record<string, unknown>) => void;
export const jsonLog: LogSink = (entry) => console.log(JSON.stringify(entry));

function forwardedHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const excluded = new Set([
    ...hopHeaders,
    ...(headers.connection ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase()),
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !excluded.has(name)),
  );
}

function correlation(req: IncomingMessage): string | undefined {
  const values = req.headersDistinct[correlationHeader];
  if (!values) return randomUUID();
  return values.length === 1 && correlationPattern.test(values[0] ?? '')
    ? values[0]
    : undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createFaultProxy(config: ProxyConfig, sink: LogSink = jsonLog) {
  let armedBy: string | undefined;
  let closing = false;
  let shutdown: Promise<void> | undefined;
  let checkDrained: (() => void) | undefined;
  const active = new Set<ClientRequest>();
  const log = (
    event: string,
    correlationId: string | null,
    extra: Record<string, unknown> = {},
  ): void =>
    sink({
      timestamp: new Date().toISOString(),
      service: 'fault-proxy',
      level: 'info',
      event,
      correlationId,
      ...extra,
    });

  const server = createServer(
    { requestTimeout: 30000, headersTimeout: 10000, keepAliveTimeout: 1000 },
    (req, res) => {
      req.on('error', () => res.destroy());
      res.on('error', () => {
        /* A disconnected caller must not crash the proxy. */
      });
      const supplied = correlation(req);
      const correlationId = supplied ?? randomUUID();
      res.setHeader(correlationHeader, correlationId);
      const error = (status: number, code: string, message: string): void =>
        json(res, status, { statusCode: status, code, message, correlationId });
      if (!supplied) {
        req.resume();
        error(400, 'INVALID_CORRELATION_ID', 'Invalid correlation identifier.');
        return;
      }
      if (closing) {
        req.resume();
        error(503, 'PROXY_SHUTTING_DOWN', 'Proxy is shutting down.');
        return;
      }
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
        req.resume();
        error(400, 'BAD_REQUEST', 'Invalid request target.');
        return;
      }
      const incoming = new URL(req.url, 'http://proxy.invalid');
      if (incoming.pathname === '/health' && req.method === 'GET') {
        req.resume();
        json(res, 200, { status: 'ok', service: 'fault-proxy' });
        return;
      }
      if (incoming.pathname === armPath) {
        req.resume();
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST');
          error(405, 'METHOD_NOT_ALLOWED', 'Use POST to arm the fault.');
          return;
        }
        if (armedBy === undefined) {
          armedBy = correlationId;
          log('fault.armed', correlationId);
        }
        json(res, 200, { armed: true });
        return;
      }

      const target = new URL(config.providerUrl);
      target.pathname =
        config.providerUrl.pathname.replace(/\/$/, '') + incoming.pathname;
      target.search = incoming.search;
      const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const upstream = request(target, {
        method: req.method,
        agent: false,
        headers: {
          ...forwardedHeaders(req.headers),
          host: target.host,
          [correlationHeader]: correlationId,
        },
      });
      active.add(upstream);
      upstream.once('close', () => {
        active.delete(upstream);
        checkDrained?.();
      });
      let response: IncomingMessage | undefined;
      let settled = false;
      const fail = (status: number, code: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        log('upstream.failed', correlationId, { code });
        if (res.headersSent) res.destroy();
        else
          error(
            status,
            code,
            status === 504
              ? 'Provider deadline exceeded.'
              : 'Provider exchange failed.',
          );
        response?.destroy();
        upstream.destroy();
        req.resume();
      };
      const deadline = setTimeout(
        () => fail(504, 'PROXY_UPSTREAM_TIMEOUT'),
        config.timeoutMs,
      );
      upstream.on('error', () => fail(502, 'PROXY_UPSTREAM_ERROR'));
      req.on('error', () => fail(502, 'PROXY_CLIENT_ERROR'));
      res.on('error', () => {
        response?.resume();
      });
      res.on('close', () => {
        if (!settled) response?.resume();
      });
      upstream.once('response', (providerResponse) => {
        response = providerResponse;
        providerResponse.on('error', () => fail(502, 'PROXY_UPSTREAM_ERROR'));
        const eligible =
          req.method === 'POST' &&
          incoming.pathname === '/charges' &&
          providerResponse.statusCode === 201;
        const headers = forwardedHeaders(providerResponse.headers);
        const sendHeaders = (): void => {
          if (!res.destroyed)
            res.writeHead(providerResponse.statusCode ?? 502, headers);
        };
        const chunks: Buffer[] = [];
        let size = 0;
        if (eligible) {
          // Never expose even the headers of a candidate before the entire response arrives.
          providerResponse.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxChargeResponseBytes)
              fail(502, 'PROXY_RESPONSE_TOO_LARGE');
            else chunks.push(chunk);
          });
        } else {
          sendHeaders();
          if (res.destroyed) providerResponse.resume();
          else providerResponse.pipe(res);
        }
        providerResponse.once('end', () => {
          if (settled) return;
          if (!providerResponse.complete) {
            fail(502, 'PROXY_UPSTREAM_ERROR');
            return;
          }
          settled = true;
          clearTimeout(deadline);
          if (!eligible) return;
          if (armedBy !== undefined) {
            const armedCorrelationId = armedBy;
            armedBy = undefined;
            log('fault.applied', correlationId, { armedCorrelationId });
            res.destroy();
          } else {
            sendHeaders();
            if (!res.destroyed) res.end(Buffer.concat(chunks));
          }
        });
      });
      req.pipe(upstream);
    },
  );
  server.setTimeout(30000, (socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());

  return {
    server,
    close(): Promise<void> {
      if (shutdown) return shutdown;
      closing = true;
      log('proxy.stopping', null);
      shutdown = new Promise<void>((resolve, reject) => {
        let serverClosed = false;
        const deadline = setTimeout(() => {
          for (const request of active) request.destroy();
          server.closeAllConnections();
        }, config.shutdownTimeoutMs);
        checkDrained = () => {
          if (serverClosed && active.size === 0) {
            clearTimeout(deadline);
            checkDrained = undefined;
            log('proxy.stopped', null);
            resolve();
          }
        };
        server.close((error) => {
          if (error) {
            clearTimeout(deadline);
            reject(error);
          } else {
            serverClosed = true;
            checkDrained?.();
          }
        });
      });
      return shutdown;
    },
  };
}
