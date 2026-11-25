import { Link } from 'react-router-dom';
import { Home, Search, AlertTriangle } from 'lucide-react';

export function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-dark-bg px-4">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-24 h-24 rounded-full bg-yellow-100 dark:bg-yellow-900/30 mb-6">
          <AlertTriangle className="w-12 h-12 text-yellow-600 dark:text-yellow-400" />
        </div>
        <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">404</h1>
        <p className="text-xl text-gray-500 dark:text-dark-textMuted mb-6">Page not found</p>
        <p className="text-gray-500 dark:text-dark-textMuted mb-8 max-w-md mx-auto">
          The page you're looking for doesn't exist or has been moved.
          Check the URL or navigate back to the dashboard.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link to="/dashboard" className="btn-primary">
            <Home className="w-4 h-4" />
            Go to Dashboard
          </Link>
          <Link to="/agents" className="btn-secondary">
            <Search className="w-4 h-4" />
            Browse Agents
          </Link>
        </div>
      </div>
    </div>
  );
}