import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'https://rmm.mezfashion.pro/api';

export const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true,
  timeout: 30000,
});

api.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = localStorage.getItem('access_token');
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        const refreshToken = localStorage.getItem('refresh_token');
        if (refreshToken) {
          const { data } = await axios.post(`${API_URL}/auth/refresh`, { refresh_token: refreshToken });
          localStorage.setItem('access_token', data.access_token);
          localStorage.setItem('refresh_token', data.refresh_token);

          if (originalRequest.headers) {
            originalRequest.headers.Authorization = `Bearer ${data.access_token}`;
          }
          return api(originalRequest);
        }
      } catch {
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        window.location.href = '/login';
      }
    }

    return Promise.reject(error);
  }
);

export interface Agent {
  id: string;
  name: string;
  hostname: string;
  os: string;
  os_version: string;
  arch: string;
  status: 'online' | 'offline' | 'maintenance' | 'enrolling';
  last_seen: string;
  enrolled_at: string;
  version: string;
  tags: string[];
  ip_address?: string;
  public_ip?: string;
  cpu_model?: string;
  cpu_cores?: number;
  memory_total?: number;
  disk_total?: number;
  gpu_info?: string;
  cpu_usage?: number;
  memory_usage?: number;
  disk_usage?: number;
}

export interface AgentDetail extends Agent {
  cpu_usage?: number;
  memory_usage?: number;
  disk_usage?: number;
  network_rx?: number;
  network_tx?: number;
  processes_count?: number;
  uptime?: number;
  screens?: ScreenInfo[];
}

export interface ScreenInfo {
  id: number;
  name: string;
  width: number;
  height: number;
  scale: number;
  is_primary: boolean;
}

export interface Session {
  id: string;
  agent_id: string;
  agent_name: string;
  user_id: string;
  user_name: string;
  type: 'desktop' | 'terminal' | 'file' | 'process' | 'script';
  status: 'active' | 'ended' | 'pending';
  started_at: string;
  ended_at?: string;
  duration?: number;
  quality?: 'low' | 'medium' | 'high' | 'adaptive';
  recording?: boolean;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  exe: string;
  cmdline: string[];
  cpu_percent: number;
  memory_percent: number;
  memory_rss: number;
  status: string;
  username: string;
  created_at: string;
  threads: number;
}

export interface FileInfo {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  mode: number;
  modified_at: string;
  mime_type?: string;
}

export interface ScriptJob {
  id: string;
  agent_id: string;
  name: string;
  script: string;
  language: 'powershell' | 'bash' | 'python' | 'cmd';
  args: string[];
  timeout: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  started_at?: string;
  completed_at?: string;
  created_by: string;
  created_at: string;
}

export interface TelemetryPoint {
  agent_id: string;
  timestamp: string;
  cpu_percent: number;
  memory_percent: number;
  disk_percent: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  processes_count: number;
  load_avg?: number[];
}

export interface AuditLog {
  id: string;
  timestamp: string;
  user_id: string;
  user_name: string;
  action: string;
  resource_type: string;
  resource_id: string;
  details: Record<string, unknown>;
  ip_address: string;
  user_agent: string;
  result: 'success' | 'failure';
}

export interface EnrollmentToken {
  token: string;
  expires_at: string;
  tags: string[];
  max_uses: number;
  used_count: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  scopes: string[];
  mfa_enabled: boolean;
  created_at: string;
  last_login?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export const agentsApi = {
  list: (params?: { page?: number; page_size?: number; status?: string; search?: string; tags?: string[] }) =>
    api.get<PaginatedResponse<Agent>>('/agents', { params }),

  get: (id: string) =>
    api.get<AgentDetail>(`/agents/${id}`),

  update: (id: string, data: Partial<Agent>) =>
    api.patch<Agent>(`/agents/${id}`, data),

  delete: (id: string) =>
    api.delete(`/agents/${id}`),

  enroll: (data: { name?: string; tags?: string[]; max_uses?: number; ttl_hours?: number }) =>
    api.post<EnrollmentToken>('/agents/enroll', data),

  getTelemetry: (id: string, params?: { from?: string; to?: string; interval?: string }) =>
    api.get<TelemetryPoint[]>(`/agents/${id}/telemetry`, { params }),

  getProcesses: (id: string) =>
    api.get<ProcessInfo[]>(`/agents/${id}/processes`),

  killProcess: (id: string, pid: number) =>
    api.post(`/agents/${id}/processes/${pid}/kill`),

  startProcess: (id: string, data: { exe: string; args?: string[]; cwd?: string; env?: Record<string, string> }) =>
    api.post<{ pid: number }>(`/agents/${id}/processes`, data),

  getFiles: (id: string, path: string) =>
    api.get<FileInfo[]>(`/agents/${id}/files`, { params: { path } }),

  uploadFile: (id: string, path: string, file: File, onProgress?: (progress: number) => void) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post<FileInfo>(`/agents/${id}/files/upload`, formData, {
      params: { path },
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (e) => {
        if (e.total && onProgress) {
          onProgress(Math.round((e.loaded * 100) / e.total));
        }
      },
    });
  },

