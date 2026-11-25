import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow, format } from 'date-fns';
import {
  Monitor,
  Terminal,
  Folder,
  Cpu,
  MemoryStick,
  HardDrive,
  Network,
  Activity,
  Play,
  Square,
  X,
  Loader2,
  AlertTriangle,
  Settings,
  Wifi,
  WifiOff,
  Eye,
} from 'lucide-react';
import { api, agentsApi, type AgentDetail, type ProcessInfo, type ScriptJob, type TelemetryPoint } from '../services/api';
import toast from 'react-hot-toast';

type TabType = 'overview' | 'desktop' | 'terminal' | 'files' | 'processes' | 'scripts' | 'telemetry';

const TABS: { id: TabType; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'desktop', label: 'Desktop', icon: Monitor },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'files', label: 'Files', icon: Folder },
  { id: 'processes', label: 'Processes', icon: Cpu },
  { id: 'scripts', label: 'Scripts', icon: Settings },
  { id: 'telemetry', label: 'Telemetry', icon: Network },
];

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionType, setSessionType] = useState<'desktop' | 'terminal' | 'file' | null>(null);
  const [showScriptOutput, setShowScriptOutput] = useState<ScriptJob | null>(null);

  const { data: agent, isLoading, error, refetch } = useQuery({
    queryKey: ['agents', 'detail', id],
    queryFn: () => agentsApi.get(id!).then(res => res.data),
    enabled: !!id,
    refetchInterval: 10000,
  });

  const { data: processes } = useQuery({
    queryKey: ['agents', 'processes', id],
    queryFn: () => agentsApi.getProcesses(id!).then(res => res.data),
    enabled: !!id && activeTab === 'processes',
    refetchInterval: 5000,
  });

  const { data: scripts } = useQuery({
    queryKey: ['agents', 'scripts', id],
    queryFn: () => agentsApi.getScripts(id!).then(res => res.data.data),
    enabled: !!id && activeTab === 'scripts',
    refetchInterval: 5000,
  });

  const { data: telemetry } = useQuery({
    queryKey: ['agents', 'telemetry', id],
    queryFn: () => agentsApi.getTelemetry(id!, { interval: '1m' }).then(res => res.data),
    enabled: !!id && activeTab === 'telemetry',
    refetchInterval: 30000,
  });

  const createSessionMutation = useMutation({
    mutationFn: (data: { type: 'desktop' | 'terminal' | 'file'; quality?: 'low' | 'medium' | 'high' | 'adaptive' }) =>
      api.post<{ id: string }>(`/agents/${id}/sessions`, data).then(res => res.data),
    onSuccess: (data) => {
      setSessionId(data.id);
      toast.success('Session created');
    },
    onError: (err: unknown) => {
      const axiosError = err as { response?: { data?: { error?: string } } };
      toast.error(axiosError.response?.data?.error || 'Failed to create session');
    },
  });

  const killProcessMutation = useMutation({
    mutationFn: (pid: number) => agentsApi.killProcess(id!, pid),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', 'processes', id] });
      toast.success('Process terminated');
    },
    onError: (err: unknown) => {
      const axiosError = err as { response?: { data?: { error?: string } } };
      toast.error(axiosError.response?.data?.error || 'Failed to kill process');
    },
  });

  const runScriptMutation = useMutation({
    mutationFn: (data: { script: string; language: 'powershell' | 'bash' | 'python' | 'cmd'; args?: string[]; timeout?: number }) =>
      agentsApi.runScript(id!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', 'scripts', id] });
      toast.success('Script started');
    },
    onError: (err: unknown) => {
      const axiosError = err as { response?: { data?: { error?: string } } };
      toast.error(axiosError.response?.data?.error || 'Failed to run script');
    },
  });

  const handleCreateSession = (type: 'desktop' | 'terminal' | 'file') => {
    setSessionType(type);
    createSessionMutation.mutate({ type, quality: 'adaptive' });
  };

  const handleCloseSession = () => {
    if (sessionId) {
      api.post(`/sessions/${sessionId}/leave`).catch(() => {});
    }
    setSessionId(null);
    setSessionType(null);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
        </div>
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="card p-8 text-center">
        <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">Agent not found</h3>
        <button onClick={() => navigate('/agents')} className="btn-primary mt-4">Back to Agents</button>
      </div>
    );
  }

  const statusColor = agent.status === 'online' ? 'text-green-500' : agent.status === 'offline' ? 'text-red-500' : 'text-yellow-500';
  const statusBg = agent.status === 'online' ? 'bg-green-100 dark:bg-green-900/30' : agent.status === 'offline' ? 'bg-red-100 dark:bg-red-900/30' : 'bg-yellow-100 dark:bg-yellow-900/30';
  const statusIcon = agent.status === 'online' ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className={`w-3 h-3 rounded-full ${statusColor}`} />
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{agent.name}</h1>
            <p className="text-gray-500 dark:text-dark-textMuted">{agent.hostname} • {agent.os} {agent.os_version} • {agent.arch}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`badge ${statusBg.replace('bg-', 'badge-')} flex items-center gap-1`}>
            {statusIcon}
            {agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}
          </span>
          <span className="text-sm text-gray-500 dark:text-dark-textMuted">
            Last seen {formatDistanceToNow(new Date(agent.last_seen), { addSuffix: true })}
          </span>
          <button onClick={() => refetch()} className="btn-ghost" disabled={isLoading}>
            <Loader2 className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="card">
        <div className="border-b border-gray-200 dark:border-dark-border">
          <nav className="flex gap-1 p-2" role="tablist" aria-label="Agent tabs">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  activeTab === tab.id
                    ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="p-4" role="tabpanel" aria-labelledby={activeTab}>
          {sessionId && sessionType && (
            <SessionPanel
              type={sessionType}
              sessionId={sessionId}
              onClose={handleCloseSession}
            />
          )}

          {activeTab === 'overview' && <OverviewTab agent={agent} />}
          {activeTab === 'desktop' && !sessionId && (
            <CenteredAction
              icon={Monitor}
              title="Remote Desktop"
              description="View and control the agent's desktop in real-time with hardware-accelerated H.264 streaming"
              actionLabel="Start Desktop Session"
              onAction={() => handleCreateSession('desktop')}
            />
          )}
          {activeTab === 'terminal' && !sessionId && (
            <CenteredAction
              icon={Terminal}
              title="Terminal Access"
              description="Full PTY terminal with xterm.js - supports colors, Unicode, and all shell features"
              actionLabel="Open Terminal"
              onAction={() => handleCreateSession('terminal')}
            />
          )}
          {activeTab === 'files' && !sessionId && (
            <CenteredAction
              icon={Folder}
              title="File Manager"
              description="Browse, upload, download, and manage files on the remote system"
              actionLabel="Open File Manager"
              onAction={() => handleCreateSession('file')}
            />
          )}
          {activeTab === 'processes' && <ProcessesTab processes={processes || []} onKill={killProcessMutation.mutate} />}
          {activeTab === 'scripts' && <ScriptsTab scripts={scripts || []} onRun={runScriptMutation.mutate} onViewOutput={setShowScriptOutput} />}
          {activeTab === 'telemetry' && <TelemetryTab telemetry={telemetry || []} />}
        </div>
      </div>

      {showScriptOutput && (
        <ScriptOutputModal job={showScriptOutput} onClose={() => setShowScriptOutput(null)} />
      )}
    </div>
  );
}

