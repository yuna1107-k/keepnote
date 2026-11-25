import { lazy, StrictMode, Suspense, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { inApp } from './appBridge';
import { AuthProvider, useAuth } from './auth/AuthContext';
import LoginPage from './auth/LoginPage';
import RegisterPage from './auth/RegisterPage';
import WorkspacePicker from './workspace/WorkspacePicker';
import { Spinner, UiProvider } from './ui';
import { installChunkErrorReload, UpdateBanner } from './version';
import './install';
import '@blocknote/core/fonts/inter.css';
import 'material-symbols/outlined.css';
import './styles.css';

const WorkspaceLayout = lazy(() => import('./workspace/WorkspaceLayout'));
const Home = lazy(() => import('./workspace/Home'));
const PageView = lazy(() => import('./workspace/PageView'));
const AccountSettings = lazy(() => import('./workspace/AccountSettings'));
const HelpPage = lazy(() => import('./workspace/Help'));
const Tasks = lazy(() => import('./workspace/Tasks'));
const Graph = lazy(() => import('./workspace/Graph'));
const TemplatesPage = lazy(() => import('./workspace/TemplatesPage'));
const ImportPage = lazy(() => import('./workspace/ImportPage'));
const ShareReceive = lazy(() => import('./workspace/ShareReceive'));
const NewPageShortcut = lazy(() => import('./workspace/ShareReceive').then((m) => ({ default: m.NewPageShortcut })));
const WorkspaceSettings = lazy(() => import('./workspace/Workspaces').then((m) => ({ default: m.WorkspaceSettings })));
const AdminLayout = lazy(() => import('./admin/AdminLayout'));
const AdminDashboard = lazy(() => import('./admin/Dashboard'));
const AdminUsers = lazy(() => import('./admin/Users'));
const AdminUserDetail = lazy(() => import('./admin/UserDetail'));
const AdminLinks = lazy(() => import('./admin/Links'));
const AdminAudit = lazy(() => import('./admin/Audit'));
const AdminSettings = lazy(() => import('./admin/Settings'));
const AdminPublicPages = lazy(() => import('./admin/PublicPages'));
const AdminWorkspaces = lazy(() => import('./admin/Workspaces'));
const AdminWorkspaceDetail = lazy(() => import('./admin/WorkspaceDetail'));
const AdminGroups = lazy(() => import('./admin/Groups'));
const AdminReleases = lazy(() => import('./admin/Releases'));
const PublicPage = lazy(() => import('./share/PublicPage'));
const SlugGate = lazy(() => import('./share/SlugGate'));
const ApproveLogin = lazy(() => import('./auth/ApproveLogin'));

function RequireAuth({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { loading, user } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner center />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (admin && user.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

/**
 * ログイン後の画面の外枠（サイドバー）。管理者画面・通常のページ・カスタム URL のページで共通にして、
 * 行き来しても作り直さない（読み込み直さない）。未ログインでもカスタム URL のページは公開ページとして表示する。
 */
function AppShell() {
  const { loading, user } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner center />;
  if (!user) {
    const seg = location.pathname.split('/').filter(Boolean);
    const isPageUrl = seg.length >= 2 && !['p', 'admin', 'settings', 'workspace'].includes(seg[0]!);
    if (isPageUrl) return <Outlet />;
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <WorkspaceLayout />;
}

/**
 * Android アプリから、読み込み直さずにページを切り替えられるようにする（window.__appNavigate）。
 * アプリは編集画面を 1 つだけ作って使い回し、ノートを開くたびにここから切り替える。
 */
function AppNavigateBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!inApp) return;
    (window as unknown as { __appNavigate?: (path: string) => void }).__appNavigate = (path) => navigate(path, { replace: true });
  }, [navigate]);
  return null;
}

function App() {
  return (
    <Suspense fallback={<Spinner center />}>
      <AppNavigateBridge />
      <Routes>
        {/* アプリでノートを閉じているあいだの、何も表示しない画面 */}
        <Route path="/app-idle" element={null} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          path="/approve-login"
          element={
            <RequireAuth>
              <Suspense fallback={<Spinner center />}>
                <ApproveLogin />
              </Suspense>
            </RequireAuth>
          }
        />
        <Route path="/workspaces" element={<WorkspacePicker />} />
        <Route path="/share/:slug" element={<PublicPage />} />
        <Route path="/share/:slug/:pageId" element={<PublicPage />} />
        <Route path="/" element={<AppShell />}>
          <Route index element={<Home />} />
          <Route path="p/:id" element={<PageView />} />
          <Route path="settings" element={<AccountSettings />} />
          <Route path="help" element={<HelpPage />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="graph" element={<Graph />} />
          <Route path="templates" element={<TemplatesPage />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="share-received" element={<ShareReceive />} />
          <Route path="new" element={<NewPageShortcut />} />
          {/* /<ワークスペースのURL名>/<ページのURL>（静的なパスより優先度が低いので、他の画面とは衝突しない） */}
          <Route path=":wsSlug/:pageSlug" element={<SlugGate />} />
          <Route path=":wsSlug/:pageSlug/:subId" element={<SlugGate />} />
          <Route path="workspace" element={<WorkspaceSettings />} />
            <Route
                  path="admin"
                  element={
                    <RequireAuth admin>
                      <AdminLayout />
                    </RequireAuth>
                  }
                >
                  <Route index element={<AdminDashboard />} />
                  <Route path="users" element={<AdminUsers />} />
                  <Route path="users/:id" element={<AdminUserDetail />} />
                  <Route path="links" element={<AdminLinks />} />
                  <Route path="public" element={<AdminPublicPages />} />
                  <Route path="workspaces" element={<AdminWorkspaces />} />
                  <Route path="workspaces/:id" element={<AdminWorkspaceDetail />} />
                  <Route path="groups" element={<AdminGroups />} />
                  <Route path="releases" element={<AdminReleases />} />
                  <Route path="audit" element={<AdminAudit />} />
                  <Route path="settings" element={<AdminSettings />} />
                </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

installChunkErrorReload();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <UiProvider>
        <AuthProvider>
          <App />
          <UpdateBanner />
        </AuthProvider>
      </UiProvider>
    </BrowserRouter>
  </StrictMode>,
);

// オフラインでも読めるようにする（本番のみ。開発中は古い内容が残って紛らわしいため使わない）
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
