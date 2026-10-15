#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// Signal handling
process.on('SIGINT', () => {
  process.stdout.write('\n[chorus-mock] Received SIGINT (Ctrl+C). Terminating.\n');
  process.exit(130);
});

const scenarioPath = process.env.CHORUS_SCENARIO_FILE;
const hasSkipPerms = process.argv.includes('--dangerously-skip-permissions');

async function main() {
  if (!scenarioPath || !fs.existsSync(scenarioPath)) {
    const prompt = process.env.CHORUS_PROMPT || '';
    const agent = process.env.CHORUS_TARGET_ENGINE || 'claude';
    process.stdout.write(`\x1b[32m[${agent}]\x1b[0m Started interactive execution session.\n`);
    if (prompt) {
      process.stdout.write(`Received instruction: "${prompt}"\n`);
      process.stdout.write(`Analyzing codebase structure and preparing execution steps...\n`);
      process.stdout.write(`Inspecting project configuration and workspace files.\n`);
      process.stdout.write(`Ready. Execution finished cleanly.\n`);
    } else {
      process.stdout.write(`Native PTY Simulator Ready. Args: ${process.argv.slice(2).join(' ')}\n`);
    }
    if (hasSkipPerms) {
      process.stdout.write('\x1b[33m⚡ Mode: --dangerously-skip-permissions active\x1b[0m\n');
    }
    await new Promise((r) => setTimeout(r, 150));
    process.exit(0);
  }

  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));

  for (const step of scenario.steps || []) {
    if (step.type === 'stdout') {
      process.stdout.write(step.text);
    } else if (step.type === 'delay') {
      await new Promise((r) => setTimeout(r, step.ms || 50));
    } else if (step.type === 'tool_prompt') {
      if (hasSkipPerms) {
        process.stdout.write(`\n\x1b[33m⚡ [auto-approved --dangerously-skip-permissions]\x1b[0m Executing: ${step.command}\n`);
      } else {
        process.stdout.write(`\nAuthorize command: ${step.command} [y/n]: `);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise((resolve) => {
          rl.question('', (ans) => {
            rl.close();
            resolve(ans.trim());
          });
        });
        if (answer.toLowerCase() !== 'y') {
          process.stderr.write(`Permission denied by user.\n`);
          process.exit(1);
        }
        process.stdout.write(`Permission granted.\n`);
      }
    } else if (step.type === 'write_artifact') {
      const fullPath = path.resolve(process.cwd(), step.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, step.content || '');
      process.stdout.write(`Created artifact: ${step.path}\n`);
    }
  }

  process.exit(scenario.exitCode || 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
