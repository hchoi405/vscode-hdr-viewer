import * as vscode from 'vscode';
import { Disposable, disposeAll } from './dispose';
import { getNonce } from './util';

interface HDRImageDelegate {
	getFileData(): Promise<Uint8Array>;
}

/**
 * Define the exr image.
 */
class HDRImage extends Disposable implements vscode.CustomDocument {

	static async create(
		uri: vscode.Uri,
		backupId: string | undefined,
		delegate: HDRImageDelegate,
	): Promise<HDRImage | PromiseLike<HDRImage>> {
		// If we have a backup, read that. Otherwise read the resource from the workspace
		const dataFile = typeof backupId === 'string' ? vscode.Uri.parse(backupId) : uri;
		const fileData = await HDRImage.readFile(dataFile);
		return new HDRImage(uri, fileData, delegate);
	}

	private static async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		if (uri.scheme === 'untitled') {
			throw new Error('Could not find the file to open');
		}
		return vscode.workspace.fs.readFile(uri);
	}

	private readonly _uri: vscode.Uri;

	private _documentData: Uint8Array;

	private readonly _delegate: HDRImageDelegate;

	private constructor(
		uri: vscode.Uri,
		initialContent: Uint8Array,
		delegate: HDRImageDelegate
	) {
		super();
		this._uri = uri;
		this._documentData = initialContent;
		this._delegate = delegate;
	}

	public get uri() { return this._uri; }

	public get documentData(): Uint8Array { return this._documentData; }

	/**
	 * Called by VS Code when the user saves the document.
	 */
	async save(cancellation: vscode.CancellationToken): Promise<void> {
		await this.saveAs(this.uri, cancellation);
	}

	/**
	 * Called by VS Code when the user saves the document to a new location.
	 */
	async saveAs(targetResource: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
		const fileData = await this._delegate.getFileData();
		if (cancellation.isCancellationRequested) {
			return;
		}
		await vscode.workspace.fs.writeFile(targetResource, fileData);
	}
}

/**
 * Provider for paw draw editors.
 *
 * Paw draw editors are used for `.pawDraw` files, which are just `.png` files with a different file extension.
 *
 * This provider demonstrates:
 *
 * - How to implement a custom editor for binary files.
 * - Setting up the initial webview for a custom editor.
 * - Loading scripts and styles in a custom editor.
 * - Communication between VS Code and the custom editor.
 * - Using CustomDocuments to store information that is shared between multiple custom editors.
 * - Implementing save, undo, redo, and revert.
 * - Backing up a custom editor.
 */
