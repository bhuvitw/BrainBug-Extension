import * as vscode from "vscode";
import fetch = require("node-fetch"); // npm i node-fetch@2
import { Minimatch } from "minimatch";

type SendTask = {
  uri: vscode.Uri;
  content: string;
  attempts: number;
  lastError?: string;
};

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("CodeSendOnSave");
  output.appendLine("CodeSendOnSave activated");

  const config = () => vscode.workspace.getConfiguration(); // Get the root configuration

  // in-memory queue for retrying failed sends
  const queue: SendTask[] = [];
  let timer: NodeJS.Timeout | undefined;

  // Simple debounce map so repeated saves of same file coalesce
  const pending = new Map<string, NodeJS.Timeout>();

  // Helper to read settings
  const settings = {
    enabled: () => config().get<boolean>("enabled", true),
    endpoint: () => config().get<string>("endpoint", "http://localhost:5000/api/test/echo"),
    apiKey: () => config().get<string>("apiKey", ""),
    debounceMs: () => config().get<number>("debounceMs", 300),
    exclude: () => config().get<string[]>("exclude", ["**/node_modules/**", "**/.git/**"])
  };

  // Convert exclude globs to Minimatch objects
  let excludeMatchers = settings.exclude().map(p => new Minimatch(p, { dot: true, matchBase: true }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration("codeSendOnSave")) {
      excludeMatchers = settings.exclude().map(p => new Minimatch(p, { dot: true, matchBase: true }));
      output.appendLine("Config changed: updated exclude patterns");
    }
  }));

  // Check if a uri matches any exclude
  function isExcluded(uri: vscode.Uri) {
    const fsPath = uri.fsPath;
    return excludeMatchers.some(m => m.match(fsPath));
  }

  // Send function
  
  async function sendToBackend(task: SendTask): Promise<void> {
    const endpoint = settings.endpoint();
    const apiKey = settings.apiKey();
output.appendLine(`Sending -> ${endpoint}`);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
          path: task.uri.fsPath,
          language: task.uri.path.split(".").pop() || "",
          content: task.content,
          timestamp: new Date().toISOString()
        })
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      output.appendLine(`Sent ${task.uri.fsPath} successfully`);
      task.attempts = 0;
    } catch (err: any) {
      task.attempts = (task.attempts || 0) + 1;
      task.lastError = err?.message || String(err);
      output.appendLine(`Failed to send ${task.uri.fsPath}: ${task.lastError} (attempt ${task.attempts})`);
      // Requeue with backoff
      requeue(task);
    }
  }

  function requeue(task: SendTask) {
    const maxAttempts = 5;
    if (task.attempts >= maxAttempts) {
      output.appendLine(`Giving up sending ${task.uri.fsPath} after ${task.attempts} attempts.`);
      // optionally persist failed tasks using context.globalState if you want
      return;
    }
    const backoff = Math.min(60_000, 500 * Math.pow(2, task.attempts)); // exponential backoff up to 60s
    queue.push(task);
    scheduleQueueProcessor(backoff);
  }

  function scheduleQueueProcessor(delayMs = 0) {
    if (timer) {
      // if existing timer is earlier, keep it; otherwise reset
      clearTimeout(timer);
    }
    timer = setTimeout(processQueue, delayMs);
  }

  async function processQueue() {
    timer = undefined;
    if (queue.length === 0) {
      return;
    }
    // take a snapshot so new queue items can be added concurrently
    const tasks = queue.splice(0, queue.length);
    for (const t of tasks) {
      await sendToBackend(t);
    }
  }

  // Event: file save
  const disposable = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    if (!settings.enabled()) {
      return;
    }
    const uri = doc.uri;
    if (uri.scheme !== "file") {
      return; // ignore non-file documents
    }
    if (isExcluded(uri)) {
      output.appendLine(`Excluded: ${uri.fsPath}`);
      return;
    }

    // Debounce per-file
    const key = uri.toString();
    if (pending.has(key)) {
      clearTimeout(pending.get(key)!);
    }
    const ms = settings.debounceMs();
    const t = setTimeout(async () => {
      pending.delete(key);
      const content = doc.getText();

      // push to queue for sending
      queue.push({ uri, content, attempts: 0 });
      output.appendLine(`Queued ${uri.fsPath} for sending`);
      scheduleQueueProcessor(0);
    }, ms);
    pending.set(key, t);
  });

  context.subscriptions.push(disposable);

  // Command to force-send queued items (dev tool)
  const sendNowCmd = vscode.commands.registerCommand("codeSendOnSave.sendNow", async () => {
    output.appendLine("Manual send triggered");
    await processQueue();
    vscode.window.showInformationMessage("CodeSendOnSave: processed queue");
  });
  context.subscriptions.push(sendNowCmd);

  // On deactivate, try to flush queue
  context.subscriptions.push({
    dispose() {
      if (timer) {
        clearTimeout(timer);
      }
      // attempt a final synchronous send is not possible; but we can at least persist queue if desired
      output.appendLine("CodeSendOnSave deactivating. Queue length: " + queue.length);
    }
  });
}

export function deactivate() {
  // nothing for now
}
