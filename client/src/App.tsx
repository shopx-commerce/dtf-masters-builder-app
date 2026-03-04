import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/error-boundary";
import { LanguageProvider } from "@/lib/i18n";
import Landing from "@/pages/landing";
import StickerMaker from "@/pages/sticker-maker";
import EmbedPage from "@/pages/embed";
import NotFound from "@/pages/not-found";
import { HOT_PEEL_PROFILE, FLUORESCENT_PROFILE, UV_DTF_PROFILE, SPECIALTY_DTF_PROFILE } from "@/lib/profiles";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/hot-peel">{() => <StickerMaker profile={HOT_PEEL_PROFILE} />}</Route>
      <Route path="/fluorescent">{() => <StickerMaker profile={FLUORESCENT_PROFILE} />}</Route>
      <Route path="/uv-dtf">{() => <StickerMaker profile={UV_DTF_PROFILE} />}</Route>
      <Route path="/specialty-dtf">{() => <StickerMaker profile={SPECIALTY_DTF_PROFILE} />}</Route>
      <Route path="/embed" component={EmbedPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <LanguageProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Toaster />
            <Router />
          </TooltipProvider>
        </QueryClientProvider>
      </LanguageProvider>
    </ErrorBoundary>
  );
}

export default App;
