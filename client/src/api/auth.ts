import type { ApiResponse } from '../types';

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

export interface AuthUser {
  username: string;
  accessKey: string;
  isAdmin?: boolean;
}

export interface AccessKey {
  key: string;
  label: string;
  role: string;
  created_at: string;
  used_by: string | null;
  used_at: string | null;
}

export interface RegisteredUser {
  username: string;
  access_key: string;
  last_seen: string | null;
  created_at: string;
}

export const authApi = {
  /** Register a new user with an access key */
  register(accessKey: string, username: string): Promise<{ username: string; accessKey: string; isAdmin?: boolean }> {
    return request<{ username: string; accessKey: string; isAdmin?: boolean }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ accessKey, username }),
    });
  },

  /** Login with existing credentials */
  login(username: string, accessKey: string): Promise<{ username: string; accessKey: string; isAdmin?: boolean }> {
    return request<{ username: string; accessKey: string; isAdmin?: boolean }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, accessKey }),
    });
  },

  /** Generate a new access key */
  generateKey(label?: string, role?: 'admin' | 'user'): Promise<{ key: string; label: string; role: string }> {
    return request<{ key: string; label: string; role: string }>('/auth/generate-key', {
      method: 'POST',
      body: JSON.stringify({ label, role: role || 'user' }),
    });
  },

  /** List all access keys (admin) */
  listKeys(): Promise<AccessKey[]> {
    return request<AccessKey[]>('/auth/keys');
  },

  /** Delete an access key (admin) */
  deleteKey(key: string): Promise<void> {
    return request<void>(`/auth/keys/${encodeURIComponent(key)}`, { method: 'DELETE' });
  },

  /** List all registered users (admin) */
  listUsers(): Promise<RegisteredUser[]> {
    return request<RegisteredUser[]>('/auth/users');
  },
};

export interface QueueState {
  queue: {
    position: number;
    id: string;
    topic: string;
    username: string;
    status: 'waiting' | 'running';
    enqueuedAt: string;
    startedAt?: string;
  }[];
  currentlyGenerating: string | null;
  queueLength: number;
}

export const queueApi = {
  /** Get current queue state */
  getState(): Promise<QueueState> {
    return request<QueueState>('/workflow/queue');
  },
};
