var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function ptyBridgePlugin() {
    var processes = new Map();
    return {
        name: 'pty-bridge-plugin',
        configureServer: function (server) {
            server.middlewares.use(function (req, res, next) {
                var url = new URL(req.url || '/', "http://".concat(req.headers.host || 'localhost'));
                if (url.pathname === '/api/pty/spawn' && req.method === 'POST') {
                    var body_1 = '';
                    req.on('data', function (chunk) { return (body_1 += chunk); });
                    req.on('end', function () {
                        var _a, _b;
                        try {
                            var _c = JSON.parse(body_1), id = _c.id, command = _c.command, _d = _c.args, args = _d === void 0 ? [] : _d, _e = _c.cwd, cwd = _e === void 0 ? process.cwd() : _e, _f = _c.env, env = _f === void 0 ? {} : _f;
                            var homeDir = os.homedir();
                            var extraPath = "".concat(homeDir, "/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:").concat(homeDir, "/.cargo/bin");
                            var mergedPath = "".concat(extraPath, ":").concat(process.env.PATH || '');
                            // Spawn the real OS child process
                            var proc = spawn(command, args, {
                                cwd: cwd,
                                env: __assign(__assign(__assign(__assign({}, process.env), { PATH: mergedPath }), env), { FORCE_COLOR: '1' }),
                                stdio: ['pipe', 'pipe', 'pipe'],
                            });
                            var record_1 = {
                                proc: proc,
                                buffer: [],
                                listeners: [],
                                exitListeners: [],
                                exitCode: null,
                            };
                            var handleChunk = function (chunk) {
                                var text = chunk.toString();
                                record_1.buffer.push(text);
                                record_1.listeners.forEach(function (fn) { return fn(text); });
                            };
                            (_a = proc.stdout) === null || _a === void 0 ? void 0 : _a.on('data', handleChunk);
                            (_b = proc.stderr) === null || _b === void 0 ? void 0 : _b.on('data', handleChunk);
                            proc.on('exit', function (code) {
                                record_1.exitCode = code !== null && code !== void 0 ? code : 0;
                                record_1.exitListeners.forEach(function (fn) { return fn(record_1.exitCode); });
                            });
                            processes.set(id, record_1);
                            res.setHeader('Content-Type', 'application/json');
                            res.end(JSON.stringify({ ok: true, id: id, pid: proc.pid }));
                        }
                        catch (err) {
                            res.statusCode = 500;
                            res.end(JSON.stringify({ error: err.message }));
                        }
                    });
                    return;
                }
                if (url.pathname === '/api/pty/stream' && req.method === 'GET') {
                    var id = url.searchParams.get('id');
                    if (!id || !processes.has(id)) {
                        res.statusCode = 404;
                        res.end(JSON.stringify({ error: 'Process not found' }));
                        return;
                    }
                    var record_2 = processes.get(id);
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive',
                    });
                    // Flush any buffered chunks
                    for (var _i = 0, _a = record_2.buffer; _i < _a.length; _i++) {
                        var chunk = _a[_i];
                        res.write("data: ".concat(JSON.stringify(chunk), "\n\n"));
                    }
                    // If already exited
                    if (record_2.exitCode !== null) {
                        res.write("event: exit\ndata: ".concat(JSON.stringify({ code: record_2.exitCode }), "\n\n"));
                        res.end();
                        return;
                    }
                    var onData_1 = function (text) {
                        res.write("data: ".concat(JSON.stringify(text), "\n\n"));
                    };
                    var onExit_1 = function (code) {
                        res.write("event: exit\ndata: ".concat(JSON.stringify({ code: code }), "\n\n"));
                        res.end();
                    };
                    record_2.listeners.push(onData_1);
                    record_2.exitListeners.push(onExit_1);
                    req.on('close', function () {
                        record_2.listeners = record_2.listeners.filter(function (fn) { return fn !== onData_1; });
                        record_2.exitListeners = record_2.exitListeners.filter(function (fn) { return fn !== onExit_1; });
                    });
                    return;
                }
                if (url.pathname === '/api/pty/write' && req.method === 'POST') {
                    var body_2 = '';
                    req.on('data', function (chunk) { return (body_2 += chunk); });
                    req.on('end', function () {
                        try {
                            var _a = JSON.parse(body_2), id = _a.id, data = _a.data;
                            var record = processes.get(id);
                            if (record && record.proc.stdin) {
                                record.proc.stdin.write(data);
                                res.setHeader('Content-Type', 'application/json');
                                res.end(JSON.stringify({ ok: true }));
                            }
                            else {
                                res.statusCode = 404;
                                res.end(JSON.stringify({ error: 'Process not found or stdin closed' }));
                            }
                        }
                        catch (err) {
                            res.statusCode = 500;
                            res.end(JSON.stringify({ error: err.message }));
                        }
                    });
                    return;
                }
                if (url.pathname === '/api/pty/kill' && req.method === 'POST') {
                    var body_3 = '';
                    req.on('data', function (chunk) { return (body_3 += chunk); });
                    req.on('end', function () {
                        try {
                            var _a = JSON.parse(body_3), id = _a.id, _b = _a.signal, signal = _b === void 0 ? 'SIGINT' : _b;
                            var record = processes.get(id);
                            if (record) {
                                record.proc.kill(signal);
                                res.setHeader('Content-Type', 'application/json');
                                res.end(JSON.stringify({ ok: true }));
                            }
                            else {
                                res.statusCode = 404;
                                res.end(JSON.stringify({ error: 'Process not found' }));
                            }
                        }
                        catch (err) {
                            res.statusCode = 500;
                            res.end(JSON.stringify({ error: err.message }));
                        }
                    });
                    return;
                }
                // Workspace files listing for @-mention
                if (url.pathname === '/api/fs/scan' && req.method === 'GET') {
                    var workspaceDir = url.searchParams.get('dir') || process.cwd();
                    var files_1 = [];
                    var folders_1 = [];
                    function walk(dir, base) {
                        try {
                            var entries = fs.readdirSync(dir, { withFileTypes: true });
                            for (var _i = 0, entries_1 = entries; _i < entries_1.length; _i++) {
                                var entry = entries_1[_i];
                                if (['.git', 'node_modules', 'dist', 'target', '.DS_Store'].includes(entry.name)) {
                                    continue;
                                }
                                var relPath = path.join(base, entry.name);
                                if (entry.isDirectory()) {
                                    folders_1.push(relPath);
                                    walk(path.join(dir, entry.name), relPath);
                                }
                                else if (entry.isFile()) {
                                    files_1.push(relPath);
                                }
                            }
                        }
                        catch (e) {
                            // ignore
                        }
                    }
                    walk(workspaceDir, '');
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ files: files_1, folders: folders_1 }));
                    return;
                }
                // Artifact stream & file watcher
                if (url.pathname === '/api/artifacts/stream' && req.method === 'GET') {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive',
                    });
                    var baseArtifactsDir_1 = path.resolve(process.cwd(), '.chorus/artifacts');
                    if (!fs.existsSync(baseArtifactsDir_1)) {
                        fs.mkdirSync(baseArtifactsDir_1, { recursive: true });
                    }
                    var lastMtimes_1 = new Map();
                    var scanArtifacts_1 = function (emitEvents) {
                        function checkDir(d) {
                            try {
                                if (!fs.existsSync(d))
                                    return;
                                var entries = fs.readdirSync(d, { withFileTypes: true });
                                for (var _i = 0, entries_2 = entries; _i < entries_2.length; _i++) {
                                    var e = entries_2[_i];
                                    var p = path.join(d, e.name);
                                    if (e.isDirectory()) {
                                        checkDir(p);
                                    }
                                    else if (e.isFile()) {
                                        var stats = fs.statSync(p);
                                        var prev = lastMtimes_1.get(p) || 0;
                                        if (stats.mtimeMs > prev) {
                                            lastMtimes_1.set(p, stats.mtimeMs);
                                            if (emitEvents) {
                                                var content = fs.readFileSync(p, 'utf8');
                                                var rel = path.relative(process.cwd(), p);
                                                var parts = rel.split(path.sep);
                                                // .chorus/artifacts/<agent>/<threadId>/<name>
                                                var agent = parts[2] || 'agy';
                                                var threadId = parts[3] || 'thread-1';
                                                var name_1 = parts[parts.length - 1];
                                                res.write("event: artifact:updated\ndata: ".concat(JSON.stringify({
                                                    path: rel,
                                                    name: name_1,
                                                    content: content,
                                                    agent: agent,
                                                    threadId: threadId,
                                                    version: 1,
                                                }), "\n\n"));
                                            }
                                        }
                                    }
                                }
                            }
                            catch (_a) {
                                // ignore
                            }
                        }
                        checkDir(baseArtifactsDir_1);
                    };
                    // Seed existing mtimes so stale artifacts from old sessions do not auto-pop
                    scanArtifacts_1(false);
                    var pollTimer_1 = setInterval(function () { return scanArtifacts_1(true); }, 300);
                    req.on('close', function () {
                        clearInterval(pollTimer_1);
                    });
                    return;
                }
                if (url.pathname === '/api/artifacts/notify' && req.method === 'POST') {
                    var body_4 = '';
                    req.on('data', function (chunk) { return (body_4 += chunk); });
                    req.on('end', function () {
                        try {
                            var _a = JSON.parse(body_4), filePath = _a.filePath, content = _a.content, _b = _a.agent, agent = _b === void 0 ? 'agy' : _b, _c = _a.threadId, threadId = _c === void 0 ? 'thread-1' : _c;
                            var sourcePath = path.isAbsolute(filePath)
                                ? filePath
                                : path.resolve(process.cwd(), filePath);
                            var finalContent = typeof content === 'string' ? content : '';
                            if (fs.existsSync(sourcePath)) {
                                try {
                                    finalContent = fs.readFileSync(sourcePath, 'utf8');
                                }
                                catch (_d) { }
                            }
                            var fileName = path.basename(filePath);
                            var targetRelPath = filePath.startsWith('.chorus/artifacts')
                                ? filePath
                                : path.join('.chorus/artifacts', agent, threadId, fileName);
                            var targetFullPath = path.resolve(process.cwd(), targetRelPath);
                            fs.mkdirSync(path.dirname(targetFullPath), { recursive: true });
                            fs.writeFileSync(targetFullPath, finalContent);
                            res.setHeader('Content-Type', 'application/json');
                            res.end(JSON.stringify({
                                ok: true,
                                name: fileName,
                                path: targetRelPath,
                                content: finalContent,
                                agent: agent,
                                threadId: threadId,
                            }));
                        }
                        catch (err) {
                            res.statusCode = 500;
                            res.end(JSON.stringify({ error: err.message }));
                        }
                    });
                    return;
                }
                // Skills Studio sync & materialization endpoints
                if (url.pathname === '/api/skills/scan' && req.method === 'POST') {
                    var searchRoots = ['.agents/skills', '.claude/skills', '.codex/skills'];
                    var scannedCount = 0;
                    var foundSkills = [];
                    for (var _b = 0, searchRoots_1 = searchRoots; _b < searchRoots_1.length; _b++) {
                        var root = searchRoots_1[_b];
                        var rootPath = path.resolve(process.cwd(), root);
                        if (fs.existsSync(rootPath)) {
                            scannedCount++;
                            try {
                                var subdirs = fs.readdirSync(rootPath, { withFileTypes: true });
                                for (var _c = 0, subdirs_1 = subdirs; _c < subdirs_1.length; _c++) {
                                    var d = subdirs_1[_c];
                                    if (d.isDirectory()) {
                                        var skillMd = path.join(rootPath, d.name, 'SKILL.md');
                                        if (fs.existsSync(skillMd)) {
                                            var content = fs.readFileSync(skillMd, 'utf8');
                                            foundSkills.push({
                                                id: d.name,
                                                name: d.name,
                                                command: "/".concat(d.name),
                                                description: "Imported multi-file bundle from ".concat(root),
                                                path: "".concat(root, "/").concat(d.name, "/SKILL.md"),
                                                active: false,
                                                origin: "Imported from ".concat(root),
                                                content: content,
                                            });
                                        }
                                    }
                                }
                            }
                            catch (_d) {
                                // ignore
                            }
                        }
                    }
                    var importedSkills = foundSkills.filter(function (s) { return !s.path.startsWith('.agents/skills'); });
                    var newCount = importedSkills.length > 0 ? importedSkills.length : (foundSkills.length > 0 ? 1 : 0);
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({
                        scannedCount: Math.max(2, scannedCount),
                        newCount: newCount,
                        skills: foundSkills,
                    }));
                    return;
                }
                if (url.pathname === '/api/skills/materialize' && req.method === 'POST') {
                    var body_5 = '';
                    req.on('data', function (chunk) { return (body_5 += chunk); });
                    req.on('end', function () {
                        try {
                            var _a = JSON.parse(body_5), id = _a.id, active = _a.active, _b = _a.content, content = _b === void 0 ? '# Skill' : _b;
                            var targetDir = path.resolve(process.cwd(), '.agents/skills', id);
                            if (active) {
                                fs.mkdirSync(targetDir, { recursive: true });
                                fs.writeFileSync(path.join(targetDir, 'SKILL.md'), content);
                                try {
                                    fs.chmodSync(path.join(targetDir, 'SKILL.md'), 493);
                                }
                                catch (_c) { }
                            }
                            else {
                                if (fs.existsSync(targetDir)) {
                                    fs.rmSync(targetDir, { recursive: true, force: true });
                                }
                            }
                            res.setHeader('Content-Type', 'application/json');
                            res.end(JSON.stringify({ ok: true, id: id, active: active }));
                        }
                        catch (err) {
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
