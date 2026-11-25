import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { NavLink } from 'react-router-dom';
import {
  Plus,
  Search,
  Loader2,
  Server,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Copy,
} from 'lucide-react';
import { agentsApi, EnrollmentToken } from '../services/api';
import toast from 'react-hot-toast';

export function Agents() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showEnrollModal, setShowEnrollModal] = useState(false);
  const [enrollToken, setEnrollToken] = useState<EnrollmentToken | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['agents', 'list', { page, page_size: pageSize, status: statusFilter, search }],
    queryFn: () => agentsApi.list({ page, page_size: pageSize, status: statusFilter, search }).then(res => res.data),
    placeholderData: (prev) => prev,
  });

  const agents = data?.data || [];
  const total = data?.total || 0;
  const totalPages = data?.total_pages || 1;

  const deleteMutation = useMutation({
    mutationFn: (id: string) => agentsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      toast.success('Agent deleted');
    },
    onError: (err: unknown) => {
      const axiosError = err as { response?: { data?: { error?: string } } };
      toast.error(axiosError.response?.data?.error || 'Failed to delete agent');
    },
  });

  const enrollMutation = useMutation({
    mutationFn: (data: { name?: string; tags?: string[]; max_uses?: number; ttl_hours?: number }) =>
      agentsApi.enroll(data).then(res => res.data),
    onSuccess: (token) => {
      setEnrollToken(token);
      setShowEnrollModal(true);
      toast.success('Enrollment token created');
    },
    onError: (err: unknown) => {
      const axiosError = err as { response?: { data?: { error?: string } } };
      toast.error(axiosError.response?.data?.error || 'Failed to create enrollment token');
    },
  });

  const handleDelete = (id: string, name: string) => {
    if (confirm(`Delete agent "${name}"? This action cannot be undone.`)) {
      deleteMutation.mutate(id);
    }
  };

  const copyToken = () => {
    if (enrollToken) {
      navigator.clipboard.writeText(enrollToken.token);
      toast.success('Token copied to clipboard');
    }
  };

  const copyInstallCommand = () => {
    if (enrollToken) {
      const cmd = `curl -sSL https://rmm.mezfashion.pro/install.sh | bash -s -- --token ${enrollToken.token}`;
      navigator.clipboard.writeText(cmd);
      toast.success('Install command copied');
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'online': return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'offline': return <XCircle className="w-4 h-4 text-red-500" />;
      case 'maintenance': return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
      default: return <Server className="w-4 h-4 text-gray-500" />;
    }
  };

  const getStatusClass = (status: string) => {
    switch (status) {
      case 'online': return 'badge-success';
      case 'offline': return 'badge-danger';
      case 'maintenance': return 'badge-warning';
      default: return 'badge-gray';
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Agents</h1>
          <p className="text-gray-500 dark:text-dark-textMuted">Manage and monitor enrolled agents</p>
        </div>
        <button
          onClick={() => enrollMutation.mutate({})}
          disabled={enrollMutation.isPending}
          className="btn-primary"
        >
          <Plus className="w-4 h-4" />
          Enroll Agent
        </button>
      </div>

      <div className="card">
        <div className="p-4 border-b border-gray-200 dark:border-dark-border">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                placeholder="Search agents..."
                className="input pl-10"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
              className="input w-auto sm:w-40"
            >
              <option value="">All Status</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="maintenance">Maintenance</option>
              <option value="enrolling">Enrolling</option>
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
                <th className="table-header">Agent</th>
                <th className="table-header hidden md:table-cell">Hostname</th>
                <th className="table-header hidden lg:table-cell">OS</th>
                <th className="table-header">Status</th>
                <th className="table-header hidden lg:table-cell">Last Seen</th>
                <th className="table-header hidden xl:table-cell">Version</th>
                <th className="table-header text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-dark-border">
              {agents.length === 0 ? (
                <tr>
                  <td className="table-cell text-center text-gray-500 dark:text-dark-textMuted" colSpan={7}>
                    {isLoading ? (
                      <div className="flex items-center justify-center gap-2 py-8">
                        <Loader2 className="w-5 h-5 animate-spin text-primary-600" />
                        Loading agents...
                      </div>
                    ) : (
                      'No agents found. Enroll your first agent to get started.'
                    )}
                  </td>
                </tr>
              ) : (
                agents.map((agent) => (
                  <tr key={agent.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td className="table-cell">
                      <NavLink to={`/agents/${agent.id}`} className="flex items-center gap-3">
                        <div className={`w-3 h-3 rounded-full ${
                          agent.status === 'online' ? 'bg-green-500' :
                          agent.status === 'offline' ? 'bg-red-500' :
                          agent.status === 'maintenance' ? 'bg-yellow-500' :
                          'bg-gray-500'
                        }`} />
                        <div>
                          <p className="font-medium text-gray-900 dark:text-white">{agent.name}</p>
                          <p className="text-xs text-gray-500 dark:text-dark-textMuted font-mono">{agent.id.slice(0, 8)}...</p>
                        </div>
                      </NavLink>
                    </td>
                    <td className="table-cell hidden md:table-cell font-mono text-sm text-gray-700 dark:text-gray-300">
                      {agent.hostname}
                    </td>
                    <td className="table-cell hidden lg:table-cell">
                      <span className="badge badge-info">{agent.os} {agent.os_version}</span>
                    </td>
                    <td className="table-cell">
                      <span className={`badge ${getStatusClass(agent.status)} flex items-center gap-1`}>
                        {getStatusBadge(agent.status)}
                        {agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}
                      </span>
                    </td>
                    <td className="table-cell hidden lg:table-cell text-sm text-gray-500 dark:text-dark-textMuted">
                      {formatDistanceToNow(new Date(agent.last_seen), { addSuffix: true })}
                    </td>
                    <td className="table-cell hidden xl:table-cell text-sm text-gray-500 dark:text-dark-textMuted font-mono">
                      v{agent.version}
                    </td>
                    <td className="table-cell text-right">
                      <div className="flex items-center justify-end gap-1">
                        <NavLink
                          to={`/agents/${agent.id}`}
                          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                          title="View details"
                        >
                          <Server className="w-4 h-4" />
                        </NavLink>
                        <button
                          onClick={() => handleDelete(agent.id, agent.name)}
                          disabled={deleteMutation.isPending}
                          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 hover:text-red-600 dark:hover:text-red-400"
                          title="Delete agent"
                        >
                          <XCircle className="w-4 h-4" />
                        </button>
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
              Showing {((page - 1) * pageSize) + 1} to {Math.min(page * pageSize, total)} of {total} agents
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

      {showEnrollModal && enrollToken && (
        <EnrollmentModal
          token={enrollToken}
          onClose={() => { setShowEnrollModal(false); setEnrollToken(null); }}
          onCopyToken={copyToken}
          onCopyCommand={copyInstallCommand}
        />
      )}
    </div>
  );
}

function EnrollmentModal({ token, onClose, onCopyToken, onCopyCommand }: {
  token: EnrollmentToken;
  onClose: () => void;
  onCopyToken: () => void;
  onCopyCommand: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 animate-fade-in">
      <div className="card w-full max-w-2xl max-h-[90vh] overflow-y-auto animate-scale-in">
        <div className="p-6 border-b border-gray-200 dark:border-dark-border flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Enrollment Token Created</h2>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-6 space-y-6">
          <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-500 dark:text-dark-textMuted">Token</span>
              <button onClick={onCopyToken} className="btn-ghost btn-sm">
                <Copy className="w-4 h-4" />
                Copy
              </button>
            </div>
            <code className="text-sm font-mono text-gray-900 dark:text-white break-all bg-white dark:bg-gray-900 p-3 rounded-lg border border-gray-200 dark:border-dark-border block">
              {token.token}
            </code>
          </div>

          <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-500 dark:text-dark-textMuted">Install Command (Linux/macOS)</span>
              <button onClick={onCopyCommand} className="btn-ghost btn-sm">
                <Copy className="w-4 h-4" />
                Copy
              </button>
            </div>
            <code className="text-sm font-mono text-gray-900 dark:text-white break-all bg-white dark:bg-gray-900 p-3 rounded-lg border border-gray-200 dark:border-dark-border block">
              {`curl -sSL https://rmm.mezfashion.pro/install.sh | bash -s -- --token ${token.token}`}
            </code>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-500 dark:text-dark-textMuted">Expires</p>
              <p className="font-medium text-gray-900 dark:text-white">{new Date(token.expires_at).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-gray-500 dark:text-dark-textMuted">Max Uses</p>
              <p className="font-medium text-gray-900 dark:text-white">{token.max_uses}</p>
            </div>
          </div>

          <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <p className="text-sm text-yellow-800 dark:text-yellow-300">
              <strong>Important:</strong> Save this token now. It cannot be retrieved again.
              Use the install command above on target machines to enroll them.
            </p>
          </div>

          <button onClick={onClose} className="btn-primary w-full">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}