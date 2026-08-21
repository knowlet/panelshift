interface PanelshiftChromeTab {
  id?: number;
  url?: string;
  title?: string;
}

interface PanelshiftMessageSender {
  tab?: PanelshiftChromeTab;
}

type PanelshiftRuntimeListener = (
  message: unknown,
  sender: PanelshiftMessageSender,
  sendResponse: (response?: unknown) => void,
) => void | boolean | Promise<unknown>;

declare const chrome: {
  runtime: {
    getURL(path: string): string;
    sendMessage<T = unknown>(message: unknown): Promise<T>;
    lastError?: { message?: string };
    onMessage: {
      addListener(listener: PanelshiftRuntimeListener): void;
      removeListener(listener: PanelshiftRuntimeListener): void;
    };
  };
  tabs: {
    query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<PanelshiftChromeTab[]>;
    sendMessage<T = unknown>(tabId: number, message: unknown): Promise<T>;
    onActivated: {
      addListener(listener: (activeInfo: { tabId: number; windowId: number }) => void): void;
      removeListener(listener: (activeInfo: { tabId: number; windowId: number }) => void): void;
    };
  };
  scripting: {
    executeScript(injection: {
      target: { tabId: number };
      files: string[];
    }): Promise<unknown[]>;
  };
  permissions: {
    contains(permissions: { origins?: string[] }): Promise<boolean>;
    request(permissions: { origins?: string[] }): Promise<boolean>;
  };
  storage: {
    local: {
      get(keys?: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
};
