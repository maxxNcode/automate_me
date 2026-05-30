/**
 * SQLite Database Service
 * Persistent storage for workflows and logs using better-sqlite3.
 * File is stored at project root /data/youtube-auto.db
 * Created when the server first starts.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { WorkflowState, WorkflowStep, StepState, WsEvent } from '../types';

const DATA_DIR = path.resolve(__dirname, '..', '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'youtube-auto.db');

interface LogRow {
  id: number;
  workflow_id: string;
  timestamp: string;
  message: string;
  level: 'info' | 'warn' | 'error';
}

export class WorkflowDatabase {
  private db: Database.Database;

  constructor() {
    // Ensure data directory exists
    fs.mkdirSync(DATA_DIR, { recursive: true });

    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');   // Better concurrent read performance
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id          TEXT PRIMARY KEY,
        topic       TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'idle',
        progress    INTEGER NOT NULL DEFAULT 0,
        current_step TEXT,
        steps_json  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        timestamp   TEXT NOT NULL,
        message     TEXT NOT NULL,
        level       TEXT NOT NULL DEFAULT 'info',
        FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS access_keys (
        key         TEXT PRIMARY KEY,
        label       TEXT NOT NULL DEFAULT '',
        role        TEXT NOT NULL DEFAULT 'user',
        created_at  TEXT NOT NULL,
        used_by     TEXT,
        used_at     TEXT
      );

      CREATE TABLE IF NOT EXISTS users (
        username    TEXT PRIMARY KEY,
        access_key  TEXT NOT NULL,
        is_admin    INTEGER NOT NULL DEFAULT 0,
        last_seen   TEXT,
        created_at  TEXT NOT NULL,
        FOREIGN KEY (access_key) REFERENCES access_keys(key) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_logs_workflow_id ON workflow_logs(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
      CREATE INDEX IF NOT EXISTS idx_workflows_created ON workflows(created_at);
    `);

    // Migration: add is_admin column if missing (for existing databases)
    // Safe to run every startup — no-op if column already exists
    try {
      this.db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Column already exists — ignore
    }

    // Migration: add role column to access_keys if missing
    try {
      this.db.exec('ALTER TABLE access_keys ADD COLUMN role TEXT NOT NULL DEFAULT \'user\'');
    } catch {
      // Column already exists — ignore
    }

    // Migration: upgrade old admin-first-key label to admin role
    // (handles the transition from pre-role to role-based system)
    try {
      this.db.exec("UPDATE access_keys SET role = 'admin' WHERE label = 'admin-first-key'");
    } catch {
      // ignore
    }

    // Migration: add created_by column to workflows if missing
    try {
      this.db.exec('ALTER TABLE workflows ADD COLUMN created_by TEXT');
    } catch {
      // Column already exists — ignore
    }

    // Migration: add data_json column to workflows (for scenes, fallback, etc.)
    try {
      this.db.exec('ALTER TABLE workflows ADD COLUMN data_json TEXT');
    } catch {
      // Column already exists — ignore
    }
  }

  // ========================================
  // Workflows
  // ========================================

  /** Insert a new workflow */
  insertWorkflow(workflow: WorkflowState): void {
    const stmt = this.db.prepare(`
      INSERT INTO workflows (id, topic, status, progress, current_step, steps_json, created_by, created_at, updated_at, data_json)
      VALUES (@id, @topic, @status, @progress, @current_step, @steps_json, @created_by, @created_at, @updated_at, @data_json)
    `);
    stmt.run({
      id: workflow.id,
      topic: workflow.topic,
      status: workflow.status,
      progress: workflow.progress,
      current_step: workflow.currentStep,
      steps_json: JSON.stringify(workflow.steps),
      created_by: workflow.createdBy || null,
      created_at: workflow.createdAt,
      updated_at: workflow.updatedAt,
      data_json: JSON.stringify({
        scenes: workflow.scenes,
        fallback: workflow.fallback,
        model_used: workflow.model_used,
        tone: workflow.tone,
        duration_minutes: workflow.duration_minutes,
        footage_source: workflow.footage_source,
        voice: workflow.voice,
        add_subtitles: workflow.add_subtitles,
        ai_model: workflow.ai_model,
      }),
    });
  }

  /** Update an existing workflow's mutable fields */
  updateWorkflow(workflow: WorkflowState): void {
    const stmt = this.db.prepare(`
      UPDATE workflows SET
        status = @status,
        progress = @progress,
        current_step = @current_step,
        steps_json = @steps_json,
        data_json = @data_json,
        updated_at = @updated_at
      WHERE id = @id
    `);
    stmt.run({
      id: workflow.id,
      status: workflow.status,
      progress: workflow.progress,
      current_step: workflow.currentStep,
      steps_json: JSON.stringify(workflow.steps),
      updated_at: workflow.updatedAt,
      data_json: JSON.stringify({
        scenes: workflow.scenes,
        fallback: workflow.fallback,
        model_used: workflow.model_used,
        tone: workflow.tone,
        duration_minutes: workflow.duration_minutes,
        footage_source: workflow.footage_source,
        voice: workflow.voice,
        add_subtitles: workflow.add_subtitles,
        ai_model: workflow.ai_model,
      }),
    });
  }

  /** Get a single workflow by ID */
  getWorkflow(id: string): WorkflowState | null {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToWorkflow(row);
  }

  /** Get all workflows, most recent first */
  getAllWorkflows(): WorkflowState[] {
    const rows = this.db.prepare('SELECT * FROM workflows ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map(r => this.rowToWorkflow(r));
  }

  /** Delete a workflow and its logs (CASCADE handles logs) */
  deleteWorkflow(id: string): boolean {
    const result = this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** Delete old workflows beyond a limit */
  pruneWorkflows(keepCount: number): number {
    // Get IDs to delete (all except the most recent N)
    const rows = this.db.prepare('SELECT id FROM workflows ORDER BY created_at DESC LIMIT -1 OFFSET ?').all(keepCount) as { id: string }[];
    if (rows.length === 0) return 0;

    const ids = rows.map(r => r.id);
    const deleteStmt = this.db.prepare('DELETE FROM workflows WHERE id = ?');
    const deleteMany = this.db.transaction((idsToDelete: string[]) => {
      for (const id of idsToDelete) {
        deleteStmt.run(id);
      }
    });
    deleteMany(ids);
    return ids.length;
  }

  // ========================================
  // Workflow Logs
  // ========================================

  /** Insert a single log entry */
  insertLog(workflowId: string, log: { timestamp: string; message: string; level: string }): void {
    const stmt = this.db.prepare(`
      INSERT INTO workflow_logs (workflow_id, timestamp, message, level)
      VALUES (@workflow_id, @timestamp, @message, @level)
    `);
    stmt.run({
      workflow_id: workflowId,
      timestamp: log.timestamp,
      message: log.message,
      level: log.level,
    });
  }

  /** Insert multiple log entries in a transaction (batched) */
  insertLogs(workflowId: string, logs: { timestamp: string; message: string; level: string }[]): void {
    if (logs.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO workflow_logs (workflow_id, timestamp, message, level)
      VALUES (@workflow_id, @timestamp, @message, @level)
    `);

    const batchInsert = this.db.transaction((entries: { timestamp: string; message: string; level: string }[]) => {
      for (const entry of entries) {
        stmt.run({
          workflow_id: workflowId,
          timestamp: entry.timestamp,
          message: entry.message,
          level: entry.level,
        });
      }
    });

    batchInsert(logs);
  }

  /** Get logs for a workflow, oldest first */
  getLogs(workflowId: string, limit = 500): LogRow[] {
    return this.db.prepare(
      'SELECT * FROM workflow_logs WHERE workflow_id = ? ORDER BY id ASC LIMIT ?'
    ).all(workflowId, limit) as LogRow[];
  }

  /** Delete logs for a workflow */
  deleteLogs(workflowId: string): void {
    this.db.prepare('DELETE FROM workflow_logs WHERE workflow_id = ?').run(workflowId);
  }

  /** Count log entries for a workflow */
  countLogs(workflowId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM workflow_logs WHERE workflow_id = ?').get(workflowId) as { count: number };
    return row.count;
  }

  /** Prune logs beyond a cap per workflow */
  pruneLogs(maxPerWorkflow = 1000): number {
    // For each workflow, keep only the last N logs
    const workflows = this.db.prepare('SELECT id FROM workflows').all() as { id: string }[];
    let totalDeleted = 0;

    for (const wf of workflows) {
      const row = this.db.prepare('SELECT COUNT(*) as count FROM workflow_logs WHERE workflow_id = ?').get(wf.id) as { count: number };
      if (row.count > maxPerWorkflow) {
        // Find the ID of the Nth log, delete all before it
        const targetRow = this.db.prepare(
          'SELECT id FROM workflow_logs WHERE workflow_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?'
        ).get(wf.id, maxPerWorkflow - 1) as { id: number } | undefined;

        if (targetRow) {
          const result = this.db.prepare(
            'DELETE FROM workflow_logs WHERE workflow_id = ? AND id <= ?'
          ).run(wf.id, targetRow.id);
          totalDeleted += result.changes;
        }
      }
    }

    return totalDeleted;
  }

  // ========================================
  // Access Keys & Users
  // ========================================

  /** Check if any access keys exist */
  hasAccessKeys(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM access_keys').get() as { count: number };
    return row.count > 0;
  }

  /** Seed initial keys on first startup: one admin key + one user key */
  seedFirstKeys(): { admin: string; user: string } | null {
    if (this.hasAccessKeys()) return null;
    const adminKey = this.createAccessKey('admin', 'admin');
    const userKey = this.createAccessKey('user', 'user');
    return { admin: adminKey, user: userKey };
  }

  /** Generate a new access key (returns the key string) */
  createAccessKey(label?: string, role: 'admin' | 'user' = 'user'): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let key = '';
    for (let i = 0; i < 12; i++) {
      if (i > 0 && i % 4 === 0) key += '-';
      key += chars[Math.floor(Math.random() * chars.length)];
    }
    const stmt = this.db.prepare(`
      INSERT INTO access_keys (key, label, role, created_at)
      VALUES (@key, @label, @role, @created_at)
    `);
    stmt.run({ key, label: label || '', role, created_at: new Date().toISOString() });
    return key;
  }

  /** List all access keys */
  listAccessKeys(): { key: string; label: string; role: string; created_at: string; used_by: string | null; used_at: string | null }[] {
    return this.db.prepare('SELECT * FROM access_keys ORDER BY created_at DESC').all() as any[];
  }

  /** Validate an access key and return it with role info */
  validateAccessKey(key: string): { key: string; role: string; used_by: string | null } | null {
    const row = this.db.prepare('SELECT key, role, used_by FROM access_keys WHERE key = ?').get(key) as any | undefined;
    return row || null;
  }

  /** Register a user with an access key */
  registerUser(username: string, accessKey: string, isAdmin: boolean): boolean {
    try {
      this.db.prepare(`
        INSERT INTO users (username, access_key, is_admin, created_at)
        VALUES (@username, @access_key, @is_admin, @created_at)
      `).run({ username, access_key: accessKey, is_admin: isAdmin ? 1 : 0, created_at: new Date().toISOString() });
      // Mark key as used
      this.db.prepare('UPDATE access_keys SET used_by = @username, used_at = @used_at WHERE key = @key AND used_by IS NULL')
        .run({ username, key: accessKey, used_at: new Date().toISOString() });
      return true;
    } catch {
      return false; // Username taken or insert failed
    }
  }

  /** Get user by username */
  getUser(username: string): { username: string; access_key: string; is_admin: number; last_seen: string | null; created_at: string } | null {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any | undefined;
    return row || null;
  }

  /** Get count of registered users */
  userCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    return row.count;
  }

  /** Update user's last_seen timestamp */
  touchUser(username: string): void {
    this.db.prepare('UPDATE users SET last_seen = @last_seen WHERE username = @username')
      .run({ username, last_seen: new Date().toISOString() });
  }

  /** List all registered users */
  listUsers(): { username: string; access_key: string; is_admin: number; last_seen: string | null; created_at: string }[] {
    return this.db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as any[];
  }

  /** Delete an access key */
  deleteAccessKey(key: string): boolean {
    // Delete users associated with this key first
    this.db.prepare('DELETE FROM users WHERE access_key = ?').run(key);
    const result = this.db.prepare('DELETE FROM access_keys WHERE key = ?').run(key);
    return result.changes > 0;
  }

  // ========================================
  // Maintenance
  // ========================================

  /** VACUUM to reclaim space (run occasionally) */
  vacuum(): void {
    this.db.exec('VACUUM');
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }

  // ========================================
  // Helpers
  // ========================================

  private rowToWorkflow(row: Record<string, unknown>): WorkflowState {
    let extra: Record<string, unknown> = {};
    try {
      if (row.data_json) {
        extra = JSON.parse(row.data_json as string) as Record<string, unknown>;
      }
    } catch {
      // Invalid JSON — ignore
    }

    return {
      id: row.id as string,
      topic: row.topic as string,
      status: row.status as WorkflowState['status'],
      progress: row.progress as number,
      currentStep: row.current_step as WorkflowStep | null,
      steps: JSON.parse(row.steps_json as string) as Record<WorkflowStep, StepState>,
      createdBy: (row.created_by as string) || undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      scenes: extra.scenes as Array<{ text: string; searchTerms: string[] }> | undefined,
      fallback: extra.fallback as boolean | undefined,
      model_used: extra.model_used as string | undefined,
      tone: extra.tone as string | undefined,
      duration_minutes: extra.duration_minutes as number | undefined,
      footage_source: extra.footage_source as 'sidecar' | 'youtube_clips' | undefined,
      voice: extra.voice as string | undefined,
      add_subtitles: extra.add_subtitles as boolean | undefined,
      ai_model: extra.ai_model as string | undefined,
    };
  }
}

/** Singleton instance */
let _instance: WorkflowDatabase | null = null;

export function getDatabase(): WorkflowDatabase {
  if (!_instance) {
    _instance = new WorkflowDatabase();
  }
  return _instance;
}
