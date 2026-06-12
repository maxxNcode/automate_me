import {
  WorkflowState,
  WorkflowStep,
  StepStatus,
  WsEvent,
} from '../types';

/**
 * Shared context passed to extracted workflow service classes.
 * Provides access to the orchestrator's core state and event methods.
 */
export interface OrchestratorContext {
  workflows: Map<string, WorkflowState>;
  db: {
    updateWorkflow(wf: WorkflowState): void;
    getWorkflow(id: string): WorkflowState | undefined;
    insertLogs(workflowId: string, logs: unknown[]): void;
    close(): void;
  };
  emitEvent(workflowId: string, type: WsEvent['type'], data: Record<string, unknown>): void;
  updateStep(workflowId: string, step: WorkflowStep, status: StepStatus, result?: unknown): void;
  handleError(workflowId: string, source: string, error: string): void;
  completeWorkflow(workflowId: string, results: Partial<Record<WorkflowStep, unknown>>, videoPath?: string): void;
  generateFilename(topic: string, username: string | undefined, workflowId: string, ext?: string): string;
  emitBridgeStatus(workflowId: string, status: string, message: string, progress?: number): void;
}
