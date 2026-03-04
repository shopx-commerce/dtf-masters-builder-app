import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("App crash caught by ErrorBoundary:", error, info.componentStack);
  }

  handleRecover = () => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white border border-red-500/30 rounded-xl p-8 text-center space-y-5">
            <div className="text-red-400 text-5xl">!</div>
            <h2 className="text-xl font-bold text-gray-900">Something went wrong</h2>
            <p className="text-gray-600 text-sm">
              An unexpected error occurred. Your work may still be recoverable.
            </p>
            {this.state.error && (
              <details className="text-left">
                <summary className="text-gray-500 text-xs cursor-pointer hover:text-gray-600">
                  Error details
                </summary>
                <pre className="mt-2 text-[10px] text-red-300/70 bg-gray-50 rounded p-3 overflow-auto max-h-32 whitespace-pre-wrap">
                  {this.state.error.message}
                </pre>
              </details>
            )}
            <div className="flex gap-3 justify-center pt-2">
              <button
                onClick={this.handleRecover}
                className="px-5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-gray-900 text-sm font-medium transition-colors"
              >
                Try to Recover
              </button>
              <button
                onClick={this.handleReload}
                className="px-5 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 border border-gray-200 text-gray-700 text-sm font-medium transition-colors"
              >
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
