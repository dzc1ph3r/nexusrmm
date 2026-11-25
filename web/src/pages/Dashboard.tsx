import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  Server,
  HardDrive,
  MemoryStick,
  Cpu,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Loader2,
} from 'lucide-react';
import { agentsApi } from '../services/api';

const STAT_CARDS = [
  { name: 'Total Agents', key: 'total', icon: Server, color: 'text-blue-600', bg: 'bg-blue-100 dark:bg-blue-900/30' },
  { name: 'Online', key: 'online', icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-100 dark:bg-green-900/30' },
  { name: 'Offline', key: 'offline', icon: XCircle, color: 'text-red-600', bg: 'bg-red-100 dark:bg-red-900/30' },
  { name: 'Maintenance', key: 'maintenance', icon: AlertTriangle, color: 'text-yellow-600', bg: 'bg-yellow-100 dark:bg-yellow-900/30' },
];

export function Dashboard() {
  const { data: agentsData, isLoading, error, refetch } = useQuery({
    queryKey: ['agents', 'list', { page_size: 1000 }],
    queryFn: () => agentsApi.list({ page_size: 1000 }).then(res => res.data),
    refetchInterval: 30000,
  });

  const agents = agentsData?.data || [];
  const stats = {
    total: agents.length,
    online: agents.filter(a => a.status === 'online').length,
    offline: agents.filter(a => a.status === 'offline').length,
    maintenance: agents.filter(a => a.status === 'maintenance').length,
  };

  const recentAgents = agents
    .sort((a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime())
    .slice(0, 5);

  const osDistribution = agents.reduce((acc, agent) => {
    acc[agent.os] = (acc[agent.os] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
            <p className="text-gray-500 dark:text-dark-textMuted">Fleet overview and system health</p>
          </div>
          <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {STAT_CARDS.map(() => (
            <div key={Math.random()} className="card p-6 animate-pulse">
              <div className="h-6 w-24 bg-gray-200 dark:bg-gray-700 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-8 text-center">
        <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">Failed to load dashboard</h3>
        <button onClick={() => refetch()} className="btn-primary mt-4">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
          <p className="text-gray-500 dark:text-dark-textMuted">Fleet overview and system health</p>
        </div>
        <button onClick={() => refetch()} className="btn-secondary">
          <Loader2 className="w-4 h-4" />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {STAT_CARDS.map((stat) => (
          <div key={stat.key} className="card p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500 dark:text-dark-textMuted">{stat.name}</p>
                <p className="text-3xl font-bold text-gray-900 dark:text-white mt-1">
                  {stats[stat.key as keyof typeof stats]}
                </p>
              </div>
              <div className={`p-3 rounded-xl ${stat.bg}`}>
                <stat.icon className={`w-6 h-6 ${stat.color}`} />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <div className="p-4 border-b border-gray-200 dark:border-dark-border">
            <h3 className="font-semibold text-gray-900 dark:text-white">Recent Agents</h3>
          </div>
          <div className="divide-y divide-gray-200 dark:divide-dark-border">
            {recentAgents.length === 0 ? (
              <div className="p-8 text-center text-gray-500 dark:text-dark-textMuted">
                No agents enrolled yet
              </div>
            ) : (
              recentAgents.map((agent) => (
                <div key={agent.id} className="p-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full ${
                      agent.status === 'online' ? 'bg-green-500' :
                      agent.status === 'offline' ? 'bg-red-500' :
                      'bg-yellow-500'
                    }`} />
                    <div>
                      <p className="font-medium text-gray-900 dark:text-white">{agent.name}</p>
                      <p className="text-sm text-gray-500 dark:text-dark-textMuted">
                        {agent.hostname} • {agent.os} {agent.os_version}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className={`badge ${
                      agent.status === 'online' ? 'badge-success' :
                      agent.status === 'offline' ? 'badge-danger' :
                      'badge-warning'
                    }`}>
                      {agent.status}
                    </span>
                    <p className="text-xs text-gray-500 dark:text-dark-textMuted mt-1">
                      {formatDistanceToNow(new Date(agent.last_seen), { addSuffix: true })}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="card">
          <div className="p-4 border-b border-gray-200 dark:border-dark-border">
            <h3 className="font-semibold text-gray-900 dark:text-white">OS Distribution</h3>
          </div>
          <div className="p-4">
            {Object.entries(osDistribution).length === 0 ? (
              <div className="text-center text-gray-500 dark:text-dark-textMuted py-8">No data</div>
            ) : (
              <div className="space-y-3">
                {Object.entries(osDistribution).map(([os, count]) => (
                  <div key={os} className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded ${
                        os.toLowerCase().includes('windows') ? 'bg-blue-500' :
                        os.toLowerCase().includes('linux') ? 'bg-orange-500' :
                        os.toLowerCase().includes('darwin') || os.toLowerCase().includes('mac') ? 'bg-gray-500' :
                        'bg-purple-500'
                      }`} />
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{os}</span>
                    </div>
                    <span className="text-sm text-gray-500 dark:text-dark-textMuted">{count} agents</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="p-4 border-b border-gray-200 dark:border-dark-border">
          <h3 className="font-semibold text-gray-900 dark:text-white">System Health</h3>
        </div>
        <div className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <HealthMetric
              label="CPU Usage"
              value={`${Math.round(agents.reduce((sum, a) => sum + (a.cpu_usage || 0), 0) / Math.max(agents.length, 1))}%`}
              icon={Cpu}
              trend="stable"
            />
            <HealthMetric
              label="Memory Usage"
              value={`${Math.round(agents.reduce((sum, a) => sum + (a.memory_usage || 0), 0) / Math.max(agents.length, 1))}%`}
              icon={MemoryStick}
              trend="stable"
            />
            <HealthMetric
              label="Disk Usage"
              value={`${Math.round(agents.reduce((sum, a) => sum + (a.disk_usage || 0), 0) / Math.max(agents.length, 1))}%`}
              icon={HardDrive}
              trend="stable"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function HealthMetric({ label, value, icon: Icon, trend }: { label: string; value: string; icon: React.ComponentType<{ className?: string }>; trend: 'up' | 'down' | 'stable' }) {
  return (
    <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-xl">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 bg-primary-100 dark:bg-primary-900/30 rounded-lg">
          <Icon className="w-5 h-5 text-primary-600 dark:text-primary-400" />
        </div>
        <span className="text-sm font-medium text-gray-500 dark:text-dark-textMuted">{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold text-gray-900 dark:text-white">{value}</span>
        <span className={`text-xs font-medium ${
          trend === 'up' ? 'text-red-500' :
          trend === 'down' ? 'text-green-500' :
          'text-gray-500'
        }`}>
          {trend === 'up' && '↑'} {trend === 'down' && '↓'} {trend === 'stable' && '→'} Stable
        </span>
      </div>
    </div>
  );
}