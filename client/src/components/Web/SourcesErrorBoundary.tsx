import React, { Component, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  showDetails?: boolean;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  retryCount: number;
}

/**
 * Error boundary specifically designed for Sources components
 * Provides graceful error handling with retry functionality and detailed error reporting
 */
class SourcesErrorBoundary extends Component<Props, State> {
  private maxRetries = 3;
  private retryTimeouts: NodeJS.Timeout[] = [];

  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    // Update state so the next render will show the fallback UI
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log error details for debugging
    console.error('SourcesErrorBoundary caught an error:', {
      error: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
      retryCount: this.state.retryCount,
    });

    this.setState({
      error,
      errorInfo,
    });

    // Call custom error handler if provided
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }

    // Auto-retry for certain types of recoverable errors
    if (this.shouldAutoRetry(error) && this.state.retryCount < this.maxRetries) {
      this.scheduleRetry();
    }
  }

  componentWillUnmount() {
    // Clear any pending retry timeouts
    this.retryTimeouts.forEach((timeout) => clearTimeout(timeout));
  }

  private shouldAutoRetry(error: Error): boolean {
    // Auto-retry for network-related errors or temporary failures
    const retryablePatterns = [
      /network/i,
      /fetch/i,
      /timeout/i,
      /502|503|504/,
      /temporarily unavailable/i,
    ];

    return retryablePatterns.some(
      (pattern) => pattern.test(error.message) || pattern.test(error.name),
    );
  }

  private scheduleRetry = () => {
    const delay = Math.min(1000 * Math.pow(2, this.state.retryCount), 10000); // Exponential backoff, max 10s

    const timeout = setTimeout(() => {
      this.setState((prevState) => ({
        hasError: false,
        error: null,
        errorInfo: null,
        retryCount: prevState.retryCount + 1,
      }));
    }, delay);

    this.retryTimeouts.push(timeout);
  };

  private handleManualRetry = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: 0,
    });
  };

  private getErrorType(error: Error): string {
    if (error.name === 'ChunkLoadError') return 'chunk_load';
    if (error.message.includes('Network')) return 'network';
    if (error.message.includes('Failed to fetch')) return 'fetch';
    if (error.message.includes('timeout')) return 'timeout';
    if (error.message.includes('403')) return 'permission';
    if (error.message.includes('401')) return 'authentication';
    return 'unknown';
  }

  private getErrorMessage(error: Error): string {
    const errorType = this.getErrorType(error);

    switch (errorType) {
      case 'network':
        return 'Unable to load sources due to network issues. Please check your connection and try again.';
      case 'fetch':
        return 'Failed to retrieve source data. The server may be temporarily unavailable.';
      case 'timeout':
        return 'The request timed out. Please try again in a moment.';
      case 'permission':
        return 'You do not have permission to access these sources.';
      case 'authentication':
        return 'Authentication required. Please log in and try again.';
      case 'chunk_load':
        return 'Failed to load application components. Please refresh the page.';
      default:
        return 'An unexpected error occurred while loading sources.';
    }
  }

  render() {
    if (this.state.hasError) {
      // Custom fallback UI provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const errorMessage = this.getErrorMessage(this.state.error!);
      const canRetry = this.state.retryCount < this.maxRetries;

      // Default error UI
      return (
        <div
          className="flex flex-col items-center justify-center rounded-lg border border-border-medium bg-surface-secondary p-6 text-center"
          role="alert"
          aria-live="polite"
        >
          <AlertTriangle className="text-text-error mb-3 h-8 w-8" aria-hidden="true" />

          <h3 className="mb-2 text-lg font-semibold text-text-primary">Sources Unavailable</h3>

          <p className="mb-4 max-w-md text-sm text-text-secondary">{errorMessage}</p>

          {canRetry && (
            <button
              onClick={this.handleManualRetry}
              className="hover:bg-surface-primary-hover flex items-center gap-2 rounded-md bg-surface-primary px-4 py-2 text-sm font-medium text-text-primary transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              aria-label="Retry loading sources"
            >
              <RefreshCw className="h-4 w-4" />
              Try Again
            </button>
          )}

          {this.props.showDetails && this.state.error && (
            <details className="mt-4 w-full max-w-md">
              <summary className="cursor-pointer text-xs text-text-secondary hover:text-text-primary">
                Technical Details
              </summary>
              <div className="mt-2 rounded bg-surface-tertiary p-2 text-left">
                <pre className="whitespace-pre-wrap break-all text-xs text-text-secondary">
                  {this.state.error.message}
                  {this.state.errorInfo?.componentStack && (
                    <>
                      {'\n\nComponent Stack:'}
                      {this.state.errorInfo.componentStack}
                    </>
                  )}
                </pre>
              </div>
            </details>
          )}

          <div className="mt-3 text-xs text-text-secondary">
            {this.state.retryCount > 0 && (
              <span>
                Retry attempts: {this.state.retryCount}/{this.maxRetries}
              </span>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default SourcesErrorBoundary;
