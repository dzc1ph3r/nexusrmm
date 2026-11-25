import { NavLink } from 'react-router-dom';

interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface SidebarProps {
  navigation: NavItem[];
}

export function Sidebar({ navigation }: SidebarProps) {
  return (
    <aside className="fixed inset-y-0 left-0 z-50 w-64 bg-white dark:bg-dark-card border-r border-gray-200 dark:border-dark-border transform transition-transform duration-200 lg:translate-x-0">
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between h-16 px-4 border-b border-gray-200 dark:border-dark-border">
          <NavLink to="/dashboard" className="flex items-center gap-2 font-semibold text-lg text-gray-900 dark:text-white">
            <svg className="w-8 h-8 text-primary-600" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span>Nexus RMM</span>
          </NavLink>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" aria-label="Main navigation">
          {navigation.map((item) => (
            <NavLink
              key={item.name}
              to={item.href}
              className={({ isActive }) =>
                `sidebar-link ${isActive ? 'active' : ''} group`
              }
              end={item.href === '/dashboard'}
            >
              <item.icon className="w-5 h-5 flex-shrink-0 transition-colors group-hover:text-primary-600 dark:group-hover:text-primary-400" />
              {item.name}
            </NavLink>
          ))}
        </nav>

        <div className="p-4 border-t border-gray-200 dark:border-dark-border">
          <div className="text-xs text-gray-500 dark:text-dark-textMuted">
            Version 1.0.0
          </div>
        </div>
      </div>
    </aside>
  );
}