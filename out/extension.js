"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = __importStar(require("vscode"));
const fetch = require("node-fetch"); // npm i node-fetch@2
const minimatch_1 = require("minimatch");
function activate(context) {
    const output = vscode.window.createOutputChannel("CodeSendOnSave");
    output.appendLine("CodeSendOnSave activated");
    const config = () => vscode.workspace.getConfiguration(); // Get the root configuration
    // in-memory queue for retrying failed sends
    const queue = [];
    let timer;
    // Simple debounce map so repeated saves of same file coalesce
    const pending = new Map();
    // Helper to read settings
    const settings = {
        enabled: () => config().get("enabled", true),
        endpoint: () => config().get("endpoint", "http://localhost:5000/api/analyze"),
        apiKey: () => config().get("apiKey", ""),
        debounceMs: () => config().get("debounceMs", 300),
        exclude: () => config().get("exclude", ["**/node_modules/**", "**/.git/**"])
    };
    // Convert exclude globs to Minimatch objects
    let excludeMatchers = settings.exclude().map(p => new minimatch_1.Minimatch(p, { dot: true, matchBase: true }));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration("codeSendOnSave")) {
            excludeMatchers = settings.exclude().map(p => new minimatch_1.Minimatch(p, { dot: true, matchBase: true }));
            output.appendLine("Config changed: updated exclude patterns");
        }
    }));
    // Check if a uri matches any exclude
    function isExcluded(uri) {
        const fsPath = uri.fsPath;
        return excludeMatchers.some(m => m.match(fsPath));
    }
    // Send function
    async function sendToBackend(task) {
        const endpoint = settings.endpoint();
        const apiKey = settings.apiKey();
        output.appendLine(`Sending ${task.uri.fsPath} -> ${endpoint}`);
        try {
            const res = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {})
                },
                // --- UPDATE THIS OBJECT ---
                body: JSON.stringify({
                    fileName: task.uri.fsPath,
                    language: task.uri.path.split(".").pop() || "",
                    code: task.content,
                    timestamp: new Date().toISOString(),
                    // --- ADD THIS LINE FOR THE DEMO ---
                    userId: "demo-user-123" // Or any hard-coded ID you want
                })
            });
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new Error(`HTTP ${res.status}: ${text}`);
            }
            const responseData = await res.json();
            // Check the nested 'gemini' object
            if (responseData.gemini && responseData.gemini.analysis) {
                const model = responseData.gemini.model || 'unknown';
                output.appendLine(`Analysis received (model: ${model})`);
                // 2. Show a pop-up notification
                vscode.window.showInformationMessage(`BrainBug Analysis Complete (using ${model})`, "View Analysis" // Add a button
                ).then(selection => {
                    // If the user clicks the button, show the output panel
                    if (selection === "View Analysis") {
                        output.show();
                    }
                });
                // 3. Print the full analysis to your "CodeSendOnSave" output channel
                output.appendLine("==================== BrainBug Analysis ====================");
                output.appendLine(responseData.gemini.analysis);
                output.appendLine("===========================================================");
            }
            else {
                // Handle cases where the API returned 200 OK but had an internal error
                const errorMessage = responseData.error || 'API returned 200 OK but no gemini.analysis field.';
                output.appendLine(`API Error: ${errorMessage}`);
                vscode.window.showErrorMessage(`BrainBug Error: ${errorMessage}`);
            }
            task.attempts = 0; // Mark as successful
        }
        catch (err) {
            task.attempts = (task.attempts || 0) + 1;
            task.lastError = (err === null || err === void 0 ? void 0 : err.message) || String(err);
            output.appendLine(`Failed to send ${task.uri.fsPath}: ${task.lastError} (attempt ${task.attempts})`);
            // Requeue with backoff
            requeue(task);
        }
    }
    function requeue(task) {
        const maxAttempts = 5;
        if (task.attempts >= maxAttempts) {
            output.appendLine(`Giving up sending ${task.uri.fsPath} after ${task.attempts} attempts.`);
            // optionally persist failed tasks using context.globalState if you want
            return;
        }
        const backoff = Math.min(60000, 500 * Math.pow(2, task.attempts)); // exponential backoff up to 60s
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
            clearTimeout(pending.get(key));
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
exports.activate = activate;
function deactivate() {
    // nothing for now
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map