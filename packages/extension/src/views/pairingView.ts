import * as vscode from 'vscode';
import * as QRCode from 'qrcode';
import { readToken, maskToken } from '../utils/token';
import { probeDaemon, getLanAddresses, buildWebUrl, type DaemonInfo } from '../utils/daemonProbe';
import { getConfig } from '../config';

export class PairingViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'deadhand.pairingView';

  private _view?: vscode.WebviewView;
  private _daemonInfo: DaemonInfo | null = null;
  private _token: string | null = null;
  private _selectedHost: string = 'localhost';
  private _tokenRevealed: boolean = false;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'copyToken':
          if (this._token) {
            await vscode.env.clipboard.writeText(this._token);
            vscode.window.showInformationMessage('Token copied to clipboard');
          }
          break;
        case 'copyUrl':
          if (this._daemonInfo?.scheme && this._token) {
            const config = getConfig();
            const url = buildWebUrl(
              this._daemonInfo.scheme,
              message.host || 'localhost',
              config.daemonPort,
              this._token
            );
            await vscode.env.clipboard.writeText(url);
            vscode.window.showInformationMessage('URL copied to clipboard');
          }
          break;
        case 'openWebUI':
          if (this._daemonInfo?.scheme) {
            const config = getConfig();
            const url = buildWebUrl(
              this._daemonInfo.scheme,
              'localhost',
              config.daemonPort,
              this._token || undefined
            );
            vscode.env.openExternal(vscode.Uri.parse(url));
          }
          break;
        case 'selectHost':
          this._selectedHost = message.host;
          await this._updateView();
          break;
        case 'toggleReveal':
          this._tokenRevealed = !this._tokenRevealed;
          await this._updateView();
          break;
        case 'refresh':
          await this.refresh();
          break;
      }
    });

    await this.refresh();
  }

  public async refresh(): Promise<void> {
    this._token = readToken();
    this._daemonInfo = await probeDaemon();
    await this._updateView();
  }

  private async _updateView(): Promise<void> {
    if (!this._view) {
      return;
    }

    const config = getConfig();
    const lanAddresses = getLanAddresses();
    
    // Generate QR code if in TLS mode
    let qrDataUrl: string | null = null;
    if (this._daemonInfo?.scheme === 'https' && this._token) {
      const url = buildWebUrl(
        'https',
        this._selectedHost,
        config.daemonPort,
        this._token
      );
      try {
        qrDataUrl = await QRCode.toDataURL(url, {
          width: 200,
          margin: 2,
          color: {
            dark: '#000000',  // black QR pattern for visibility
            light: '#ffffff', // white background for contrast
          },
        });
      } catch (err) {
        console.error('[Deadhand] Failed to generate QR:', err);
      }
    }

    this._view.webview.html = this._getHtml(
      this._daemonInfo,
      this._token,
      this._tokenRevealed,
      config.daemonPort,
      lanAddresses,
      this._selectedHost,
      qrDataUrl
    );
  }

  private _getHtml(
    daemonInfo: DaemonInfo | null,
    token: string | null,
    tokenRevealed: boolean,
    port: number,
    lanAddresses: string[],
    selectedHost: string,
    qrDataUrl: string | null
  ): string {
    const statusColor = daemonInfo?.reachable ? '#22c55e' : '#ef4444';
    const statusText = daemonInfo?.reachable
      ? `Connected (${daemonInfo.scheme?.toUpperCase()})`
      : 'Not Connected';
    const modeText = daemonInfo?.scheme === 'https' ? 'LAN (TLS)' : daemonInfo?.scheme === 'http' ? 'Localhost Only' : 'Unknown';

    const displayToken = token
      ? tokenRevealed
        ? token
        : maskToken(token)
      : 'No token found';

    const hostOptions = ['localhost', ...lanAddresses]
      .map(
        (addr) =>
          `<option value="${addr}" ${addr === selectedHost ? 'selected' : ''}>${addr}</option>`
      )
      .join('');

    const qrSection =
      daemonInfo?.scheme === 'https' && qrDataUrl
        ? `
          <div class="section">
            <div class="section-title">LAN QR Code</div>
            <div class="qr-container">
              <img src="${qrDataUrl}" alt="QR Code" class="qr-code" />
            </div>
            <div class="host-select">
              <label for="host">Host/IP:</label>
              <select id="host" onchange="selectHost(this.value)">
                ${hostOptions}
              </select>
            </div>
            <div class="hint">Scan with your phone to open web UI</div>
          </div>
        `
        : daemonInfo?.scheme === 'http'
        ? `
          <div class="section">
            <div class="section-title">LAN QR Code</div>
            <div class="hint warning">
              QR code unavailable.<br/>
              Daemon is in localhost-only mode (HTTP).<br/>
              Restart without DEADHAND_LOCALHOST_ONLY for LAN access.
            </div>
          </div>
        `
        : '';

    const fingerprintSection =
      daemonInfo?.fingerprint
        ? `
          <div class="section">
            <div class="section-title">TLS Fingerprint</div>
            <div class="fingerprint">${daemonInfo.fingerprint}</div>
            <div class="hint">Verify this matches on your phone</div>
          </div>
        `
        : '';

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        body {
          font-family: var(--vscode-font-family);
          font-size: var(--vscode-font-size);
          color: var(--vscode-foreground);
          padding: 12px;
        }
        .section {
          margin-bottom: 16px;
          padding-bottom: 16px;
          border-bottom: 1px solid var(--vscode-widget-border);
        }
        .section:last-child {
          border-bottom: none;
          margin-bottom: 0;
        }
        .section-title {
          font-weight: 600;
          margin-bottom: 8px;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--vscode-descriptionForeground);
        }
        .status-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 4px;
        }
        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: ${statusColor};
        }
        .status-text {
          font-weight: 500;
        }
        .mode-text {
          color: var(--vscode-descriptionForeground);
          font-size: 12px;
        }
        .token-container {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .token-value {
          font-family: var(--vscode-editor-font-family);
          font-size: 12px;
          padding: 8px;
          background: var(--vscode-input-background);
          border: 1px solid var(--vscode-input-border);
          border-radius: 4px;
          word-break: break-all;
          user-select: all;
        }
        .token-actions {
          display: flex;
          gap: 8px;
        }
        .btn {
          padding: 6px 12px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          font-family: inherit;
        }
        .btn-primary {
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
        }
        .btn-primary:hover {
          background: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        .qr-container {
          display: flex;
          justify-content: center;
          padding: 12px;
          background: var(--vscode-input-background);
          border-radius: 8px;
          margin-bottom: 8px;
        }
        .qr-code {
          width: 160px;
          height: 160px;
        }
        .host-select {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .host-select label {
          font-size: 12px;
          color: var(--vscode-descriptionForeground);
        }
        .host-select select {
          flex: 1;
          padding: 4px 8px;
          background: var(--vscode-input-background);
          color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border);
          border-radius: 4px;
          font-family: var(--vscode-editor-font-family);
          font-size: 12px;
        }
        .hint {
          font-size: 11px;
          color: var(--vscode-descriptionForeground);
          text-align: center;
        }
        .hint.warning {
          color: var(--vscode-editorWarning-foreground);
          text-align: left;
          padding: 8px;
          background: var(--vscode-inputValidation-warningBackground);
          border: 1px solid var(--vscode-inputValidation-warningBorder);
          border-radius: 4px;
        }
        .fingerprint {
          font-family: var(--vscode-editor-font-family);
          font-size: 10px;
          padding: 8px;
          background: var(--vscode-input-background);
          border: 1px solid var(--vscode-input-border);
          border-radius: 4px;
          word-break: break-all;
          line-height: 1.5;
          margin-bottom: 4px;
        }
        .actions {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
      </style>
    </head>
    <body>
      <div class="section">
        <div class="section-title">Daemon Status</div>
        <div class="status-row">
          <div class="status-dot"></div>
          <span class="status-text">${statusText}</span>
        </div>
        <div class="mode-text">Port ${port} • ${modeText}</div>
      </div>

      <div class="section">
        <div class="section-title">Access Token</div>
        <div class="token-container">
          <div class="token-value">${displayToken}</div>
          <div class="token-actions">
            <button class="btn btn-secondary" onclick="toggleReveal()">
              ${tokenRevealed ? 'Hide' : 'Reveal'}
            </button>
            <button class="btn btn-primary" onclick="copyToken()" ${!token ? 'disabled' : ''}>
              Copy Token
            </button>
          </div>
        </div>
      </div>

      ${qrSection}

      ${fingerprintSection}

      <div class="section">
        <div class="section-title">Quick Actions</div>
        <div class="actions">
          <button class="btn btn-primary" onclick="openWebUI()" ${!daemonInfo?.reachable ? 'disabled' : ''}>
            Open Web UI
          </button>
          <button class="btn btn-secondary" onclick="copyUrl()" ${!daemonInfo?.reachable || !token ? 'disabled' : ''}>
            Copy URL with Token
          </button>
        </div>
      </div>

      <script>
        const vscode = acquireVsCodeApi();
        
        function copyToken() {
          vscode.postMessage({ type: 'copyToken' });
        }
        
        function copyUrl() {
          const host = document.getElementById('host')?.value || 'localhost';
          vscode.postMessage({ type: 'copyUrl', host });
        }
        
        function openWebUI() {
          vscode.postMessage({ type: 'openWebUI' });
        }
        
        function selectHost(host) {
          vscode.postMessage({ type: 'selectHost', host });
        }
        
        function toggleReveal() {
          vscode.postMessage({ type: 'toggleReveal' });
        }
        
        function refresh() {
          vscode.postMessage({ type: 'refresh' });
        }
      </script>
    </body>
    </html>`;
  }
}