function SessionPanel({ type, sessionId, onClose }: { type: 'desktop' | 'terminal' | 'file'; sessionId: string; onClose: () => void }) {
  const icons = { desktop: Monitor, terminal: Terminal, file: Folder };
  const Icon = icons[type];

  return (
    <div className="mb-4 p-3 bg-primary-50 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-800 rounded-lg flex items-center justify-between animate-slide-in">
      <div className="flex items-center gap-3">
        <Icon className="w-5 h-5 text-primary-600 dark:text-primary-400" />
        <div>
          <p className="font-medium text-primary-800 dark:text-primary-200">
            Active {type.charAt(0).toUpperCase() + type.slice(1)} Session
          </p>
          <p className="text-sm text-primary-600 dark:text-primary-400 font-mono">{sessionId.slice(0, 12)}...</p>
        </div>
      </div>
      <button onClick={onClose} className="btn-ghost btn-sm text-primary-700 dark:text-primary-300 hover:bg-primary-100 dark:hover:bg-primary-900/30">
        <X className="w-4 h-4" />
        End Session
      </button>
    </div>
  );
}

function CenteredAction({ icon: Icon, title, description, actionLabel, onAction }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-[400px] text-center">
      <div className="w-16 h-16 rounded-2xl bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center mb-6">
        <Icon className="w-8 h-8 text-primary-600 dark:text-primary-400" />
      </div>
      <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">{title}</h3>
      <p className="text-gray-500 dark:text-dark-textMuted max-w-md mb-6">{description}</p>
      <button onClick={onAction} className="btn-primary px-8 py-3">
        {actionLabel}
      </button>
    </div>
  );
}

