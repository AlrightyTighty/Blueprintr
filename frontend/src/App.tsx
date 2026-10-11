import { Navigate, Route, Routes } from 'react-router-dom';
import RequireAuth from './components/RequireAuth';
import { DEMO_PROJECT_ID } from './config';
import DashboardPage from './pages/DashboardPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import GithubCallbackPage from './pages/GithubCallbackPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import NewProjectPage from './pages/NewProjectPage';
import ProjectPage from './pages/ProjectPage';
import InvitePage from './pages/InvitePage';
import RegisterPage from './pages/RegisterPage';
import SharedProjectPage from './pages/SharedProjectPage';
import WorkspacePage from './pages/WorkspacePage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/auth/github/callback" element={<GithubCallbackPage />} />
      {/* Reachable without an account: what an invitation is for, and a project shared by read-only link. */}
      <Route path="/invites/:token" element={<InvitePage />} />
      <Route path="/shared/:shareToken" element={<SharedProjectPage />} />
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
