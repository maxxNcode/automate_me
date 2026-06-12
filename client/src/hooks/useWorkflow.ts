import { useState, useCallback, useEffect } from 'react';
import type { WorkflowState, WsEvent, StepStatus, WorkflowStep } from '../types';
import { workflowApi } from '../api/workflow';
import { useWebSocket } from './useWebSocket';

export interface WorkflowLog {
  timestamp: string;
  message: string;
  level: 'info' | 'warn' | 'error';
}

export function useWorkflows() {
  const [workflows, setWorkflows] = useState<WorkflowState[]>([]);
  const [workflowLogs, setWorkflowLogs] = useState<Record<string, WorkflowLog[]>>({});
  const [loading, setLoading] = useState(true);
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(null);

  // Fetch all workflows from the server
  const fetchWorkflows = useCallback(async () => {
    try {
      const data = await workflowApi.listWorkflows();
      setWorkflows(data);
    } catch {
      // engine offline - expected until started
    } finally {
      setLoading(false);
    }
  }, []);

  // Handle WebSocket events for real-time updates
  const handleWsEvent = useCallback((event: WsEvent) => {
    // Store log events
    if (event.type === 'log' && event.message) {
      const msg = event.message;
      const lvl = event.level || 'info';
      setWorkflowLogs(prev => {
        const logs = prev[event.workflowId] || [];
        return {
          ...prev,
          [event.workflowId]: [...logs, { timestamp: event.timestamp, message: msg, level: lvl }].slice(-200),
        };
      });
    }

    setWorkflows(prev => {
      const idx = prev.findIndex(w => w.id === event.workflowId);
      if (idx === -1) return prev;

      const updated = [...prev];
      const workflow = { ...updated[idx] };

      if (event.type === 'step_update' && event.step && event.status) {
        workflow.steps = {
          ...workflow.steps,
          [event.step]: {
            ...workflow.steps[event.step],
            status: event.status as StepStatus,
            startedAt: event.status === 'running' ? event.timestamp : workflow.steps[event.step].startedAt,
            completedAt: (event.status === 'completed' || event.status === 'failed') ? event.timestamp : undefined,
          },
        };
        workflow.currentStep = event.status === 'running' ? event.step as WorkflowStep : workflow.currentStep;
        workflow.progress = calculateProgress(workflow.steps);
        workflow.updatedAt = event.timestamp;
      }

      if (event.type === 'workflow_complete') {
        workflow.status = 'completed';
        workflow.progress = 100;
        workflow.updatedAt = event.timestamp;
      }

      if (event.type === 'workflow_error') {
        workflow.status = 'failed';
        workflow.updatedAt = event.timestamp;
      }

      if (event.type === 'script_ready') {
        workflow.status = 'awaiting_script_approval' as any;
        workflow.scenes = (event as any).scenes || [];
        workflow.fallback = !!(event as any).fallback;
        workflow.updatedAt = event.timestamp;
      }

      if (event.type === 'images_ready') {
        workflow.status = 'awaiting_images' as any;
        workflow.scene_images = (event as any).scene_images || [];
        workflow.updatedAt = event.timestamp;
      }

      if (event.type === 'voiceover_pending') {
        workflow.status = 'awaiting_voiceover' as any;
        workflow.updatedAt = event.timestamp;
      }

      if (event.type === 'voiceover_ready') {
        workflow.status = 'awaiting_media' as any;
        workflow.updatedAt = event.timestamp;
      }

      if (event.type === 'media_ready') {
        workflow.status = 'awaiting_media' as any;
        workflow.manual_media = (event as any).manual_media || [];
        workflow.aspect_ratio = (event as any).aspect_ratio || '9:16';
        workflow.base_prompt = (event as any).base_prompt || '';
        workflow.updatedAt = event.timestamp;
      }

      // When a step update arrives after awaiting_script_approval, awaiting_images, awaiting_voiceover, or awaiting_media, status should transition to running
      if (event.type === 'step_update' && (workflow.status === 'awaiting_script_approval' as any || workflow.status === 'awaiting_images' as any || workflow.status === 'awaiting_voiceover' as any || workflow.status === 'awaiting_media' as any) && event.status === 'running') {

        workflow.status = 'running';
        workflow.updatedAt = event.timestamp;
      }

      updated[idx] = workflow;
      return updated;
    });
  }, []);

  const { subscribe } = useWebSocket(handleWsEvent);

  // Fetch workflows on mount
  useEffect(() => {
    fetchWorkflows();
    const interval = setInterval(fetchWorkflows, 10000);
    return () => clearInterval(interval);
  }, [fetchWorkflows]);

  // Subscribe to active workflow updates
  useEffect(() => {
    if (activeWorkflowId) {
      subscribe(activeWorkflowId);
    }
  }, [activeWorkflowId, subscribe]);

  // Start a new workflow
  const startWorkflow = useCallback(async (topic: string, options?: Record<string, unknown>) => {
    try {
      const result = await workflowApi.startPipeline({
        topic,
        username: options?.username as string | undefined,
        tone: options?.tone as 'educational' | 'entertaining' | 'professional' | 'casual' || 'educational',
        duration_minutes: (options?.duration_minutes as number) || 5,
        thumbnail_style: options?.thumbnail_style as 'eye-catching' | 'minimalist' | 'educational' || 'eye-catching',
        add_subtitles: options?.add_subtitles !== false,
        auto_upload: options?.auto_upload === true,
        privacy_status: (options?.privacy_status as 'public' | 'private' | 'unlisted') || 'unlisted',
        style: options?.style as 'short' | 'tutorial' || 'short',
        caption_position: options?.caption_position as 'top' | 'center' | 'bottom' | undefined,
        caption_background_color: options?.caption_background_color as string | undefined,
        ai_model: options?.ai_model as string | undefined,
        manual_mode: options?.manual_mode as boolean | undefined,
        footage_source: options?.footage_source as 'sidecar' | 'youtube_clips' | 'gemini_story' | 'manual_story' | undefined,
        aspect_ratio: options?.aspect_ratio as '9:16' | '16:9' | undefined,
        story_scene_count: options?.story_scene_count as number | undefined,
      });

      setActiveWorkflowId(result.workflow_id);

      // Add to local state immediately
      const newWorkflow: WorkflowState = {
        id: result.workflow_id,
        topic,
        status: 'queued',
        progress: 0,
        currentStep: null,
        steps: {
          script_generation: { status: 'pending' },
          voiceover: { status: 'pending' },
          thumbnail: { status: 'pending' },
          video_assembly: { status: 'pending' },
          upload: { status: 'pending' },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      setWorkflows(prev => [newWorkflow, ...prev]);
      return result;
    } catch (err) {
      console.error('Failed to start workflow:', err);
      throw err;
    }
  }, [subscribe]);

  // Cancel a workflow
  const cancelWorkflow = useCallback(async (id: string) => {
    try {
      await workflowApi.cancelWorkflow(id);
      setWorkflows(prev =>
        prev.map(w => w.id === id ? { ...w, status: 'failed' as const, updatedAt: new Date().toISOString() } : w)
      );
    } catch (err) {
      console.error('Failed to cancel workflow:', err);
    }
  }, []);

  return {
    workflows,
    workflowLogs,
    loading,
    activeWorkflowId,
    startWorkflow,
    cancelWorkflow,
    refresh: fetchWorkflows,
  };
}

function calculateProgress(steps: Record<string, { status: string }>): number {
  const stepOrder = ['script_generation', 'voiceover', 'thumbnail', 'video_assembly', 'upload'];
  const weights = [25, 20, 15, 30, 10];
  let progress = 0;

  for (let i = 0; i < stepOrder.length; i++) {
    const step = steps[stepOrder[i]];
    if (step?.status === 'completed') progress += weights[i];
    else if (step?.status === 'running') progress += weights[i] * 0.5;
  }

  return Math.round(progress);
}
