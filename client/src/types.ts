export type WorkflowStep =
  | 'script_generation'
  | 'voiceover'
  | 'thumbnail'
  | 'video_assembly'
  | 'upload';

export interface SceneImageInfo {
  sceneIndex: number;
  text: string;
  status: 'generated' | 'manual_upload' | 'missing';
  fileUrl?: string;
  uploadedAt?: string;
}

export interface ManualMediaInfo {
  sceneIndex: number;
  sceneText: string;
  imagePrompt: string;
  mediaStatus: 'missing' | 'uploaded';
  mediaType?: 'image' | 'video';
  mediaFileUrl?: string;
  uploadedAt?: string;
}

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkflowState {
  id: string;
  topic: string;
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'awaiting_script_approval' | 'awaiting_images' | 'awaiting_media' | 'awaiting_voiceover';
  progress: number;
  currentStep: WorkflowStep | null;
  steps: Record<WorkflowStep, StepState>;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  scenes?: Array<{ text: string; searchTerms: string[] }>;
  scene_images?: SceneImageInfo[];
  fallback?: boolean;
  manual_mode?: boolean;
  aspect_ratio?: '9:16' | '16:9';
  manual_media?: ManualMediaInfo[];
  base_prompt?: string;
}

export interface StepState {
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}

export type VideoStyle = 'short' | 'tutorial';

export interface PipelineRequest {
  topic: string;
  username?: string;
  tone?: 'educational' | 'entertaining' | 'professional' | 'casual';
  duration_minutes?: number;
  voice?: string;
  thumbnail_style?: 'eye-catching' | 'minimalist' | 'educational';
  add_subtitles?: boolean;
  privacy_status?: 'public' | 'private' | 'unlisted';
  auto_upload?: boolean;
  style?: VideoStyle;
  /** Preferred AI model key ("provider::modelId" or "auto" for smart cycling) */
  ai_model?: string;
  /** Caption vertical position in short videos */
  caption_position?: 'top' | 'center' | 'bottom';
  /** Caption background color (CSS color string) */
  caption_background_color?: string;
  /** Footage source for short videos */
  footage_source?: 'sidecar' | 'youtube_clips' | 'gemini_story' | 'manual_story';
  /** Crop position for landscape→portrait fitting: 'fit' (black bars), 'center', 'left', 'right' */
  crop_position?: 'fit' | 'center' | 'top' | 'bottom' | 'left' | 'right';
  /** Manual mode: user uploads media per scene */
  manual_mode?: boolean;
  /** Aspect ratio for manual mode */
  aspect_ratio?: '9:16' | '16:9';
  /** Target number of scenes for story-based pipelines (gemini_story / manual_story) */
  story_scene_count?: number;
}

export interface AiModelInfo {
  key: string;
  provider: 'groq' | 'openrouter';
  modelId: string;
  displayName: string;
  configured: boolean;
  failed: boolean;
}

export interface PipelineResult {
  workflow_id: string;
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
  results: Partial<Record<WorkflowStep, unknown>>;
  errors: Partial<Record<WorkflowStep, string>>;
  video_url?: string;
  video_path?: string;
}

export interface AiProviderInfo {
  configured: boolean;
  available: boolean;
  models: string[];
}

export interface SystemStatus {
  python: { available: boolean; scripts: number };
  ffmpeg: { available: boolean };
  git: { available: boolean };
  shortVideoMaker: { available: boolean; status: string };
  output: { path: string; exists: boolean; size_mb: number };
  aiProviders?: {
    groq: AiProviderInfo;
    openrouter: AiProviderInfo;
  };
  tools: Record<string, { status: string }>;
}

export interface WsEvent {
  type: 'step_update' | 'workflow_complete' | 'workflow_error' | 'log' | 'script_ready' | 'bridge_status' | 'images_ready' | 'media_ready' | 'voiceover_pending' | 'voiceover_ready';
  workflowId: string;
  step?: WorkflowStep;
  status?: StepStatus;
  message?: string;
  level?: 'info' | 'warn' | 'error';
  data?: unknown;
  timestamp: string;
}

export interface ScriptPreviewResult {
  success: boolean;
  scenes: Array<{ text: string; searchTerms: string[] }>;
  model: string;
  fallback: boolean;
  word_count: number;
  duration_seconds: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export const STEP_LABELS: Record<WorkflowStep, string> = {
  script_generation: 'Script Generation',
  voiceover: 'Voiceover',
  thumbnail: 'Thumbnail',
  video_assembly: 'Video Assembly',
  upload: 'Upload',
};

export const STEP_LETTERS: Record<WorkflowStep, string> = {
  script_generation: 'S',
  voiceover: 'V',
  thumbnail: 'T',
  video_assembly: 'A',
  upload: 'U',
};

export const STEP_ORDER: WorkflowStep[] = [
  'script_generation',
  'voiceover',
  'thumbnail',
  'video_assembly',
  'upload',
];
