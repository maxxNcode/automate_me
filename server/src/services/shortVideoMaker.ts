/**
 * short-video-maker Sidecar Client
 * HTTP wrapper for the sidecar REST API (port 3123 by default).
 */

const SIDECAR_URL = process.env.SIDECAR_URL || 'http://localhost:3123';

export interface ShortVideoScene {
  text: string;
  searchTerms: string[];
}

export interface ShortVideoConfig {
  paddingBack?: number;
  music?: string;
  captionPosition?: 'top' | 'center' | 'bottom';
  captionBackgroundColor?: string;
  voice?: string;
  orientation?: 'portrait' | 'landscape';
  musicVolume?: 'low' | 'medium' | 'high' | 'muted';
}

interface CreateVideoResponse {
  videoId: string;
}

interface VideoStatusResponse {
  status: 'processing' | 'ready' | 'error';
}

interface VideoListItem {
  id: string;
  status: string;
}

interface HealthResponse {
  status: string;
}

export class ShortVideoMaker {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || SIDECAR_URL;
  }

  async createVideo(scenes: ShortVideoScene[], config?: ShortVideoConfig): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/short-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenes, config }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Sidecar create video failed (${res.status}): ${text}`);
    }

    const data: CreateVideoResponse = await res.json() as CreateVideoResponse;
    return data.videoId;
  }

  async getStatus(videoId: string): Promise<VideoStatusResponse['status']> {
    const res = await fetch(`${this.baseUrl}/api/short-video/${videoId}/status`, {
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error(`Sidecar status check failed (${res.status})`);
    }

    const data: VideoStatusResponse = await res.json() as VideoStatusResponse;
    return data.status;
  }

  async downloadVideo(videoId: string): Promise<ArrayBuffer> {
    const res = await fetch(`${this.baseUrl}/api/short-video/${videoId}`);

    if (!res.ok) {
      throw new Error(`Sidecar download failed (${res.status})`);
    }

    return res.arrayBuffer();
  }

  async listVideos(): Promise<VideoListItem[]> {
    const res = await fetch(`${this.baseUrl}/api/short-videos`);

    if (!res.ok) {
      throw new Error(`Sidecar list failed (${res.status})`);
    }

    const data: { videos: VideoListItem[] } = await res.json() as { videos: VideoListItem[] };
    return data.videos;
  }

  async deleteVideo(videoId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/short-video/${videoId}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      throw new Error(`Sidecar delete failed (${res.status})`);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return false;
      const data: HealthResponse = await res.json() as HealthResponse;
      return data.status === 'ok';
    } catch {
      return false;
    }
  }
}