function OverviewTab({ agent }: { agent: AgentDetail }) {
  const specs = [
    { label: 'CPU', value: agent.cpu_model || 'Unknown', icon: Cpu },
    { label: 'Cores', value: agent.cpu_cores?.toString() || 'Unknown', icon: Cpu },
    { label: 'Memory', value: agent.memory_total ? `${(agent.memory_total / 1024 / 1024 / 1024).toFixed(1)} GB` : 'Unknown', icon: MemoryStick },
    { label: 'Disk', value: agent.disk_total ? `${(agent.disk_total / 1024 / 1024 / 1024).toFixed(1)} GB` : 'Unknown', icon: HardDrive },
    { label: 'GPU', value: agent.gpu_info || 'Unknown', icon: Activity },
    { label: 'Agent Version', value: agent.version, icon: Settings },
    { label: 'Enrolled', value: format(new Date(agent.enrolled_at), 'PPp'), icon: Activity },
    { label: 'IP Address', value: agent.ip_address || 'Unknown', icon: Network },
    { label: 'Public IP', value: agent.public_ip || 'Unknown', icon: Network },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard label="CPU Usage" value={`${Math.round(agent.cpu_usage || 0)}%`} icon={Cpu} color="blue" />
        <StatCard label="Memory Usage" value={`${Math.round(agent.memory_usage || 0)}%`} icon={MemoryStick} color="green" />
        <StatCard label="Disk Usage" value={`${Math.round(agent.disk_usage || 0)}%`} icon={HardDrive} color="orange" />
      </div>

      <div>
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4">System Information</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {specs.map((spec) => (
            <div key={spec.label} className="card p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded-lg">
                  <spec.icon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                </div>
                <div>
                  <p className="text-sm text-gray-500 dark:text-dark-textMuted">{spec.label}</p>
                  <p className="font-medium text-gray-900 dark:text-white">{spec.value}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {agent.screens && agent.screens.length > 0 && (
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Displays</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {agent.screens.map((screen) => (
              <div key={screen.id} className="card p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Monitor className="w-6 h-6 text-gray-500" />
                    <div>
                      <p className="font-medium text-gray-900 dark:text-white">{screen.name} {screen.is_primary && <span className="badge badge-info ml-2">Primary</span>}</p>
                      <p className="text-sm text-gray-500 dark:text-dark-textMuted">{screen.width}×{screen.height} @ {screen.scale}x</p>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, icon: Icon, color }: { label: string; value: string; icon: React.ComponentType<{ className?: string }>; color: string }) {
  const colors = {
    blue: 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
    green: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400',
    orange: 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400',
    red: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
  };

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500 dark:text-dark-textMuted">{label}</p>
          <p className="text-3xl font-bold text-gray-900 dark:text-white mt-1">{value}</p>
        </div>
        <div className={`p-3 rounded-xl ${colors[color as keyof typeof colors]}`}>
          <Icon className="w-6 h-6" />
        </div>
      </div>
    </div>
  );
}

function ProcessesTab({ processes, onKill }: { processes: ProcessInfo[]; onKill: (pid: number) => void }) {
  if (processes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[400px] text-center">
        <Cpu className="w-16 h-16 text-gray-300 dark:text-gray-600 mb-4" />
        <p className="text-gray-500 dark:text-dark-textMuted">No processes found</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-800/50">
            <th className="table-header">PID</th>
            <th className="table-header">Name</th>
            <th className="table-header hidden md:table-cell">User</th>
            <th className="table-header hidden lg:table-cell">CPU %</th>
            <th className="table-header hidden lg:table-cell">Memory %</th>
            <th className="table-header hidden xl:table-cell">Memory RSS</th>
            <th className="table-header hidden xl:table-cell">Status</th>
            <th className="table-header hidden xl:table-cell">Threads</th>
            <th className="table-header hidden xl:table-cell">Started</th>
            <th className="table-header text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-dark-border">
          {processes.map((proc) => (
            <tr key={proc.pid} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
              <td className="table-cell font-mono text-sm">{proc.pid}</td>
              <td className="table-cell font-medium text-gray-900 dark:text-white">{proc.name}</td>
              <td className="table-cell hidden md:table-cell text-sm text-gray-500 dark:text-dark-textMuted">{proc.username}</td>
              <td className="table-cell hidden lg:table-cell text-sm font-mono">{proc.cpu_percent.toFixed(1)}%</td>
              <td className="table-cell hidden lg:table-cell text-sm font-mono">{proc.memory_percent.toFixed(1)}%</td>
              <td className="table-cell hidden xl:table-cell text-sm font-mono text-gray-500 dark:text-dark-textMuted">
                {(proc.memory_rss / 1024 / 1024).toFixed(1)} MB
              </td>
              <td className="table-cell hidden xl:table-cell">
                <span className={`badge ${proc.status === 'running' ? 'badge-success' : 'badge-gray'}`}>{proc.status}</span>
              </td>
              <td className="table-cell hidden xl:table-cell text-sm text-gray-500 dark:text-dark-textMuted">{proc.threads}</td>
              <td className="table-cell hidden xl:table-cell text-sm text-gray-500 dark:text-dark-textMuted">
                {formatDistanceToNow(new Date(proc.created_at), { addSuffix: true })}
              </td>
              <td className="table-cell text-right">
                <button
                  onClick={() => onKill(proc.pid)}
                  className="btn-danger btn-sm"
                >
                  Kill
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScriptsTab({ scripts, onRun, onViewOutput }: { scripts: ScriptJob[]; onRun: (data: any) => void; onViewOutput: (job: ScriptJob) => void }) {
  const [showRunModal, setShowRunModal] = useState(false);
  const [scriptForm, setScriptForm] = useState({ script: '', language: 'bash' as const, args: '', timeout: 60 });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onRun({
      script: scriptForm.script,
      language: scriptForm.language,
      args: scriptForm.args.split('\n').filter(Boolean),
      timeout: scriptForm.timeout,
    });
    setShowRunModal(false);
    setScriptForm({ script: '', language: 'bash', args: '', timeout: 60 });
  };

  return (
    <div className="space-y-4">
      <button onClick={() => setShowRunModal(true)} className="btn-primary">
        <Play className="w-4 h-4" />
        Run Script
      </button>

      {scripts.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-[300px] text-center">
          <Settings className="w-16 h-16 text-gray-300 dark:text-gray-600 mb-4" />
          <p className="text-gray-500 dark:text-dark-textMuted">No scripts executed yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {scripts.map((script) => (
            <div key={script.id} className="card p-4">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <span className={`badge ${script.status === 'running' ? 'badge-warning' : script.status === 'completed' ? 'badge-success' : script.status === 'failed' ? 'badge-danger' : 'badge-gray'}`}>
                      {script.status}
                    </span>
                    <span className="badge badge-info">{script.language}</span>
                    <span className="text-sm text-gray-500 dark:text-dark-textMuted font-mono">#{script.id.slice(0, 8)}</span>
                  </div>
                  <p className="font-mono text-sm text-gray-700 dark:text-gray-300 mb-1">{script.name}</p>
                  <p className="text-xs text-gray-500 dark:text-dark-textMuted">
                    Started {formatDistanceToNow(new Date(script.created_at), { addSuffix: true })}
                    {script.started_at && ` • Ran for ${Math.round((new Date(script.completed_at || Date.now()).getTime() - new Date(script.started_at).getTime()) / 1000)}s`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => onViewOutput(script)} className="btn-ghost btn-sm">
                    <Eye className="w-4 h-4" />
                    Output
                  </button>
                  {script.status === 'running' && (
                    <button onClick={() => api.post(`/agents/${script.agent_id}/scripts/${script.id}/cancel`)} className="btn-danger btn-sm">
                      <Square className="w-4 h-4" />
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showRunModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 animate-fade-in">
          <div className="card w-full max-w-2xl max-h-[90vh] overflow-y-auto animate-scale-in">
            <div className="p-6 border-b border-gray-200 dark:border-dark-border flex items-center justify-between">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Run Script</h2>
              <button onClick={() => setShowRunModal(false)} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Script Name</label>
                <input type="text" className="input" placeholder="My Script" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Language</label>
                <select value={scriptForm.language} onChange={(e) => setScriptForm(prev => ({ ...prev, language: e.target.value as any }))} className="input">
                  <option value="bash">Bash</option>
                  <option value="powershell">PowerShell</option>
                  <option value="python">Python</option>
                  <option value="cmd">CMD</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Script Content</label>
                <textarea
                  value={scriptForm.script}
                  onChange={(e) => setScriptForm(prev => ({ ...prev, script: e.target.value }))}
                  className="input font-mono min-h-[200px] resize-y"
                  placeholder="#!/bin/bash\necho 'Hello, World!'"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Arguments (one per line)</label>
                <textarea
                  value={scriptForm.args}
                  onChange={(e) => setScriptForm(prev => ({ ...prev, args: e.target.value }))}
                  className="input font-mono min-h-[80px] resize-y"
                  placeholder="arg1\narg2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Timeout (seconds)</label>
                <input type="number" value={scriptForm.timeout} onChange={(e) => setScriptForm(prev => ({ ...prev, timeout: parseInt(e.target.value) }))} className="input w-32" min="1" max="3600" />
              </div>
              <div className="flex justify-end gap-3 pt-4">
                <button type="button" onClick={() => setShowRunModal(false)} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary">
                  <Play className="w-4 h-4" />
                  Run Script
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function ScriptOutputModal({ job, onClose }: { job: ScriptJob; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 animate-fade-in">
      <div className="card w-full max-w-3xl max-h-[90vh] overflow-y-auto animate-scale-in">
        <div className="p-6 border-b border-gray-200 dark:border-dark-border flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{job.name}</h2>
            <p className="text-sm text-gray-500 dark:text-dark-textMuted">{job.language} • {job.status} • Exit code: {job.exit_code ?? 'N/A'}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          {(job.stdout || job.stderr) && (
            <>
              {job.stdout && (
                <div>
                  <h3 className="font-medium text-gray-900 dark:text-white mb-2">Stdout</h3>
                  <pre className="bg-gray-950 text-green-400 p-4 rounded-lg font-mono text-sm overflow-auto max-h-96">{job.stdout}</pre>
                </div>
              )}
              {job.stderr && (
                <div>
                  <h3 className="font-medium text-gray-900 dark:text-white mb-2">Stderr</h3>
                  <pre className="bg-gray-950 text-red-400 p-4 rounded-lg font-mono text-sm overflow-auto max-h-96">{job.stderr}</pre>
                </div>
              )}
            </>
          )}
          {(!job.stdout && !job.stderr) && (
            <div className="text-center text-gray-500 dark:text-dark-textMuted py-8">No output captured</div>
          )}
        </div>
      </div>
    </div>
  );
}

function TelemetryTab({ telemetry }: { telemetry: TelemetryPoint[] }) {
  if (telemetry.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[400px] text-center">
        <Network className="w-16 h-16 text-gray-300 dark:text-gray-600 mb-4" />
        <p className="text-gray-500 dark:text-dark-textMuted">No telemetry data available</p>
      </div>
    );
  }

  const latest = telemetry[telemetry.length - 1];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard label="CPU" value={`${latest.cpu_percent.toFixed(1)}%`} icon={Cpu} color="blue" />
        <StatCard label="Memory" value={`${latest.memory_percent.toFixed(1)}%`} icon={MemoryStick} color="green" />
        <StatCard label="Disk" value={`${latest.disk_percent.toFixed(1)}%`} icon={HardDrive} color="orange" />
        <StatCard label="Processes" value={latest.processes_count.toString()} icon={Activity} color="purple" />
      </div>

      <div className="card p-4">
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Network I/O</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
            <p className="text-sm text-gray-500 dark:text-dark-textMuted mb-1">Received</p>
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400 font-mono">
              {(latest.network_rx_bytes / 1024 / 1024).toFixed(2)} MB
            </p>
          </div>
          <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
            <p className="text-sm text-gray-500 dark:text-dark-textMuted mb-1">Sent</p>
            <p className="text-2xl font-bold text-green-600 dark:text-green-400 font-mono">
              {(latest.network_tx_bytes / 1024 / 1024).toFixed(2)} MB
            </p>
          </div>
        </div>
      </div>

      <div className="card p-4">
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Recent History</h3>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800/50">
                <th className="table-header">Time</th>
                <th className="table-header">CPU %</th>
                <th className="table-header">Memory %</th>
                <th className="table-header">Disk %</th>
                <th className="table-header">Net RX</th>
                <th className="table-header">Net TX</th>
                <th className="table-header">Processes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-dark-border">
              {telemetry.slice(-20).reverse().map((point) => (
                <tr key={point.timestamp} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="table-cell font-mono text-sm">{format(new Date(point.timestamp), 'HH:mm:ss')}</td>
                  <td className="table-cell">{point.cpu_percent.toFixed(1)}%</td>
                  <td className="table-cell">{point.memory_percent.toFixed(1)}%</td>
                  <td className="table-cell">{point.disk_percent.toFixed(1)}%</td>
                  <td className="table-cell font-mono text-sm">{(point.network_rx_bytes / 1024).toFixed(1)} KB</td>
                  <td className="table-cell font-mono text-sm">{(point.network_tx_bytes / 1024).toFixed(1)} KB</td>
                  <td className="table-cell">{point.processes_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}