import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AppFrame } from '@/components/AppFrame/AppFrame';
import { MainEditor } from '@/components/MainEditor/MainEditor';
import { SettingsLayout } from '@/components/ServerTab/ServerTab';
import { Sidebar } from '@/components/Sidebar';
import { Toaster } from '@/components/ui/toaster';
import { useGenerationProgress } from '@/lib/hooks/useGenerationProgress';
import { useModelDownloadToast } from '@/lib/hooks/useModelDownloadToast';
import { MODEL_DISPLAY_NAMES, useRestoreActiveTasks } from '@/lib/hooks/useRestoreActiveTasks';

// Opening the sound library should not parse every editor/settings screen.
const CapturesTab = lazyRouteComponent(() => import('@/components/CapturesTab/CapturesTab'), 'CapturesTab');
const EffectsTab = lazyRouteComponent(() => import('@/components/EffectsTab/EffectsTab'), 'EffectsTab');
const ModelsTab = lazyRouteComponent(() => import('@/components/ModelsTab/ModelsTab'), 'ModelsTab');
const AboutPage = lazyRouteComponent(() => import('@/components/ServerTab/AboutPage'), 'AboutPage');
const CapturesPage = lazyRouteComponent(() => import('@/components/ServerTab/CapturesPage'), 'CapturesPage');
const ChangelogPage = lazyRouteComponent(() => import('@/components/ServerTab/ChangelogPage'), 'ChangelogPage');
const GeneralPage = lazyRouteComponent(() => import('@/components/ServerTab/GeneralPage'), 'GeneralPage');
const GenerationPage = lazyRouteComponent(() => import('@/components/ServerTab/GenerationPage'), 'GenerationPage');
const GpuPage = lazyRouteComponent(() => import('@/components/ServerTab/GpuPage'), 'GpuPage');
const LogsPage = lazyRouteComponent(() => import('@/components/ServerTab/LogsPage'), 'LogsPage');
const MCPPage = lazyRouteComponent(() => import('@/components/ServerTab/MCPPage'), 'MCPPage');
const StoriesTab = lazyRouteComponent(() => import('@/components/StoriesTab/StoriesTab'), 'StoriesTab');
const VoicesTab = lazyRouteComponent(() => import('@/components/VoicesTab/VoicesTab'), 'VoicesTab');
const WorkbenchTab = lazyRouteComponent(() => import('@/components/WorkbenchTab/WorkbenchTab'), 'WorkbenchTab');

// Simple platform check that works in both web and Tauri
const isMacOS = () => navigator.platform.toLowerCase().includes('mac');

// Root layout component
function RootLayout() {
  // Monitor active downloads/generations and show toasts for them
  const activeDownloads = useRestoreActiveTasks();

  // Batch pending status reads without holding a connection for every generation.
  useGenerationProgress();

  return (
    <AppFrame>
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <Sidebar isMacOS={isMacOS()} />

        <main className="flex-1 ml-20 overflow-hidden flex flex-col">
          <div className="container mx-auto px-8 max-w-[1800px] h-full overflow-hidden flex flex-col">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Show download toasts for any active downloads (from anywhere) */}
      {activeDownloads.map((download) => {
        const displayName = MODEL_DISPLAY_NAMES[download.model_name] || download.model_name;
        return (
          <DownloadToastRestorer
            key={download.model_name}
            modelName={download.model_name}
            displayName={displayName}
          />
        );
      })}

      <Toaster />
    </AppFrame>
  );
}

/**
 * Component that restores a download toast for a specific model.
 */
function DownloadToastRestorer({
  modelName,
  displayName,
}: {
  modelName: string;
  displayName: string;
}) {
  // Use the download toast hook to restore the toast
  useModelDownloadToast({
    modelName,
    displayName,
    enabled: true,
  });

  return null;
}

// Root route with layout
const rootRoute = createRootRoute({
  component: RootLayout,
});

// Index route (main/generate)
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: MainEditor,
});

const workbenchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workbench',
  component: WorkbenchTab,
});

// Stories route
const storiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/stories',
  component: StoriesTab,
});

// Voices route
const voicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/voices',
  component: VoicesTab,
});

// Captures route (prototype — will replace AudioTab once the new flow is ready)
const capturesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/captures',
  component: CapturesTab,
});

// Effects route
const effectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/effects',
  component: EffectsTab,
});

// Models route
const modelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/models',
  component: ModelsTab,
});

// Settings layout route (parent for sub-tabs)
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsLayout,
});

// Settings sub-routes
const settingsGeneralRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  component: GeneralPage,
});

const settingsGenerationRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/generation',
  component: GenerationPage,
});

const settingsCapturesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/captures',
  component: CapturesPage,
});

const settingsMCPRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/mcp',
  component: MCPPage,
});

const settingsGpuRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/gpu',
  component: GpuPage,
});

const settingsChangelogRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/changelog',
  component: ChangelogPage,
});

const settingsLogsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/logs',
  component: LogsPage,
});

const settingsAboutRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/about',
  component: AboutPage,
});

// Redirect old /server path to /settings
const serverRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/server',
  beforeLoad: () => {
    throw redirect({ to: '/settings' });
  },
});

// Route tree
const routeTree = rootRoute.addChildren([
  indexRoute,
  workbenchRoute,
  storiesRoute,
  capturesRoute,
  voicesRoute,
  effectsRoute,
  modelsRoute,
  settingsRoute.addChildren([
    settingsGeneralRoute,
    settingsGenerationRoute,
    settingsCapturesRoute,
    settingsMCPRoute,
    settingsGpuRoute,
    settingsLogsRoute,
    settingsChangelogRoute,
    settingsAboutRoute,
  ]),
  serverRedirectRoute,
]);

// Create router
export const router = createRouter({ routeTree });

// Register router for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
