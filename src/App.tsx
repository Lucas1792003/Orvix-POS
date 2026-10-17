import { AppRouter } from "./app/routes/AppRouter";
import { ToastViewport } from "./components/ui/Toast";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { UnresolvedOperationPrompt } from "./components/sync/UnresolvedOperationPrompt";

function App() {
  return (
    <ErrorBoundary>
      <AppRouter />
      <ToastViewport />
      <UnresolvedOperationPrompt />
    </ErrorBoundary>
  );
}

export default App;
