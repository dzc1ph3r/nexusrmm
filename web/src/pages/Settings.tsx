import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../hooks/useAuth';
import {
  Users,
  Shield,
  Mail,
  Server,
  Database,
  Save,
  Plus,
  Trash2,
  Edit2,
  RotateCcw,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Key,
  QrCode,
  X,
} from 'lucide-react';
import { settingsApi, usersApi, authApi, User as UserType } from '../services/api';
import toast from 'react-hot-toast';

type SettingsTab = 'general' | 'users' | 'security' | 'notifications' | 'integrations' | 'advanced';

const SETTINGS_TABS: { id: SettingsTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'general', label: 'General', icon: Server },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'notifications', label: 'Notifications', icon: Mail },
  { id: 'integrations', label: 'Integrations', icon: Database },
  { id: 'advanced', label: 'Advanced', icon: AlertTriangle },
];

export function Settings() {
  const { user, refreshUser } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [showUserModal, setShowUserModal] = useState(false);
  const [editingUser, setEditingUser] = useState<UserType | null>(null);
  const [userForm, setUserForm] = useState({ email: '', name: '', role: 'operator', scopes: [] as string[], password: '' });
  const [mfaSetup, setMfaSetup] = useState<{ secret: string; qr_code: string; backup_codes: string[] } | null>(null);
  const [mfaCode, setMfaCode] = useState('');

  const { data: usersData } = useQuery({
    queryKey: ['users', 'list'],
    queryFn: () => usersApi.list({ page_size: 100 }).then(res => res.data),
    enabled: activeTab === 'users',
  });

  const { data: currentSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.get().then(res => res.data),
    enabled: activeTab === 'general' || activeTab === 'notifications' || activeTab === 'integrations',
  });

  useEffect(() => {
    if (currentSettings) setSettings(currentSettings);
  }, [currentSettings]);

  const updateSettingsMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => settingsApi.update(data),
    onSuccess: () => {
      toast.success('Settings saved');
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err: unknown) => {
      const axiosError = err as { response?: { data?: { error?: string } } };
      toast.error(axiosError.response?.data?.error || 'Failed to save settings');
    },
  });

  const userMutations = {
    create: useMutation({
      mutationFn: (data: any) => usersApi.create(data),
      onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); toast.success('User created'); setShowUserModal(false); },
      onError: (err: unknown) => { const axiosError = err as { response?: { data?: { error?: string } } }; toast.error(axiosError.response?.data?.error || 'Failed to create user'); },
    }),
    update: useMutation({
      mutationFn: ({ id, data }: { id: string; data: any }) => usersApi.update(id, data),
      onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); toast.success('User updated'); setEditingUser(null); },
      onError: (err: unknown) => { const axiosError = err as { response?: { data?: { error?: string } } }; toast.error(axiosError.response?.data?.error || 'Failed to update user'); },
    }),
    delete: useMutation({
      mutationFn: (id: string) => usersApi.delete(id),
      onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); toast.success('User deleted'); },
      onError: (err: unknown) => { const axiosError = err as { response?: { data?: { error?: string } } }; toast.error(axiosError.response?.data?.error || 'Failed to delete user'); },
    }),
    resetMfa: useMutation({
      mutationFn: (id: string) => usersApi.resetMFA(id),
      onSuccess: () => { toast.success('MFA reset for user'); },
      onError: (err: unknown) => { const axiosError = err as { response?: { data?: { error?: string } } }; toast.error(axiosError.response?.data?.error || 'Failed to reset MFA'); },
    }),
  };

  const handleSaveSettings = () => {
    updateSettingsMutation.mutate(settings);
  };

  const openCreateUser = () => {
    setEditingUser(null);
    setUserForm({ email: '', name: '', role: 'operator', scopes: ['agents:read'], password: '' });
    setShowUserModal(true);
  };

  const openEditUser = (user: UserType) => {
    setEditingUser(user);
    setUserForm({ email: user.email, name: user.name, role: user.role, scopes: user.scopes, password: '' });
    setShowUserModal(true);
  };

  const handleUserSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const data = { ...userForm, scopes: userForm.scopes.filter(Boolean) };
    if (editingUser) {
      userMutations.update.mutate({ id: editingUser.id, data });
    } else {
      userMutations.create.mutate(data);
    }
  };

  const handleDeleteUser = (id: string, name: string) => {
    if (confirm(`Delete user "${name}"? This cannot be undone.`)) {
      userMutations.delete.mutate(id);
    }
  };

  const setupMFA = async () => {
    try {
      const { data } = await authApi.setupMFA();
      setMfaSetup(data);
    } catch (err) {
      toast.error('Failed to setup MFA');
    }
  };

  const verifyMFA = async () => {
    try {
      await authApi.verifyMFA(mfaCode);
      toast.success('MFA enabled successfully');
      setMfaSetup(null);
      setMfaCode('');
      refreshUser();
    } catch (err) {
      toast.error('Invalid code');
    }
  };

  const disableMFA = async () => {
    if (!confirm('Disable MFA? This reduces account security.')) return;
    try {
      await authApi.disableMFA(mfaCode);
      toast.success('MFA disabled');
      setMfaCode('');
      refreshUser();
    } catch (err) {
      toast.error('Invalid code');
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
          <p className="text-gray-500 dark:text-dark-textMuted">Configure your Nexus RMM instance</p>
        </div>
        <button onClick={handleSaveSettings} disabled={updateSettingsMutation.isPending} className="btn-primary">
          <Save className="w-4 h-4" />
          Save Changes
        </button>
      </div>

      <div className="card">
        <div className="border-b border-gray-200 dark:border-dark-border">
          <nav className="flex gap-1 p-2 overflow-x-auto" role="tablist" aria-label="Settings tabs">
            {SETTINGS_TABS.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
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

        <div className="p-6" role="tabpanel" aria-labelledby={activeTab}>
          {activeTab === 'general' && <GeneralSettings settings={settings} onChange={setSettings} />}
          {activeTab === 'users' && <UsersSettings users={usersData?.data || []} onCreate={openCreateUser} onEdit={openEditUser} onDelete={handleDeleteUser} onResetMFA={userMutations.resetMfa.mutate} />}
          {activeTab === 'security' && <SecuritySettings user={user!} mfaSetup={mfaSetup} mfaCode={mfaCode} setMfaCode={setMfaCode} setMfaSetup={setMfaSetup} onSetupMFA={setupMFA} onVerifyMFA={verifyMFA} onDisableMFA={disableMFA} />}
          {activeTab === 'notifications' && <NotificationSettings settings={settings} onChange={setSettings} />}
          {activeTab === 'integrations' && <IntegrationSettings settings={settings} onChange={setSettings} />}
          {activeTab === 'advanced' && <AdvancedSettings />}
        </div>
      </div>

      {showUserModal && (
        <UserModal
          user={editingUser}
          form={userForm}
          onChange={setUserForm}
          onSubmit={handleUserSubmit}
          onClose={() => { setShowUserModal(false); setEditingUser(null); }}
        />
      )}
    </div>
  );
}

function GeneralSettings({ settings, onChange }: { settings: Record<string, unknown>; onChange: (s: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-6 max-w-3xl">
      <section>
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <Server className="w-5 h-5 text-primary-600" />
          Server Configuration
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SettingInput
            label="Server Name"
            value={settings.server_name as string}
            onChange={(v) => onChange({ ...settings, server_name: v })}
            placeholder="Nexus RMM"
          />
          <SettingInput
            label="Domain"
            value={settings.domain as string}
            onChange={(v) => onChange({ ...settings, domain: v })}
            placeholder="rmm.example.com"
          />
          <SettingInput
            label="Port (HTTPS)"
            value={settings.port as string}
            onChange={(v) => onChange({ ...settings, port: v })}
            type="number"
            placeholder="443"
          />
          <SettingSelect
            label="Log Level"
            value={settings.log_level as string}
            onChange={(v) => onChange({ ...settings, log_level: v })}
            options={['debug', 'info', 'warn', 'error']}
          />
        </div>
      </section>

      <section>
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <Database className="w-5 h-5 text-primary-600" />
          Database
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SettingInput
            label="PostgreSQL Host"
            value={settings.db_host as string}
            onChange={(v) => onChange({ ...settings, db_host: v })}
            placeholder="localhost"
          />
          <SettingInput
            label="PostgreSQL Port"
            value={settings.db_port as string}
            onChange={(v) => onChange({ ...settings, db_port: v })}
            type="number"
            placeholder="5432"
          />
          <SettingInput
            label="Database Name"
            value={settings.db_name as string}
            onChange={(v) => onChange({ ...settings, db_name: v })}
            placeholder="nexusrmm"
          />
          <SettingInput
            label="Redis Host"
            value={settings.redis_host as string}
            onChange={(v) => onChange({ ...settings, redis_host: v })}
            placeholder="localhost"
          />
        </div>
      </section>

      <section>
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <Key className="w-5 h-5 text-primary-600" />
          TLS / Certificates
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SettingInput
            label="Cert Path"
            value={settings.cert_path as string}
            onChange={(v) => onChange({ ...settings, cert_path: v })}
            placeholder="/etc/nexusrmm/certs/server.crt"
          />
          <SettingInput
            label="Key Path"
            value={settings.key_path as string}
            onChange={(v) => onChange({ ...settings, key_path: v })}
            placeholder="/etc/nexusrmm/certs/server.key"
          />
          <SettingInput
            label="CA Path"
            value={settings.ca_path as string}
            onChange={(v) => onChange({ ...settings, ca_path: v })}
            placeholder="/etc/nexusrmm/certs/ca.crt"
          />
          <SettingCheckbox
            label="Enable mTLS"
            checked={settings.mtls_enabled as boolean}
            onChange={(v) => onChange({ ...settings, mtls_enabled: v })}
          />
        </div>
      </section>
    </div>
  );
}

function UsersSettings({ users, onCreate, onEdit, onDelete, onResetMFA }: { users: UserType[]; onCreate: () => void; onEdit: (u: UserType) => void; onDelete: (id: string, name: string) => void; onResetMFA: (id: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={onCreate} className="btn-primary">
          <Plus className="w-4 h-4" />
          Add User
        </button>
      </div>

      {users.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-dark-textMuted">
          <Users className="w-12 h-12 mx-auto mb-4 opacity-30" />
          <p>No users configured</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800/50">
                <th className="table-header">User</th>
                <th className="table-header">Role</th>
                <th className="table-header hidden md:table-cell">Scopes</th>
                <th className="table-header hidden lg:table-cell">MFA</th>
                <th className="table-header hidden lg:table-cell">Last Login</th>
                <th className="table-header text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-dark-border">
              {users.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="table-cell">
                    <div className="font-medium text-gray-900 dark:text-white">{user.name}</div>
                    <div className="text-sm text-gray-500 dark:text-dark-textMuted">{user.email}</div>
                  </td>
                  <td className="table-cell">
                    <span className={`badge ${user.role === 'admin' ? 'badge-danger' : user.role === 'operator' ? 'badge-info' : 'badge-gray'}`}>
                      {user.role}
                    </span>
                  </td>
                  <td className="table-cell hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {user.scopes.map((scope) => (
                        <span key={scope} className="badge badge-gray text-xs">{scope}</span>
                      ))}
                    </div>
                  </td>
                  <td className="table-cell hidden lg:table-cell">
                    {user.mfa_enabled ? (
                      <CheckCircle className="w-5 h-5 text-green-500" />
                    ) : (
                      <XCircle className="w-5 h-5 text-gray-400" />
                    )}
                  </td>
                  <td className="table-cell hidden lg:table-cell text-sm text-gray-500 dark:text-dark-textMuted">
                    {user.last_login ? new Date(user.last_login).toLocaleString() : 'Never'}
                  </td>
                  <td className="table-cell text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => onEdit(user)} className="btn-ghost btn-sm">
                        <Edit2 className="w-4 h-4" />
                      </button>
                      {!user.mfa_enabled && (
                        <button onClick={() => onResetMFA(user.id)} className="btn-ghost btn-sm text-orange-600 hover:text-orange-700">
                          <RotateCcw className="w-4 h-4" />
                        </button>
                      )}
                      <button onClick={() => onDelete(user.id, user.name)} className="btn-ghost btn-sm text-red-600 hover:text-red-700">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SecuritySettings({ user, mfaSetup, mfaCode, setMfaCode, setMfaSetup, onSetupMFA, onVerifyMFA, onDisableMFA }: {
  user: UserType;
  mfaSetup: { secret: string; qr_code: string; backup_codes: string[] } | null;
  mfaCode: string;
  setMfaCode: (c: string) => void;
  setMfaSetup: (v: { secret: string; qr_code: string; backup_codes: string[] } | null) => void;
  onSetupMFA: () => void;
  onVerifyMFA: () => void;
  onDisableMFA: () => void;
}) {
  if (mfaSetup) {
    return (
      <div className="max-w-md">
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <Shield className="w-5 h-5 text-primary-600" />
          Setup Two-Factor Authentication
        </h3>
        <div className="card p-6 space-y-4">
          <div className="text-center">
            <img src={mfaSetup.qr_code} alt="MFA QR Code" className="mx-auto mb-4" />
            <p className="text-sm text-gray-500 dark:text-dark-textMuted">Scan with your authenticator app</p>
          </div>
          <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg font-mono text-sm text-center break-all">
            {mfaSetup.secret}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Enter 6-digit code</label>
            <input
              type="text"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              className="input text-center text-lg tracking-widest font-mono"
              maxLength={6}
              placeholder="••••••"
              autoFocus
            />
          </div>
          <div className="flex gap-3">
            <button onClick={onVerifyMFA} className="btn-primary flex-1">Verify & Enable</button>
            <button onClick={() => setMfaSetup(null)} className="btn-secondary">Cancel</button>
          </div>
          <details className="text-sm">
            <summary className="text-gray-500 dark:text-dark-textMuted cursor-pointer">Show backup codes</summary>
            <div className="mt-2 p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg font-mono text-xs space-y-1">
              {mfaSetup.backup_codes.map((code, i) => (
                <div key={i} className="flex justify-between">
                  <span>{i + 1}.</span>
                  <code>{code}</code>
                </div>
              ))}
            </div>
          </details>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <section>
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <Shield className="w-5 h-5 text-primary-600" />
          Two-Factor Authentication
        </h3>
        <div className="card p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-gray-900 dark:text-white">MFA Status</p>
              <p className="text-sm text-gray-500 dark:text-dark-textMuted">
                {user.mfa_enabled ? 'Enabled - Your account is protected with two-factor authentication' : 'Disabled - Enable MFA for additional security'}
              </p>
            </div>
            {user.mfa_enabled ? (
              <button onClick={onDisableMFA} className="btn-danger">
                Disable MFA
              </button>
            ) : (
              <button onClick={onSetupMFA} className="btn-primary">
                <QrCode className="w-4 h-4" />
                Enable MFA
              </button>
            )}
          </div>
        </div>
      </section>

      <section>
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <Key className="w-5 h-5 text-primary-600" />
          Password
        </h3>
        <div className="card p-6">
          <p className="text-sm text-gray-500 dark:text-dark-textMuted mb-4">
            Change your account password. You'll need to enter your current password.
          </p>
          <form className="space-y-4 max-w-md">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Current Password</label>
              <input type="password" className="input" placeholder="••••••••" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">New Password</label>
              <input type="password" className="input" placeholder="••••••••" minLength={12} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Confirm New Password</label>
              <input type="password" className="input" placeholder="••••••••" />
            </div>
            <button type="submit" className="btn-primary">Update Password</button>
          </form>
        </div>
      </section>

      <section>
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <RotateCcw className="w-5 h-5 text-primary-600" />
          Session Management
        </h3>
        <div className="card p-6">
          <div className="space-y-3">
            <SettingCheckbox label="Auto-lock after inactivity" checked={false} onChange={() => {}} />
            <SettingInput label="Auto-lock timeout (minutes)" value="15" onChange={() => {}} type="number" />
            <SettingCheckbox label="Revoke sessions on password change" checked={true} onChange={() => {}} />
            <SettingCheckbox label="Revoke sessions on MFA change" checked={true} onChange={() => {}} />
          </div>
        </div>
      </section>
    </div>
  );
}

function NotificationSettings({ settings, onChange }: { settings: Record<string, unknown>; onChange: (s: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-6 max-w-3xl">
      <section>
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <Mail className="w-5 h-5 text-primary-600" />
          Email (SMTP)
        </h3>
        <div className="card p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SettingInput label="SMTP Host" value={settings.smtp_host as string} onChange={(v) => onChange({ ...settings, smtp_host: v })} placeholder="smtp.example.com" />
            <SettingInput label="SMTP Port" value={settings.smtp_port as string} onChange={(v) => onChange({ ...settings, smtp_port: v })} type="number" placeholder="587" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SettingInput label="Username" value={settings.smtp_username as string} onChange={(v) => onChange({ ...settings, smtp_username: v })} placeholder="user@example.com" />
            <SettingInput label="Password" value={settings.smtp_password as string} onChange={(v) => onChange({ ...settings, smtp_password: v })} type="password" placeholder="••••••••" />
          </div>
          <SettingInput label="From Address" value={settings.smtp_from as string} onChange={(v) => onChange({ ...settings, smtp_from: v })} placeholder="noreply@example.com" />
          <SettingCheckbox label="Use TLS" checked={settings.smtp_tls as boolean} onChange={(v) => onChange({ ...settings, smtp_tls: v })} />
          <button onClick={() => settingsApi.testSMTP(settings as any).then(() => toast.success('Test email sent')).catch(() => toast.error('Test failed'))} className="btn-secondary">
            Send Test Email
          </button>
        </div>
      </section>

      <section>
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-primary-600" />
          Alert Rules
        </h3>
        <div className="card p-6">
          <p className="text-sm text-gray-500 dark:text-dark-textMuted mb-4">Configure when to send notifications</p>
          <div className="space-y-3">
            <SettingCheckbox label="Agent offline" checked={true} onChange={() => {}} />
            <SettingCheckbox label="Agent back online" checked={true} onChange={() => {}} />
            <SettingCheckbox label="High CPU usage (>90%)" checked={false} onChange={() => {}} />
            <SettingCheckbox label="High memory usage (>90%)" checked={false} onChange={() => {}} />
            <SettingCheckbox label="Disk space critical (<10%)" checked={true} onChange={() => {}} />
            <SettingCheckbox label="New agent enrollment" checked={true} onChange={() => {}} />
            <SettingCheckbox label="Script execution failed" checked={true} onChange={() => {}} />
          </div>
        </div>
      </section>
    </div>
  );
}

function IntegrationSettings({ settings, onChange }: { settings: Record<string, unknown>; onChange: (s: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-6 max-w-3xl">
      <section>
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <Database className="w-5 h-5 text-primary-600" />
          LDAP / Active Directory
        </h3>
        <div className="card p-6 space-y-4">
          <SettingCheckbox label="Enable LDAP" checked={settings.ldap_enabled as boolean} onChange={(v) => onChange({ ...settings, ldap_enabled: v })} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SettingInput label="LDAP URL" value={settings.ldap_url as string} onChange={(v) => onChange({ ...settings, ldap_url: v })} placeholder="ldap://ldap.example.com:389" />
            <SettingInput label="Base DN" value={settings.ldap_base_dn as string} onChange={(v) => onChange({ ...settings, ldap_base_dn: v })} placeholder="dc=example,dc=com" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SettingInput label="Bind DN" value={settings.ldap_bind_dn as string} onChange={(v) => onChange({ ...settings, ldap_bind_dn: v })} placeholder="cn=admin,dc=example,dc=com" />
            <SettingInput label="Bind Password" value={settings.ldap_bind_password as string} onChange={(v) => onChange({ ...settings, ldap_bind_password: v })} type="password" placeholder="••••••••" />
          </div>
          <SettingInput label="User Filter" value={settings.ldap_user_filter as string} onChange={(v) => onChange({ ...settings, ldap_user_filter: v })} placeholder="(sAMAccountName={username})" />
          <SettingInput label="Group Filter" value={settings.ldap_group_filter as string} onChange={(v) => onChange({ ...settings, ldap_group_filter: v })} placeholder="(member={userDN})" />
          <SettingSelect
            label="Default Role"
            value={settings.ldap_default_role as string}
            onChange={(v) => onChange({ ...settings, ldap_default_role: v })}
            options={['viewer', 'operator', 'admin']}
          />
          <button onClick={() => settingsApi.testLDAP(settings as any).then(() => toast.success('LDAP connection successful')).catch(() => toast.error('LDAP connection failed'))} className="btn-secondary">
            Test LDAP Connection
          </button>
        </div>
      </section>

      <section>
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <RotateCcw className="w-5 h-5 text-primary-600" />
          Webhooks
        </h3>
        <div className="card p-6">
          <p className="text-sm text-gray-500 dark:text-dark-textMuted mb-4">Configure webhook endpoints for real-time events</p>
          <div className="space-y-3">
            <SettingInput label="Agent Events Webhook" value={settings.webhook_agent_events as string} onChange={(v) => onChange({ ...settings, webhook_agent_events: v })} placeholder="https://example.com/webhooks/agents" />
            <SettingInput label="Session Events Webhook" value={settings.webhook_session_events as string} onChange={(v) => onChange({ ...settings, webhook_session_events: v })} placeholder="https://example.com/webhooks/sessions" />
            <SettingInput label="Audit Events Webhook" value={settings.webhook_audit_events as string} onChange={(v) => onChange({ ...settings, webhook_audit_events: v })} placeholder="https://example.com/webhooks/audit" />
            <SettingInput label="Webhook Secret" value={settings.webhook_secret as string} onChange={(v) => onChange({ ...settings, webhook_secret: v })} type="password" placeholder="••••••••" />
          </div>
        </div>
      </section>
    </div>
  );
}

function AdvancedSettings() {
  return (
    <div className="space-y-6 max-w-3xl">
      <section>
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-primary-600" />
          Danger Zone
        </h3>
        <div className="card p-6 border-red-200 dark:border-red-800">
          <p className="text-sm text-gray-500 dark:text-dark-textMuted mb-4">These actions are irreversible. Use with extreme caution.</p>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-red-50 dark:bg-red-900/20 rounded-lg">
              <div>
                <p className="font-medium text-red-800 dark:text-red-300">Purge All Audit Logs</p>
                <p className="text-sm text-red-600 dark:text-red-400">Permanently delete all audit log entries. This cannot be undone.</p>
              </div>
              <button className="btn-danger">Purge Logs</button>
            </div>
            <div className="flex items-center justify-between p-4 bg-red-50 dark:bg-red-900/20 rounded-lg">
              <div>
                <p className="font-medium text-red-800 dark:text-red-300">Reset Database</p>
                <p className="text-sm text-red-600 dark:text-red-400">Drop all tables and re-run migrations. All data will be lost.</p>
              </div>
              <button className="btn-danger">Reset Database</button>
            </div>
            <div className="flex items-center justify-between p-4 bg-red-50 dark:bg-red-900/20 rounded-lg">
              <div>
                <p className="font-medium text-red-800 dark:text-red-300">Revoke All Sessions</p>
                <p className="text-sm text-red-600 dark:text-red-400">Force logout all users and terminate all active agent sessions.</p>
              </div>
              <button className="btn-danger">Revoke All</button>
            </div>
          </div>
        </div>
      </section>

      <section>
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <Database className="w-5 h-5 text-primary-600" />
          Maintenance
        </h3>
        <div className="card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-gray-900 dark:text-white">Vacuum Database</p>
              <p className="text-sm text-gray-500 dark:text-dark-textMuted">Reclaim storage and optimize database performance</p>
            </div>
            <button className="btn-secondary">Run Vacuum</button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-gray-900 dark:text-white">Rebuild Search Index</p>
              <p className="text-sm text-gray-500 dark:text-dark-textMuted">Reindex all agent data for faster searches</p>
            </div>
            <button className="btn-secondary">Rebuild Index</button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-gray-900 dark:text-white">Clean Temp Files</p>
              <p className="text-sm text-gray-500 dark:text-dark-textMuted">Remove temporary files older than 7 days</p>
            </div>
            <button className="btn-secondary">Clean Temp</button>
          </div>
        </div>
      </section>

      <section>
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <Key className="w-5 h-5 text-primary-600" />
          API Keys
        </h3>
        <div className="card p-6">
          <p className="text-sm text-gray-500 dark:text-dark-textMuted mb-4">Manage API keys for external integrations</p>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
              <div>
                <p className="font-medium text-gray-900 dark:text-white">Default API Key</p>
                <p className="text-sm text-gray-500 dark:text-dark-textMuted font-mono">nrm_••••••••••••••••</p>
              </div>
              <button className="btn-ghost btn-sm">Regenerate</button>
            </div>
            <button className="btn-secondary">
              <Plus className="w-4 h-4" />
              Create New API Key
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function UserModal({ user, form, onChange, onSubmit, onClose }: {
  user: UserType | null;
  form: { email: string; name: string; role: string; scopes: string[]; password: string };
  onChange: (f: any) => void;
  onSubmit: (e: React.FormEvent) => void;
  onClose: () => void;
}) {
  const roles = ['admin', 'operator', 'viewer'];
  const allScopes = ['agents:read', 'agents:write', 'agents:delete', 'sessions:create', 'sessions:terminate', 'scripts:run', 'files:read', 'files:write', 'users:read', 'users:write', 'settings:read', 'settings:write', 'audit:read'];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 animate-fade-in">
      <div className="card w-full max-w-2xl max-h-[90vh] overflow-y-auto animate-scale-in">
        <div className="p-6 border-b border-gray-200 dark:border-dark-border flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{user ? 'Edit User' : 'Create User'}</h2>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={onSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Email</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => onChange({ ...form, email: e.target.value })}
              className="input"
              placeholder="user@example.com"
              required
              disabled={!!user}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => onChange({ ...form, name: e.target.value })}
              className="input"
              placeholder="John Doe"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Role</label>
            <select
              value={form.role}
              onChange={(e) => onChange({ ...form, role: e.target.value })}
              className="input"
            >
              {roles.map((role) => (
                <option key={role} value={role}>{role.charAt(0).toUpperCase() + role.slice(1)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Scopes</label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {allScopes.map((scope) => (
                <label key={scope} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.scopes.includes(scope)}
                    onChange={(e) => onChange({ ...form, scopes: e.target.checked ? [...form.scopes, scope] : form.scopes.filter(s => s !== scope) })}
                    className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                  />
                  <span className="font-mono text-xs">{scope}</span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              {user ? 'New Password (leave blank to keep current)' : 'Password'}
            </label>
            <input
              type="password"
              value={form.password}
              onChange={(e) => onChange({ ...form, password: e.target.value })}
              className="input"
              placeholder="••••••••"
              minLength={user ? 0 : 12}
              required={!user}
            />
          </div>
          <div className="flex justify-end gap-3 pt-4">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary">
              {user ? 'Update User' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Helper components
function SettingInput({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{label}</label>
      <input
        type={type}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="input"
        placeholder={placeholder}
      />
    </div>
  );
}

function SettingSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: string[];
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{label}</label>
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="input"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt.charAt(0).toUpperCase() + opt.slice(1)}</option>
        ))}
      </select>
    </div>
  );
}

function SettingCheckbox({ label, checked, onChange }: {
  label: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
      />
      <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
    </label>
  );
}