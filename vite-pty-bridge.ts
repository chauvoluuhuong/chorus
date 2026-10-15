import type { Plugin } from 'vite';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface PtyProcessRecord {
  proc: ChildProcess;
  buffer: string[];
  listeners: ((chunk: string) => void)[];
  exitListeners: ((code: number) => void)[];
  exitCode: number | null;
}

export function ptyBridgePlugin(): Plugin {
  const processes = new Map<string, PtyProcessRecord>();

  return {
    name: 'pty-bridge-plugin',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

        if (url.pathname === '/api/pty/spawn' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => (body += chunk));
          req.on('end', () => {
            try {
              const { id, command, args = [], cwd = process.cwd(), env = {} } = JSON.parse(body);

              // Spawn the real OS child process
              const proc = spawn(command, args, {
                cwd,
                env: {
                  ...process.env,
                  ...env,
                  FORCE_COLOR: '1',
                },
                stdio: ['pipe', 'pipe', 'pipe'],
              });

              const record: PtyProcessRecord = {
                proc,
                buffer: [],
                listeners: [],
                exitListeners: [],
                exitCode: null,
              };

              const handleChunk = (chunk: Buffer) => {
                const text = chunk.toString();
                record.buffer.push(text);
                record.listeners.forEach(fn => fn(text));
              };

              proc.stdout?.on('data', handleChunk);
              proc.stderr?.on('data', handleChunk);

              proc.on('exit', code => {
                record.exitCode = code ?? 0;
                record.exitListeners.forEach(fn => fn(record.exitCode!));
              });

              processes.set(id, record);

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, id, pid: proc.pid }));
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        if (url.pathname === '/api/pty/stream' && req.method === 'GET') {
          const id = url.searchParams.get('id');
          if (!id || !processes.has(id)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Process not found' }));
            return;
          }

          const record = processes.get(id)!;

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          // Flush any buffered chunks
          for (const chunk of record.buffer) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }

          // If already exited
          if (record.exitCode !== null) {
            res.write(`event: exit\ndata: ${JSON.stringify({ code: record.exitCode })}\n\n`);
            res.end();
            return;
          }

          const onData = (text: string) => {
            res.write(`data: ${JSON.stringify(text)}\n\n`);
          };

          const onExit = (code: number) => {
            res.write(`event: exit\ndata: ${JSON.stringify({ code })}\n\n`);
            res.end();
          };

          record.listeners.push(onData);
          record.exitListeners.push(onExit);

          req.on('close', () => {
            record.listeners = record.listeners.filter(fn => fn !== onData);
            record.exitListeners = record.exitListeners.filter(fn => fn !== onExit);
          });
          return;
        }

        if (url.pathname === '/api/pty/write' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => (body += chunk));
          req.on('end', () => {
            try {
              const { id, data } = JSON.parse(body);
              const record = processes.get(id);
              if (record && record.proc.stdin) {
                record.proc.stdin.write(data);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: true }));
              } else {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: 'Process not found or stdin closed' }));
              }
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        if (url.pathname === '/api/pty/kill' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => (body += chunk));
          req.on('end', () => {
            try {
              const { id, signal = 'SIGINT' } = JSON.parse(body);
              const record = processes.get(id);
              if (record) {
                record.proc.kill(signal as NodeJS.Signals);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: true }));
              } else {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: 'Process not found' }));
              }
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // Workspace files listing for @-mention
        if (url.pathname === '/api/fs/scan' && req.method === 'GET') {
          const workspaceDir = url.searchParams.get('dir') || process.cwd();
          const files: string[] = [];
          const folders: string[] = [];

          function walk(dir: string, base: string) {
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (['.git', 'node_modules', 'dist', 'target', '.DS_Store'].includes(entry.name)) {
                  continue;
                }
                const relPath = path.join(base, entry.name);
                if (entry.isDirectory()) {
                  folders.push(relPath);
                  walk(path.join(dir, entry.name), relPath);
                } else if (entry.isFile()) {
                  files.push(relPath);
                }
              }
            } catch (e) {
              // ignore
            }
          }

          walk(workspaceDir, '');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ files, folders }));
          return;
        }

        next();
      });
    },
  };
}
