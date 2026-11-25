import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, AlertCircle, Loader2, Shield } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import toast from 'react-hot-toast';

export function Login() {
  const navigate = useNavigate();
  const { login, isLoading: authLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showTotp, setShowTotp] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'credentials' | 'totp'>('credentials');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    try {
      if (step === 'credentials') {
        await login(email, password);
        navigate('/dashboard');
        toast.success('Welcome back!');
      } else {
        await login(email, password, totp);
        navigate('/dashboard');
        toast.success('Welcome back!');
      }
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string; mfa_required?: boolean } } };
      if (axiosError.response?.data?.mfa_required) {
        setShowTotp(true);
        setStep('totp');
        setError('');
      } else {
        setError(axiosError.response?.data?.error || 'Login failed. Please check your credentials.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center dark:bg-dark-bg">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-dark-bg px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary-100 dark:bg-primary-900/30 mb-4">
            <Shield className="w-10 h-10 text-primary-600 dark:text-primary-400" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Nexus RMM</h1>
          <p className="text-gray-500 dark:text-dark-textMuted mt-2">Sign in to your account</p>
        </div>

        <div className="card p-6 animate-fade-in">
          <form onSubmit={handleSubmit}>
            {error && (
              <div className="mb-4 flex items-center gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400 text-sm animate-slide-in">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {step === 'credentials' && (
              <>
                <div className="mb-4">
                  <label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="input"
                    placeholder="admin@company.com"
                    required
                    autoComplete="email"
                    disabled={isSubmitting}
                  />
                </div>

                <div className="mb-6">
                  <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="input pr-10"
                      placeholder="••••••••"
                      required
                      autoComplete="current-password"
                      disabled={isSubmitting}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="btn-primary w-full py-3"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Signing in...
                    </>
                  ) : (
                    'Sign in'
                  )}
                </button>
              </>
            )}

            {step === 'totp' && (
              <>
                <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                  <div className="flex items-center gap-2 text-blue-800 dark:text-blue-300 text-sm">
                    <Shield className="w-5 h-5 flex-shrink-0" />
                    <span>Two-factor authentication required</span>
                  </div>
                </div>

                <div className="mb-6">
                  <label htmlFor="totp" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                    Authentication Code
                  </label>
                  <div className="relative">
                    <input
                      id="totp"
                      type={showTotp ? 'text' : 'password'}
                      value={totp}
                      onChange={(e) => setTotp(e.target.value)}
                      className="input pr-10 text-center text-lg tracking-widest font-mono"
                      placeholder="••••••"
                      required
                      autoComplete="one-time-code"
                      disabled={isSubmitting}
                      maxLength={6}
                    />
                    <button
                      type="button"
                      onClick={() => setShowTotp(!showTotp)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                      aria-label={showTotp ? 'Hide code' : 'Show code'}
                    >
                      {showTotp ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                  <p className="mt-1.5 text-xs text-gray-500 dark:text-dark-textMuted">
                    Enter the 6-digit code from your authenticator app
                  </p>
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting || totp.length !== 6}
                  className="btn-primary w-full py-3"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    'Verify'
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setStep('credentials');
                    setShowTotp(false);
                    setTotp('');
                    setError('');
                  }}
                  className="btn-ghost w-full mt-3"
                  disabled={isSubmitting}
                >
                  Back to password
                </button>
              </>
            )}
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-gray-500 dark:text-dark-textMuted">
          Demo credentials: <code className="font-mono text-gray-700 dark:text-gray-300">admin@nexus.local</code> / <code className="font-mono text-gray-700 dark:text-gray-300">admin123</code>
        </p>
      </div>
    </div>
  );
}