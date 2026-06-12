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

  /** Get scene image info for a workflow at awaiting_images state */
  getSceneImages(workflowId: string): Promise<Array<{ sceneIndex: number; text: string; status: string; fileUrl?: string }>> {
    return request<Array<{ sceneIndex: number; text: string; status: string; fileUrl?: string }>>(`/workflow/${workflowId}/scenes`);
  },

  /** Upload a manual image for a specific scene */
  uploadSceneImage(workflowId: string, sceneIndex: number, file: File): Promise<ApiResponse> {
    const formData = new FormData();
    formData.append('image', file);
    return fetch(`/api/workflow/${workflowId}/scenes/${sceneIndex}/upload`, {
      method: 'POST',
      body: formData,
    }).then(r => r.json());
  },

  /** Continue a paused workflow from awaiting_images to video assembly */
  continueToVideo(workflowId: string): Promise<ApiResponse> {
    return request<ApiResponse>(`/workflow/${workflowId}/continue-to-video`, {
      method: 'POST',
    });
  },

  /** Upload a media file (image or video) for a specific scene in manual mode */
  uploadMedia(workflowId: string, sceneIndex: number, file: File): Promise<ApiResponse> {
    const formData = new FormData();
    formData.append('media', file);
    formData.append('sceneIndex', String(sceneIndex));
    return fetch(`/api/workflow/${workflowId}/upload-media`, {
      method: 'POST',
      body: formData,
    }).then(r => r.json());
  },

  /** Assemble the final video from uploaded media in manual mode */
  assemble(workflowId: string): Promise<ApiResponse> {
    return request<ApiResponse>(`/workflow/${workflowId}/assemble`, {
      method: 'POST',
    });
  },

  /** Upload a voiceover recording for a workflow awaiting voiceover */
  uploadVoiceover(workflowId: string, file: File): Promise<ApiResponse> {
    const formData = new FormData();
    formData.append('audio', file);
    return fetch(`/api/workflow/${workflowId}/upload-voiceover`, {
      method: 'POST',
      body: formData,
    }).then(r => r.json());
  },

  /** Generate voiceover using AI TTS for a workflow awaiting voiceover */
  generateVoiceover(workflowId: string, engine?: 'kokoro' | 'edge-tts', voice?: string): Promise<ApiResponse> {
    return request<ApiResponse>(`/workflow/${workflowId}/generate-voiceover`, {
      method: 'POST',
      body: JSON.stringify({ engine: engine || 'edge-tts', voice }),
    });
  },

  /** Preview a Kokoro voice — returns a URL to the cached preview WAV (instant playback) */
  previewVoice(voice: string): Promise<{ url: string; voice: string; mimeType: string }> {
    return request<{ url: string; voice: string; mimeType: string }>('/workflow/preview-voice', {
      method: 'POST',
      body: JSON.stringify({ voice }),
    });
  },

  /** Re-render a completed/failed workflow's video with a different aspect ratio */
  reRenderWorkflow(workflowId: string, aspectRatio: '9:16' | '16:9'): Promise<ApiResponse> {
    return request<ApiResponse>(`/workflow/${workflowId}/re-render`, {
      method: 'POST',
      body: JSON.stringify({ aspect_ratio: aspectRatio }),
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
