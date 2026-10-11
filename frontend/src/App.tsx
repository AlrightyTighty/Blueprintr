import { Navigate, Route, Routes } from 'react-router-dom';
import RequireAuth from './components/RequireAuth';
import { DEMO_PROJECT_ID } from './config';
import DashboardPage from './pages/DashboardPage';
import GithubCallbackPage from './pages/GithubCallbackPage';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import NewProjectPage from './pages/NewProjectPage';
import ProjectPage from './pages/ProjectPage';
import RegisterPage from './pages/RegisterPage';
import WorkspacePage from './pages/WorkspacePage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/auth/github/callback" element={<GithubCallbackPage />} />
      {/* The demo needs no account or backend, so it can always be shown. */}
      <Route path="/demo" element={<WorkspacePage projectId={DEMO_PROJECT_ID} title="Demo project" />} />

      <Route element={<RequireAuth />}>
        <Route path="/projects" element={<DashboardPage />} />
        <Route path="/projects/new" element={<NewProjectPage />} />
        <Route path="/projects/:projectId" element={<ProjectPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
