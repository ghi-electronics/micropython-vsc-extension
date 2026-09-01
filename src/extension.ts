/**
 * Extension entry point.
 *
 * The debug adapter runs in-process rather than as a separate executable:
 * there is no native dependency to ship and nothing to spawn, so the whole
 * extension is one VSIX.
 */
import * as vscode from "vscode";
import * as path from "path";
import { MicroPythonDebugSession } from "./debugSession";
import { findPorts } from "./deviceLink";

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory(
            "micropython", new InlineAdapterFactory()),
        vscode.debug.registerDebugConfigurationProvider(
            "micropython", new ConfigProvider()),
        vscode.commands.registerCommand(
            "micropython-sitcore.selectDevice", showDevices),
    );
}

export function deactivate(): void { /* nothing to tear down */ }

class InlineAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(
            new MicroPythonDebugSession() as unknown as vscode.DebugAdapter);
    }
}

class ConfigProvider implements vscode.DebugConfigurationProvider {
    /**
     * Fills in a usable configuration when the user presses F5 with no
     * launch.json, so the first run needs no setup.
     */
    resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor?.document.languageId !== "python") {
                void vscode.window.showErrorMessage(
                    "Open a Python file, or create a launch configuration.");
                return undefined;
            }
            config.type = "micropython";
            config.name = "Deploy and Debug (MicroPython, USB)";
            config.request = "launch";
            config.program = editor.document.fileName;
            config.sync = true;
        }
        if (!config.program) {
            const root = folder?.uri.fsPath;
            if (root) {
                config.program = path.join(root, "main.py");
            }
        }
        return config;
    }
}

async function showDevices(): Promise<void> {
    const ports = await findPorts();
    if (!ports.debug) {
        void vscode.window.showWarningMessage(
            "No SITCore debug port found. The board must be running MicroPython "
            + "with two CDC interfaces (VCP+VCP).");
        return;
    }
    void vscode.window.showInformationMessage(
        `SITCore debug channel on ${ports.debug}`
        + (ports.repl ? `, REPL on ${ports.repl}` : ""));
}
