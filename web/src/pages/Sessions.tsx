import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  Monitor,
  Terminal,
  Folder,
  Cpu,
  FileText,
  X,
  Download,
  Loader2,
} from 'lucide-react';
import { api, sessionsApi } from '../services/api';
import toast from 'react-hot-toast';

export function Sessions() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['sessions', 'list', { page, page_size: pageSize, status: statusFilter }],
    queryFn: () => sessionsApi.list({ page, page_size: pageSize, status: statusFilter }).then(res => res.data),
    placeholderData: (prev) => prev,
  });

  let sessions = data?.data || [];
  if (typeFilter) {
    sessions = sessions.filter(s => s.type === typeFilter);
  }
  const total = data?.total || 0;
  const totalPages = data?.total_pages || 1;

  const terminateMutation = useMutation({
    mutationFn: (id: string) => sessionsApi.terminate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      toast.success('Session terminated');
    },
    onError: (err: unknown) => {
      const axiosError = err as { response?: { data?: { error?: string } } };
      toast.error(axiosError.response?.data?.error || 'Failed to terminate session');
    },
  });

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'desktop': return <Monitor className="w-4 h-4" />;
      case 'terminal': return <Terminal className="w-4 h-4" />;
      case 'file': return <Folder className="w-4 h-4" />;
      case 'process': return <Cpu className="w-4 h-4" />;
      case 'script': return <FileText className="w-4 h-4" />;
      default: return <Monitor className="w-4 h-4" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active': return 'badge-success';
      case 'ended': return 'badge-gray';
      case 'pending': return 'badge-warning';
      default: return 'badge-gray';
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Sessions</h1>
          <p className="text-gray-500 dark:text-dark-textMuted">Active and historical remote sessions</p>
        </div>
        <button onClick={() => refetch()} className="btn-secondary" disabled={isLoading}>
          <Loader2 className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="card">
        <div className="p-4 border-b border-gray-200 dark:border-dark-border">
          <div className="flex flex-col sm:flex-row gap-4">
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
              className="input w-auto sm:w-40"
            >
              <option value="">All Status</option>
              <option value="active">Active</option>
              <option value="ended">Ended</option>
              <option value="pending">Pending</option>
            </select>
            <select
              value={typeFilter}
              onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
              className="input w-auto sm:w-40"
            >
              <option value="">All Types</option>
              <option value="desktop">Desktop</option>
              <option value="terminal">Terminal</option>
              <option value="file">File Transfer</option>
              <option value="process">Process</option>
              <option value="script">Script</option>
            </select>
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(parseInt(e.target.value)); setPage(1); }}
              className="input w-auto sm:w-32"
            >
              <option value="25">25 per page</option>
              <option value="50">50 per page</option>
              <option value="100">100 per page</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800/50">
                <th className="table-header">Session</th>
                <th className="table-header">Agent</th>
                <th className="table-header">User</th>
                <th className="table-header">Type</th>
                <th className="table-header">Status</th>
                <th className="table-header hidden md:table-cell">Started</th>
                <th className="table-header hidden lg:table-cell">Duration</th>
                <th className="table-header hidden lg:table-cell">Quality</th>
                <th className="table-header hidden xl:table-cell">Recording</th>
                <th className="table-header text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-dark-border">
              {sessions.length === 0 ? (
                <tr>
                  <td className="table-cell text-center text-gray-500 dark:text-dark-textMuted" colSpan={10}>
                    {isLoading ? (
                      <div className="flex items-center justify-center gap-2 py-8">
                        <Loader2 className="w-5 h-5 animate-spin text-primary-600" />
                        Loading sessions...
                      </div>
                    ) : (
                      'No sessions found'
                    )}
                  </td>
                </tr>
              ) : (
                sessions.map((session) => (
                  <tr key={session.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td className="table-cell font-mono text-sm text-gray-700 dark:text-gray-300">
                      {session.id.slice(0, 12)}...
                    </td>
                    <td className="table-cell">
                      <div className="font-medium text-gray-900 dark:text-white">{session.agent_name}</div>
                      <div className="text-sm text-gray-500 dark:text-dark-textMuted font-mono">{session.agent_id.slice(0, 8)}...</div>
                    </td>
                    <td className="table-cell hidden md:table-cell">
                      <div className="font-medium text-gray-900 dark:text-white">{session.user_name}</div>
                      <div className="text-sm text-gray-500 dark:text-dark-textMuted font-mono">{session.user_id.slice(0, 8)}...</div>
                    </td>
                    <td className="table-cell">
                      <span className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                        {getTypeIcon(session.type)}
                        {session.type.charAt(0).toUpperCase() + session.type.slice(1)}
                      </span>
                    </td>
                    <td className="table-cell">
                      <span className={`badge ${getStatusBadge(session.status)}`}>
                        {session.status.charAt(0).toUpperCase() + session.status.slice(1)}
                      </span>
                    </td>
                    <td className="table-cell hidden md:table-cell text-sm text-gray-500 dark:text-dark-textMuted">
                      {format(new Date(session.started_at), 'MMM d, HH:mm')}
                    </td>
                    <td className="table-cell hidden lg:table-cell text-sm font-mono text-gray-500 dark:text-dark-textMuted">
                      {session.duration ? `${Math.round(session.duration / 60)}m ${session.duration % 60}s` : '—'}
                    </td>
                    <td className="table-cell hidden lg:table-cell">
                      {session.quality && (
                        <span className="badge badge-info text-xs">{session.quality}</span>
                      )}
                    </td>
                    <td className="table-cell hidden xl:table-cell text-center">
                      {session.recording && (
                        <span className="badge badge-danger flex items-center justify-center gap-1" title="Recording">
                          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                          REC
                        </span>
                      )}
                    </td>
                    <td className="table-cell text-right">
                      <div className="flex items-center justify-end gap-1">
                        {session.status === 'active' && (
                          <button
                            onClick={() => terminateMutation.mutate(session.id)}
                            disabled={terminateMutation.isPending}
                            className="btn-danger btn-sm"
                            title="Terminate session"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        )}
                        {session.recording && (
                          <button
                            onClick={() => {
                              api.get(`/sessions/${session.id}/recording`, { responseType: 'blob' })
                                .then(res => {
                                  const url = window.URL.createObjectURL(new Blob([res.data]));
                                  const a = document.createElement('a');
                                  a.href = url;
                                  a.download = `session-${session.id.slice(0, 8)}.webm`;
                                  a.click();
                                  window.URL.revokeObjectURL(url);
                                  toast.success('Recording downloaded');
                                })
                                .catch(() => toast.error('Failed to download recording'));
                            }}
                            className="btn-secondary btn-sm"
                            title="Download recording"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="p-4 border-t border-gray-200 dark:border-dark-border flex items-center justify-between">
            <p className="text-sm text-gray-500 dark:text-dark-textMuted">
              Showing {((page - 1) * pageSize) + 1} to {Math.min(page * pageSize, total)} of {total} sessions
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1 || isLoading}
                className="btn-secondary btn-sm"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages || isLoading}
                className="btn-secondary btn-sm"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}