  downloadFile: (id: string, path: string) =>
    api.get(`/agents/${id}/files/download`, { params: { path }, responseType: 'blob' }),

  deleteFile: (id: string, path: string) =>
    api.delete(`/agents/${id}/files`, { params: { path } }),

  createDirectory: (id: string, path: string) =>
    api.post<FileInfo>(`/agents/${id}/files/mkdir`, { path }),

  runScript: (id: string, data: { script: string; language: 'powershell' | 'bash' | 'python' | 'cmd'; args?: string[]; timeout?: number }) =>
    api.post<ScriptJob>(`/agents/${id}/scripts`, data),

  getScripts: (id: string, params?: { page?: number; page_size?: number }) =>
    api.get<PaginatedResponse<ScriptJob>>(`/agents/${id}/scripts`, { params }),

  getScriptOutput: (id: string, jobId: string) =>
    api.get<ScriptJob>(`/agents/${id}/scripts/${jobId}`),

  cancelScript: (id: string, jobId: string) =>
    api.post(`/agents/${id}/scripts/${jobId}/cancel`),
};

export const sessionsApi = {
  list: (params?: { page?: number; page_size?: number; status?: string; agent_id?: string }) =>
    api.get<PaginatedResponse<Session>>('/sessions', { params }),

  get: (id: string) =>
    api.get<Session>(`/sessions/${id}`),

  create: (data: { agent_id: string; type: 'desktop' | 'terminal' | 'file' | 'process' | 'script'; quality?: 'low' | 'medium' | 'high' | 'adaptive'; recording?: boolean }) =>
    api.post<Session>('/sessions', data),

  join: (id: string) =>
    api.post(`/sessions/${id}/join`),

  leave: (id: string) =>
    api.post(`/sessions/${id}/leave`),

  terminate: (id: string) =>
    api.post(`/sessions/${id}/terminate`),

  getRecording: (id: string) =>
    api.get(`/sessions/${id}/recording`, { responseType: 'blob' }),
};

export const authApi = {
  login: (email: string, password: string, code?: string) =>
    api.post<{ token: string; refresh_token: string; user: User }>('/auth/login', { email, password, code }),

  logout: () =>
    api.post('/auth/logout'),

  me: () =>
    api.get<User>('/me'),

  refresh: (refreshToken: string) =>
    api.post<{ access_token: string; refresh_token: string }>('/auth/refresh', { refresh_token: refreshToken }),

  register: (data: { email: string; password: string; name: string }) =>
    api.post<User>('/auth/register', data),

  requestPasswordReset: (email: string) =>
    api.post('/auth/password/reset/request', { email }),

  resetPassword: (token: string, password: string) =>
    api.post('/auth/password/reset', { token, password }),

  setupMFA: () =>
    api.post<{ secret: string; qr_code: string; backup_codes: string[] }>('/auth/mfa/setup'),

  verifyMFA: (code: string) =>
    api.post('/auth/mfa/verify', { code }),

  disableMFA: (code: string) =>
    api.post('/auth/mfa/disable', { code }),
};

export const usersApi = {
  list: (params?: { page?: number; page_size?: number; search?: string }) =>
    api.get<PaginatedResponse<User>>('/users', { params }),

  get: (id: string) =>
    api.get<User>(`/users/${id}`),

  create: (data: { email: string; name: string; role: string; scopes: string[]; password: string }) =>
    api.post<User>('/users', data),

  update: (id: string, data: Partial<User> & { password?: string }) =>
    api.patch<User>(`/users/${id}`, data),

  delete: (id: string) =>
    api.delete(`/users/${id}`),

  resetMFA: (id: string) =>
    api.post(`/users/${id}/mfa/reset`),
};

export const auditApi = {
  list: (params?: { page?: number; page_size?: number; user_id?: string; action?: string; resource_type?: string; from?: string; to?: string }) =>
    api.get<PaginatedResponse<AuditLog>>('/audit', { params }),
};

export const settingsApi = {
  get: () =>
    api.get<Record<string, unknown>>('/settings'),

  update: (data: Record<string, unknown>) =>
    api.patch('/settings', data),

  testSMTP: (data: { host: string; port: number; username: string; password: string; from: string }) =>
    api.post('/settings/smtp/test', data),

  testLDAP: (data: { url: string; bind_dn: string; bind_password: string; base_dn: string; filter: string }) =>
    api.post('/settings/ldap/test', data),
};

export default api;