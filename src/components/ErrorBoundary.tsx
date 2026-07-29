import { Component, ReactNode } from "react";
import { getPreferredLanguage, translations } from "../i18n";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: string;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: "" };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info);
  }

  render() {
    if (this.state.hasError) {
      const t = translations[getPreferredLanguage()];
      return (
        <div className="h-screen flex flex-col items-center justify-center gap-4 bg-white dark:bg-[#1c1c1e] text-zinc-600 dark:text-zinc-400 font-sans select-none">
          <div className="text-4xl font-black text-red-400">:(</div>
          <div className="text-sm font-bold">{t.somethingWrong}</div>
          <pre className="text-[10px] text-zinc-400 max-w-md text-center whitespace-pre-wrap">{this.state.error}</pre>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-accent text-white rounded-xl text-xs font-bold hover:bg-accent transition-colors"
          >
            {t.reload}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