export class HDRViewerProvider implements vscode.CustomReadonlyEditorProvider<HDRImage> {

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			HDRViewerProvider.viewType,
			new HDRViewerProvider(context),
			{
				// For this demo extension, we enable `retainContextWhenHidden` which keeps the
				// webview alive even when it is not visible. You should avoid using this setting
				// unless is absolutely required as it does have memory overhead.
				webviewOptions: {
					retainContextWhenHidden: true,
				},
				supportsMultipleEditorsPerDocument: false,
			});
	}

	private static readonly viewType = 'hdrViewer.hdr';

	/**
	 * Tracks all known webviews
	 */
	private readonly webviews = new WebviewCollection();

	constructor(
		private readonly _context: vscode.ExtensionContext
	) { }

	//#region CustomEditorProvider

	async openCustomDocument(
		uri: vscode.Uri,
		openContext: { backupId?: string },
		_token: vscode.CancellationToken
	): Promise<HDRImage> {
		const document: HDRImage = await HDRImage.create(uri, openContext.backupId, {
			getFileData: async () => {
				const webviewsForDocument = Array.from(this.webviews.get(document.uri));
				if (!webviewsForDocument.length) {
					throw new Error('Could not find webview to save for');
				}
				const panel = webviewsForDocument[0];
				const response = await this.postMessageWithResponse<number[]>(panel, 'getFileData', {});
				return new Uint8Array(response);
			}
		});

		const listeners: vscode.Disposable[] = [];

		return document;
	}

	async resolveCustomEditor(
		document: HDRImage,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		// Add the webview to our internal set of active webviews
		this.webviews.add(document.uri, webviewPanel);

		// Setup initial content for the webview
		webviewPanel.webview.options = {
			enableScripts: true,
		};
		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

		webviewPanel.webview.onDidReceiveMessage(e => this.onMessage(document, e));

		// Wait for the webview to be properly ready before we init
		webviewPanel.webview.onDidReceiveMessage(e => {
			if (e.type === 'ready') {
				if (document.uri.scheme === 'untitled') {
					this.postMessage(webviewPanel, 'init', {
						untitled: true,
						editable: true,
					});
				} else {
					const editable = vscode.workspace.fs.isWritableFileSystem(document.uri.scheme);

					this.postMessage(webviewPanel, 'init', {
						value: document.documentData,
						editable,
					});
				}
			}
		});
	}

	private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<HDRImage>>();
	public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

	//#endregion

	/**
	 * Get the static HTML used for in our editor's webviews.
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		// Local path to script and css for the webview
		const scriptUri2 = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media',
			'react.development.js'));
		const scriptUri3 = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media',
			'react-dom.development.js'));
		const scriptUri4 = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'jeri.min.js'));

		const testImageUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'test.exr'));

		// Use a nonce to whitelist which scripts can be run
		const nonce = getNonce();

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">

			<!--
				Use a content security policy to only allow loading images from https or from our extension directory,
				and only allow scripts that have a specific nonce.
			-->
			<!-- <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} https: blob:; script-src 'nonce-${nonce}';"> -->
			<meta http-equiv="Content-Security-Policy" content="default-src *; style-src * 'unsafe-inline'; img-src ${webview.cspSource} https: blob:; script-src 'unsafe-eval' 'unsafe-inline' 'nonce-${nonce}'; worker-src * data: blob:;">

			<meta name="viewport" content="width=device-width, initial-scale=1.0">

			<title>Cat Coding</title>

			<style>
				.stretch {
					width: 100%;
					height: 100%;
					position: absolute;
					left:0; right: 0; top:0; bottom: 0;
				}
			</style>
		</head>
		<body>
			merong
			<div style="width:100%; height: 80vh; position: relative;">
			haha
				<canvas id="image-layer" class="stretch"></canvas>
				<div id="mouse-layer" class="stretch"></div>
			</div>

			<script nonce="${nonce}">
				window.resourceBaseUrl = '/';
			</script>
			<script nonce="${nonce}" src="${scriptUri2}"></script>
			<script nonce="${nonce}" src="${scriptUri3}"></script>
			<script nonce="${nonce}" src="${scriptUri4}"></script>
			<script nonce="${nonce}">
				const ImageLayer = Jeri.ImageLayer;
				const MouseLayer = Jeri.MouseLayer;

				const cache = new Jeri.ImageCache();
				const imgUrl = "${testImageUri}";
				console.log(imgUrl)

				cache.get(imgUrl)
				.then((image) => {
					const imageLayer = new ImageLayer(document.getElementById('image-layer'), image);
					const mouseLayer = new MouseLayer(document.getElementById('mouse-layer'), image);
					mouseLayer.setEnableMouseEvents(true);
					mouseLayer.onTransformationChange(function (transformation) {
						imageLayer.setTransformation(transformation);
					});
				})
				.catch((error) => console.error(error));
			</script>
		</body>
		</html>`;
	}

	private _requestId = 1;
	private readonly _callbacks = new Map<number, (response: any) => void>();

	private postMessageWithResponse<R = unknown>(panel: vscode.WebviewPanel, type: string, body: any): Promise<R> {
		const requestId = this._requestId++;
		const p = new Promise<R>(resolve => this._callbacks.set(requestId, resolve));
		panel.webview.postMessage({ type, requestId, body });
		return p;
	}

	private postMessage(panel: vscode.WebviewPanel, type: string, body: any): void {
		panel.webview.postMessage({ type, body });
	}

	private onMessage(document: HDRImage, message: any) {
		switch (message.type) {
			case 'response':
				{
					const callback = this._callbacks.get(message.requestId);
					callback?.(message.body);
					return;
				}
		}
	}
}

/**
 * Tracks all webviews.
 */
class WebviewCollection {

	private readonly _webviews = new Set<{
		readonly resource: string;
		readonly webviewPanel: vscode.WebviewPanel;
	}>();

	/**
	 * Get all known webviews for a given uri.
	 */
	public *get(uri: vscode.Uri): Iterable<vscode.WebviewPanel> {
		const key = uri.toString();
		for (const entry of this._webviews) {
			if (entry.resource === key) {
				yield entry.webviewPanel;
			}
		}
	}

	/**
	 * Add a new webview to the collection.
	 */
	public add(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel) {
		const entry = { resource: uri.toString(), webviewPanel };
		this._webviews.add(entry);

		webviewPanel.onDidDispose(() => {
			this._webviews.delete(entry);
		});
	}
}
