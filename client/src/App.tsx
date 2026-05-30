import { AuthProvider, useAuth } from './auth/AuthContext';
import { LoginScreen } from './components/LoginScreen';
import { PipelineDashboard } from './components/PipelineDashboard';

function AppContent() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" />
        <p>Loading...</p>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  return <PipelineDashboard />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
