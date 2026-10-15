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

        // Artifact stream & file watcher
        if (url.pathname === '/api/artifacts/stream' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          const baseArtifactsDir = path.resolve(process.cwd(), '.chorus/artifacts');
          if (!fs.existsSync(baseArtifactsDir)) {
            fs.mkdirSync(baseArtifactsDir, { recursive: true });
          }

          let lastMtimes = new Map<string, number>();

          const scanArtifacts = () => {
            function checkDir(d: string) {
              try {
                if (!fs.existsSync(d)) return;
                const entries = fs.readdirSync(d, { withFileTypes: true });
                for (const e of entries) {
                  const p = path.join(d, e.name);
                  if (e.isDirectory()) {
                    checkDir(p);
                  } else if (e.isFile()) {
                    const stats = fs.statSync(p);
                    const prev = lastMtimes.get(p) || 0;
                    if (stats.mtimeMs > prev) {
                      lastMtimes.set(p, stats.mtimeMs);
                      const content = fs.readFileSync(p, 'utf8');
                      const rel = path.relative(process.cwd(), p);
                      const parts = rel.split(path.sep);
                      // .chorus/artifacts/<agent>/<threadId>/<name>
                      const agent = parts[2] || 'claude';
                      const threadId = parts[3] || 'thread-1';
                      const name = parts[parts.length - 1];

                      res.write(
                        `event: artifact:updated\ndata: ${JSON.stringify({
                          path: rel,
                          name,
                          content,
                          agent,
                          threadId,
                          version: 1,
                        })}\n\n`,
                      );
                    }
                  }
                }
              } catch {
                // ignore
              }
            }
            checkDir(baseArtifactsDir);
          };

          // Initial scan
          scanArtifacts();

          const pollTimer = setInterval(scanArtifacts, 300);

          req.on('close', () => {
            clearInterval(pollTimer);
          });
          return;
        }

        if (url.pathname === '/api/artifacts/notify' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => (body += chunk));
          req.on('end', () => {
            try {
              const { filePath, content = '' } = JSON.parse(body);
              const fullPath = path.resolve(process.cwd(), filePath);
              fs.mkdirSync(path.dirname(fullPath), { recursive: true });
              fs.writeFileSync(fullPath, content);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, path: filePath }));
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // Skills Studio sync & materialization endpoints
        if (url.pathname === '/api/skills/scan' && req.method === 'POST') {
          const searchRoots = ['.agents/skills', '.claude/skills', '.codex/skills'];
          let scannedCount = 0;
          const foundSkills: any[] = [];

          for (const root of searchRoots) {
            const rootPath = path.resolve(process.cwd(), root);
            if (fs.existsSync(rootPath)) {
              scannedCount++;
              try {
                const subdirs = fs.readdirSync(rootPath, { withFileTypes: true });
                for (const d of subdirs) {
                  if (d.isDirectory()) {
                    const skillMd = path.join(rootPath, d.name, 'SKILL.md');
                    if (fs.existsSync(skillMd)) {
                      const content = fs.readFileSync(skillMd, 'utf8');
                      foundSkills.push({
                        id: d.name,
                        name: d.name,
                        command: `/${d.name}`,
                        description: `Imported multi-file bundle from ${root}`,
                        path: `${root}/${d.name}/SKILL.md`,
                        active: false,
                        origin: `Imported from ${root}`,
                        content,
                      });
                    }
                  }
                }
              } catch {
                // ignore
              }
            }
          }

          const importedSkills = foundSkills.filter(s => !s.path.startsWith('.agents/skills'));
          const newCount = importedSkills.length > 0 ? importedSkills.length : (foundSkills.length > 0 ? 1 : 0);

          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              scannedCount: Math.max(2, scannedCount),
              newCount,
              skills: foundSkills,
            }),
          );
          return;
        }

        if (url.pathname === '/api/skills/materialize' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => (body += chunk));
          req.on('end', () => {
            try {
              const { id, active, content = '# Skill' } = JSON.parse(body);
              const targetDir = path.resolve(process.cwd(), '.agents/skills', id);
              if (active) {
                fs.mkdirSync(targetDir, { recursive: true });
                fs.writeFileSync(path.join(targetDir, 'SKILL.md'), content);
                try {
                  fs.chmodSync(path.join(targetDir, 'SKILL.md'), 0o755);
                } catch {}
              } else {
                if (fs.existsSync(targetDir)) {
                  fs.rmSync(targetDir, { recursive: true, force: true });
                }
              }
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, id, active }));
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        next();
      });
    },
  };
}
