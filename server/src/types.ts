// ========================================
// Workflow & Pipeline Types
// ========================================

export type WorkflowStep = 
  | 'script_generation'
  | 'voiceover'
  | 'thumbnail'
  | 'video_assembly'
  | 'upload';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkflowState {
  id: string;
  topic: string;
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'awaiting_script_approval';
  progress: number;
  currentStep: WorkflowStep | null;
  steps: Record<WorkflowStep, StepState>;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  scenes?: Array<{ text: string; searchTerms: string[] }>;
  fallback?: boolean;
  model_used?: string;
  tone?: string;
  duration_minutes?: number;
  footage_source?: 'sidecar' | 'youtube_clips';
  voice?: string;
  add_subtitles?: boolean;
  ai_model?: string;
  caption_position?: 'top' | 'center' | 'bottom';
  caption_background_color?: string;
}

export interface StepState {
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}

// ========================================
// Script Generation Types
// ========================================

export interface ScriptRequest {
  topic: string;
  tone?: 'educational' | 'entertaining' | 'professional' | 'casual';
  duration_minutes?: number;
  language?: string;
}

export interface ScriptResult {
  success: boolean;
  script: string;
  model: string;
  topic: string;
  tone: string;
  duration_minutes: number;
  word_count: number;
  fallback: boolean;
}

// ========================================
// Voiceover Types
// ========================================

export interface VoiceoverRequest {
  script: string;
  voice?: string;
  speed?: number;
}

export interface VoiceoverResult {
  success: boolean;
  file_path: string;
  filename: string;
  duration_seconds: number;
  segments: number;
  voice_model: string;
  fallback: boolean;
}

// ========================================
// Thumbnail Types
// ========================================

export interface ThumbnailRequest {
  topic: string;
  style?: 'eye-catching' | 'minimalist' | 'educational';
  custom_prompt?: string;
  count?: number;
}

export interface ThumbnailResult {
  success: boolean;
  file_path?: string;
  filename?: string;
  variations?: ThumbnailVariation[];
  prompt?: string;
  style?: string;
  dimensions?: string;
  fallback: boolean;
}

export interface ThumbnailVariation {
  success: boolean;
  file_path: string;
  filename: string;
  prompt: string;
}

// ========================================
// Video Assembly Types
// ========================================

export interface VideoRequest {
  script: string;
  audio_path: string;
  thumbnail_path?: string;
  background_images?: string[];
  add_subtitles?: boolean;
  title?: string;
  /** Scene-based assembly: clips with text overlays from YouTube footage */
  scenes?: { text: string; searchTerms: string[] }[];
  /** Scene assembly mode — 'standard' uses thumbnail/images, 'scene' uses per-clip video */
  assembly_mode?: 'standard' | 'scene';
  /** Pre-downloaded clip paths for scene assembly mode */
  clip_paths?: string[];
}

export interface VideoResult {
  success: boolean;
  file_path: string;
  filename: string;
  duration_seconds: number;
  file_size_bytes: number;
  resolution: string;
  fps: number;
  subtitles: boolean;
  fallback: boolean;
  error?: string;
}

// ========================================
// Upload Types
// ========================================

export interface UploadRequest {
  video_path: string;
  title: string;
  description?: string;
  tags?: string[];
  privacy_status?: 'public' | 'private' | 'unlisted';
  category_id?: string;
  thumbnail_path?: string;
}

export interface UploadResult {
  success: boolean;
  video_id?: string;
  url?: string;
  method?: string;
  title?: string;
  error?: string;
  fallback?: boolean;
  instructions?: string;
  video_path?: string;
  privacy_status?: string;
}

// ========================================
// Full Pipeline Types
// ========================================

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
  footage_source?: 'sidecar' | 'youtube_clips';
  /** Crop position for landscape→portrait fitting: 'fit' (black bars), 'center', 'left', 'right' */
  crop_position?: 'fit' | 'center' | 'top' | 'bottom' | 'left' | 'right';
}

export interface PipelineResult {
  workflow_id: string;
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
  results: Partial<Record<WorkflowStep, unknown>>;
  errors: Partial<Record<WorkflowStep, string>>;
  video_url?: string;
  video_path?: string;
}

// ========================================
// WebSocket Event Types
// ========================================

export interface WsEvent {
  type: 'step_update' | 'workflow_complete' | 'workflow_error' | 'log' | 'script_ready';
  workflowId: string;
  step?: WorkflowStep;
  status?: StepStatus;
  message?: string;
  level?: 'info' | 'warn' | 'error';
  data?: unknown;
  timestamp: string;
}

// ========================================
// Script Preview Types
// ========================================

export interface ScriptPreviewResult {
  success: boolean;
  scenes: Array<{ text: string; searchTerms: string[] }>;
  model: string;
  fallback: boolean;
  word_count: number;
  duration_seconds: number;
}

// ========================================
// API Response Types
// ========================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
