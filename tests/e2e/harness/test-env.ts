import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface CliScenario {
  steps: Array<{
    type: 'stdout' | 'delay' | 'tool_prompt' | 'write_artifact';
    text?: string;
    ms?: number;
    command?: string;
    path?: string;
    content?: string;
  }>;
  exitCode?: number;
}

export async function createTestWorkspace(): Promise<{
  workspaceDir: string;
  createScenario: (scenario: CliScenario) => string;
  cleanup: () => void;
}> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-e2e-'));

  // Scaffold minimum project directories
  fs.mkdirSync(path.join(tmpDir, '.agents/skills'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.chorus/artifacts'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

  const scenarioPath = path.join(tmpDir, 'scenario.json');

  return {
    workspaceDir: tmpDir,
    createScenario: (scenario: CliScenario) => {
      fs.writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2));
      return scenarioPath;
    },
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (e) {
        // ignore
      }
    }
  };
}
