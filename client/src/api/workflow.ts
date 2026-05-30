import type { ApiResponse, PipelineRequest, PipelineResult, WorkflowState, SystemStatus, AiModelInfo } from '../types';

const BASE_URL = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const data: ApiResponse<T> = await res.json();

  if (!data.success) {
    throw new Error(data.error || 'Request failed');
  }

  return data.data as T;
}

export const workflowApi = {
  /** Start a full pipeline workflow */
  startPipeline(req: PipelineRequest): Promise<PipelineResult> {
    return request<PipelineResult>('/workflow/start', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  },

  /** Get a specific workflow by ID */
  getWorkflow(id: string): Promise<WorkflowState> {
    return request<WorkflowState>(`/workflow/${id}`);
  },

  /** List all workflows */
  listWorkflows(): Promise<WorkflowState[]> {
    return request<WorkflowState[]>('/workflow');
  },

  /** Cancel a running workflow */
  cancelWorkflow(id: string): Promise<void> {
    return request<void>(`/workflow/${id}/cancel`, { method: 'POST' });
  },

  /** Generate a script only */
  generateScript(topic: string, tone?: string, duration?: number): Promise<PipelineResult> {
    return request<PipelineResult>('/workflow/script', {
      method: 'POST',
      body: JSON.stringify({ topic, tone, duration_minutes: duration }),
    });
  },

  /** Approve a generated script and continue the pipeline */
  approveScript(workflowId: string, scenes?: Array<{ text: string; searchTerms: string[] }>): Promise<ApiResponse> {
    return request<ApiResponse>(`/workflow/${workflowId}/approve-script`, {
      method: 'POST',
      body: JSON.stringify({ scenes }),
    });
  },

  /** Re-generate script for a workflow awaiting approval */
  regenerateScript(workflowId: string): Promise<ApiResponse> {
    return request<ApiResponse>(`/workflow/${workflowId}/re-generate-script`, {
      method: 'POST',
    });
  },

  /** Delete a workflow record (admin only — requires access key) */
  deleteWorkflow(id: string, accessKey?: string): Promise<void> {
    return request<void>(`/workflow/${id}`, {
      method: 'DELETE',
      headers: accessKey ? { 'x-access-key': accessKey } : undefined,
    });
  },
};

export const systemApi = {
  /** Get available AI models */
  getModels(): Promise<AiModelInfo[]> {
    return request<AiModelInfo[]>('/system/models');
  },
  /** Get system health */
  getHealth(): Promise<{ status: string; uptime: number }> {
    return request('/system/health');
  },

  /** Get system status (tools availability) */
  getStatus(): Promise<SystemStatus> {
    return request<SystemStatus>('/system/status');
  },

  /** Get system config */
  getConfig(): Promise<Record<string, unknown>> {
    return request('/system/config');
  },
};
