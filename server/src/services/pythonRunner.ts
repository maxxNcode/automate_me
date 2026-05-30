/**
 * Python Script Runner
 * Executes Python integration scripts and returns parsed results.
 * All scripts accept JSON via stdin and return JSON via stdout.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const PYTHON_SCRIPTS_DIR = path.resolve(__dirname, '..', '..', '..', 'python');
const OUTPUT_DIR = path.resolve(__dirname, '..', '..', '..', 'output');

interface RunOptions {
  timeout?: number;
  env?: Record<string, string>;
}

/**
 * Find the Python executable (python3 or python)
 */
function findPython(): string {
  // Windows: Microsoft Store Python installs to a versioned folder
  // The App Execution Alias (python.exe in WindowsApps) is a reparse point
  // that doesn't always resolve from child processes — use the real path directly
  if (process.platform === 'win32') {
    const realPython = 'C:\\Users\\Admin\\AppData\\Local\\Microsoft\\WindowsApps\\PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0\\python.exe';
    return realPython;
  }
  return 'python3';
}

/**
 * Run a Python script with JSON input, return parsed JSON output.
 */
export async function runPythonScript<T>(
  scriptName: string,
  input: Record<string, unknown> = {},
  options: RunOptions = {}
): Promise<T> {
  const scriptPath = path.join(PYTHON_SCRIPTS_DIR, scriptName);
  
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Python script not found: ${scriptPath}`);
  }

  return new Promise((resolve, reject) => {
    const python = findPython();
    const inputStr = JSON.stringify(input);
    
    const child = spawn(python, [scriptPath], {
      cwd: PYTHON_SCRIPTS_DIR,
      env: { ...process.env, ...options.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options.timeout || 120000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (error: Error) => {
      reject(new Error(`Failed to start Python script: ${error.message}`));
    });

    child.on('close', (code: number | null) => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        const errDetail = stderr.slice(0, 500).trim();
        reject(new Error(`Python script produced no output (exit=${code}): ${errDetail || 'timed out or crashed'}`));
        return;
      }
      if (code === 0 || code === null) {
        try {
          const result = JSON.parse(trimmed);
          resolve(result as T);
        } catch {
          reject(new Error(`Failed to parse Python output: ${trimmed.slice(0, 500)}`));
        }
      } else {
        reject(new Error(`Python script exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    child.stdin.write(inputStr);
    child.stdin.end();
  });
}

/**
 * Check if Python is available on the system.
 */
export async function checkPythonAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const python = findPython();
    const child = spawn(python, ['--version'], { timeout: 5000 });
    
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Get the output directory path.
 */
export function getOutputDir(subdir?: string): string {
  if (subdir) {
    const dir = path.join(OUTPUT_DIR, subdir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  return OUTPUT_DIR;
}

/**
 * Check if a file exists and return its info.
 */
export function getFileInfo(filePath: string): { exists: boolean; size: number; modifiedAt: string } | null {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * List all generated assets in a directory.
 */
export function listAssets(subdir: string): string[] {
  const dir = path.join(OUTPUT_DIR, subdir);
  try {
    return fs.readdirSync(dir).map(f => path.join(dir, f));
  } catch {
    return [];
  }
}
