import { LoaderCircle } from "lucide-react";
import { lazy, Suspense } from "react";
import {
  Navigate,
  Route,
  Routes,
  useParams,
} from "react-router";
import { AdminPage } from "@/admin/admin-page";
import { AuthScreen } from "@/auth/auth-screen";
import { useAuth } from "@/auth/auth-context";
import { MailboxRealtimeConnections } from "@/mail/mailbox-realtime";
import { UnreadDocumentIndicator } from "@/mail/unread-document-indicator";
import {
  SettingsAppearancePage,
  SettingsIndexRedirect,
  SettingsNotificationsPage,
  SettingsProfilePage,
  SettingsShell,
} from "@/settings/settings-shell";

const AccessLinkScreen = lazy(() =>
  import("@/auth/access-link-screen").then((module) => ({ default: module.AccessLinkScreen })),
);
const MailShell = lazy(() =>
  import("@/mail/mail-shell").then((module) => ({ default: module.MailShell })),
);
const OidcConsentScreen = lazy(() =>
  import("@/auth/oidc-consent-screen").then((module) => ({
    default: module.OidcConsentScreen,
  })),
);
const OidcLoginScreen = lazy(() =>
  import("@/auth/oidc-login-screen").then((module) => ({
    default: module.OidcLoginScreen,
  })),
);
const OidcLogoutScreen = lazy(() =>
  import("@/auth/oidc-logout-screen").then((module) => ({
    default: module.OidcLogoutScreen,
  })),
);

function MailboxRoute() {
  const { mailboxId } = useParams();
  return <MailShell key={mailboxId ?? "default"} mailboxId={mailboxId} />;
}

function LoadingScreen() {
  return <main className="grid min-h-dvh place-items-center"><LoaderCircle className="animate-spin text-muted-foreground" /></main>;
}

export function App() {
  const auth = useAuth();
  if (auth.loading) return <LoadingScreen />;
  const mail = auth.authenticated ? <MailboxRoute /> : <AuthScreen />;
  const settings = auth.authenticated ? <SettingsShell /> : <Navigate to="/" replace />;
  return (
    <Suspense fallback={<LoadingScreen />}>
      {auth.authenticated ? <MailboxRealtimeConnections /> : null}
      {auth.authenticated ? <UnreadDocumentIndicator /> : null}
      <Routes>
        <Route path="/invite/:token" element={auth.authenticated ? <Navigate to="/" replace /> : <AccessLinkScreen kind="invitation" />} />
        <Route path="/recover/:token" element={auth.authenticated ? <Navigate to="/" replace /> : <AccessLinkScreen kind="recovery" />} />
        <Route path="/oidc/login/:requestId" element={<OidcLoginScreen />} />
        <Route path="/oidc/consent/:requestId" element={auth.authenticated ? <OidcConsentScreen /> : <AuthScreen />} />
        <Route path="/oidc/logout" element={auth.authenticated ? <OidcLogoutScreen /> : <Navigate to="/" replace />} />
        <Route path="/admin" element={auth.authenticated && auth.user?.role === "admin" ? <AdminPage /> : <Navigate to="/" replace />} />
        <Route path="/settings" element={settings}>
          <Route index element={<SettingsIndexRedirect />} />
          <Route path="profile" element={<SettingsProfilePage />} />
          <Route path="appearance" element={<SettingsAppearancePage />} />
          <Route path="notifications" element={<SettingsNotificationsPage />} />
        </Route>
        <Route path="/" element={mail} />
        <Route path="/mail/:mailboxId" element={mail} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
