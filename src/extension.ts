import * as vscode from 'vscode';
import { HDRViewerProvider } from './hdrViewer';

export function activate(context: vscode.ExtensionContext) {
	// Register our custom editor providers
	context.subscriptions.push(HDRViewerProvider.register(context));
}
