// ========================================
// Workflow & Pipeline Types
// ========================================

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
  filePath?: string;
  fileUrl?: string;
  uploadedAt?: string;
}

export interface ManualMediaInfo {
  sceneIndex: number;
  sceneText: string;
  imagePrompt: string;
  mediaStatus: 'missing' | 'uploaded';
  mediaType?: 'image' | 'video';
  mediaFilePath?: string;
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
  full_story?: string;
  stickman_master_json?: string;
  fallback?: boolean;
  model_used?: string;
  tone?: string;
  duration_minutes?: number;
  gemini_master_json?: string;
  gemini_scenes_dir?: string;
  scene_images?: SceneImageInfo[];
  footage_source?: 'sidecar' | 'youtube_clips' | 'gemini_story' | 'stickman_story' | 'manual_story';
  voice?: string;
  manual_mode?: boolean;
  aspect_ratio?: '9:16' | '16:9';
  manual_media?: ManualMediaInfo[];
  base_prompt?: string;
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
  use_ssml?: boolean;
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
  /** Legacy: 'stickman_story' is handled as alias for 'gemini_story' */
  footage_source?: 'sidecar' | 'youtube_clips' | 'gemini_story' | 'stickman_story' | 'manual_story';
  /** Crop position for landscape→portrait fitting: 'fit' (black bars), 'center', 'left', 'right' */
  crop_position?: 'fit' | 'center' | 'top' | 'bottom' | 'left' | 'right';
  /** Manual mode: user uploads media per scene */
  manual_mode?: boolean;
  /** Aspect ratio for manual mode */
  aspect_ratio?: '9:16' | '16:9';
  /** Target number of scenes for story-based pipelines (gemini_story / manual_story) */
  story_scene_count?: number;
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
  type: 'step_update' | 'workflow_complete' | 'workflow_error' | 'log' | 'script_ready' | 'bridge_status' | 'images_ready' | 'media_ready' | 'voiceover_pending' | 'voiceover_ready';
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
