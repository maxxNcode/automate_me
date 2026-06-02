/**
 * Gemini Bridge — in-memory per-workflow job queue for the Gemini content script.
 *
 * State is keyed by workflowId. The bridge is a long-poll target: the
 * extension content script GETs /poll every 2s to ask "what's next?" and
 * POSTs /result with image bytes when a scene is generated.
 */

export type BridgeStatus = 'absent' | 'ready' | 'active' | 'complete' | 'failed';

export interface BridgeJob {
  workflowId: string;
  sceneIndex: number;
  prompt: string;
  promptSlug: string;
  timeoutMs: number;
}

export interface BridgePollResponse {
  job?: BridgeJob;
  status: 'running' | 'complete';
  reason?: string;
}

interface WorkflowBridgeState {
  jobs: BridgeJob[];
  jobCursor: number;          // index of next job to deliver
  results: Map<number, { buffer: Buffer; attempts: number; receivedAt: number }>;
  status: Exclude<BridgeStatus, 'absent'>;
  expectedCount: number;
  retryCounters: Map<number, number>;
  completionResolvers: Array<{ resolve: (images: Map<number, Buffer>) => void; reject: (err: Error) => void }>;
  failureResolvers: Array<(err: Error) => void>;
}

export class BridgeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeTimeoutError';
  }
}

export class BridgeSceneRetryExceededError extends Error {
  constructor(public sceneIndex: number) {
    super(`Scene ${sceneIndex} exceeded retry budget`);
    this.name = 'BridgeSceneRetryExceededError';
  }
}

function slugify(text: string): string {
  return text
    .substring(0, 30)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export class GeminiBridge {
  private workflows = new Map<string, WorkflowBridgeState>();
  private lastPing: { ready: boolean; reason?: string; at: number } | null = null;
  private readonly PING_LIVENESS_MS = 30_000;
  private readonly MAX_SCENE_RETRIES = 3;

  enqueuePrompts(workflowId: string, prompts: Array<{ sceneIndex: number; prompt: string }>): void {
    const jobs: BridgeJob[] = prompts.map(p => ({
      workflowId,
      sceneIndex: p.sceneIndex,
      prompt: p.prompt,
      promptSlug: slugify(p.prompt),
      timeoutMs: 60_000,
    }));

    const existing = this.workflows.get(workflowId);
    if (existing) {
      // Idempotent re-enqueue: replace jobs, reset cursor and results
      existing.jobs = jobs;
      existing.jobCursor = 0;
      existing.results.clear();
      existing.status = 'ready';
      existing.retryCounters.clear();
      return;
    }

    this.workflows.set(workflowId, {
      jobs,
      jobCursor: 0,
      results: new Map(),
      status: 'ready',
      expectedCount: jobs.length,
      retryCounters: new Map(),
      completionResolvers: [],
      failureResolvers: [],
    });
  }

  postResult(workflowId: string, sceneIndex: number, buffer: Buffer): void {
    const state = this.workflows.get(workflowId);
    if (!state) return;
    if (state.status === 'failed' || state.status === 'complete') return;
    state.results.set(sceneIndex, {
      buffer,
      attempts: (state.retryCounters.get(sceneIndex) ?? 0) + 1,
      receivedAt: Date.now(),
    });
    if (state.status === 'ready') state.status = 'active';

    if (state.results.size >= state.expectedCount) {
      state.status = 'complete';
      const images = new Map<number, Buffer>();
      state.results.forEach((v, k) => images.set(k, v.buffer));
      state.completionResolvers.forEach(c => c.resolve(images));
      state.completionResolvers = [];
    }
  }

  poll(workflowId: string): BridgePollResponse {
    if (workflowId === 'discover') {
      // Return the next job from any active workflow
      for (const [wfId, state] of this.workflows) {
        if (state.jobCursor < state.jobs.length && state.status !== 'failed') {
          const job = state.jobs[state.jobCursor++];
          state.status = 'active';
          return { job, status: 'running' };
        }
      }
      return { status: 'running' };
    }

    const state = this.workflows.get(workflowId);
    if (!state) {
      return { status: 'running', reason: 'unknown_workflow' };
    }

    if (state.status === 'failed') {
      return { status: 'complete', reason: 'failed' };
    }

    if (state.jobCursor < state.jobs.length) {
      const job = state.jobs[state.jobCursor++];
      state.status = 'active';
      return { job, status: 'running' };
    }

    if (state.status === 'complete') {
      return { status: 'complete' };
    }

    return { status: 'running' };
  }

  awaitImages(workflowId: string, expectedCount: number, timeoutMs: number): Promise<Map<number, Buffer>> {
    return new Promise((resolve, reject) => {
      const state = this.workflows.get(workflowId);
      if (!state) {
        reject(new BridgeTimeoutError(`No bridge state for workflow ${workflowId}`));
        return;
      }
      state.expectedCount = expectedCount;

      if (state.results.size >= expectedCount) {
        const images = new Map<number, Buffer>();
        state.results.forEach((v, k) => images.set(k, v.buffer));
        resolve(images);
        return;
      }

      const timer = setTimeout(() => {
        const idx = state.completionResolvers.findIndex(c => c.resolve === resolve);
        if (idx >= 0) state.completionResolvers.splice(idx, 1);
        reject(new BridgeTimeoutError(`Timed out waiting for ${expectedCount} images for ${workflowId}`));
      }, timeoutMs);

      state.completionResolvers.push({
        resolve: (images) => {
          clearTimeout(timer);
          resolve(images);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  recordPing(ready: boolean, reason?: string): void {
    this.lastPing = { ready, reason, at: Date.now() };
  }

  getReadiness(): { ready: boolean; reason?: string } {
    if (!this.lastPing) return { ready: false, reason: 'no_extension' };
    const age = Date.now() - this.lastPing.at;
    if (age > this.PING_LIVENESS_MS) return { ready: false, reason: 'no_extension' };
    return { ready: this.lastPing.ready, reason: this.lastPing.reason };
  }

  recordSceneFailure(workflowId: string, sceneIndex: number): void {
    const state = this.workflows.get(workflowId);
    if (!state) return;
    if (state.status === 'failed' || state.status === 'complete') return;
    const current = state.retryCounters.get(sceneIndex) ?? 0;
    state.retryCounters.set(sceneIndex, current + 1);
    if (current + 1 >= this.MAX_SCENE_RETRIES) {
      state.status = 'failed';
      const err = new BridgeSceneRetryExceededError(sceneIndex);
      state.failureResolvers.forEach(r => r(err));
      state.failureResolvers = [];
      state.completionResolvers.forEach(c => c.reject(err));
      state.completionResolvers = [];
    }
  }

  cleanup(workflowId: string): void {
    const state = this.workflows.get(workflowId);
    if (!state) return;
    const err = new BridgeTimeoutError(`Workflow ${workflowId} cleaned up before completion`);
    state.completionResolvers.forEach(c => c.reject(err));
    state.completionResolvers = [];
    state.failureResolvers.forEach(r => r(err));
    state.failureResolvers = [];
    this.workflows.delete(workflowId);
  }

  getStatus(workflowId: string): BridgeStatus {
    const state = this.workflows.get(workflowId);
    return state ? state.status : 'absent';
  }

  getProgress(workflowId: string): { received: number; total: number } | null {
    const state = this.workflows.get(workflowId);
    if (!state) return null;
    return { received: state.results.size, total: state.expectedCount };
  }
}
