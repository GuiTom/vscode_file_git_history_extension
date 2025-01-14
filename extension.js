const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');

class FileHistoryPanel {
    static currentPanel = undefined;
    static viewType = 'fileHistory';

    constructor(panel, extensionPath) {
        this.panel = panel;
        this.extensionPath = extensionPath;
        this._disposables = [];

        this.panel.onDidDispose(() => this.dispose(), null, this._disposables);
        
        this.panel.webview.html = this._getWebviewContent();
    }

    static createOrShow(extensionPath) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (FileHistoryPanel.currentPanel) {
            FileHistoryPanel.currentPanel.panel.reveal(column);
            return FileHistoryPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            FileHistoryPanel.viewType,
            'File History',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(path.join(extensionPath, 'media'))]
            }
        );

        FileHistoryPanel.currentPanel = new FileHistoryPanel(panel, extensionPath);
        return FileHistoryPanel.currentPanel;
    }

    dispose() {
        FileHistoryPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    _getWebviewContent() {
        const mediaPath = path.join(this.extensionPath, 'media', 'main.html');
        let htmlContent = require('fs').readFileSync(mediaPath, 'utf8');
        return htmlContent;
    }

    async updateContent(filePath) {
        const commits = await this._getCommitHistory(filePath);
        this.panel.webview.postMessage({ type: 'commits', commits });
    }

    _getCommitHistory(filePath) {
        return new Promise((resolve, reject) => {
            exec(`git log --follow --pretty=format:"%h" "${filePath}"`, {
                cwd: path.dirname(filePath)
            }, async (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }

                const commitHashes = stdout.split('\n').filter(hash => hash);
                const commits = [];

                for (const hash of commitHashes) {
                    try {
                        const commitInfo = await this._getCommitInfo(hash, filePath);
                        commits.push(commitInfo);
                    } catch (err) {
                        console.error('Error getting commit info:', err);
                    }
                }

                resolve(commits);
            });
        });
    }

    _getCommitInfo(hash, filePath) {
        return new Promise((resolve, reject) => {
            exec(`git show --pretty=format:"%h|%an|%ar|%s" ${hash} "${filePath}"`, {
                cwd: path.dirname(filePath)
            }, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }

                const lines = stdout.split('\n');
                const [commitHash, author, time, message] = lines[0].split('|');
                const diff = lines.slice(1).join('\n');

                resolve({
                    hash: commitHash,
                    author,
                    time,
                    message,
                    diff
                });
            });
        });
    }
}

function activate(context) {
    let disposable = vscode.commands.registerCommand('vscode-file-history.showFileHistory', async (uri) => {
        if (!uri) {
            uri = vscode.window.activeTextEditor?.document.uri;
        }
        
        if (!uri) {
            vscode.window.showErrorMessage('No file selected');
            return;
        }

        const filePath = uri.fsPath;
        const panel = FileHistoryPanel.createOrShow(context.extensionPath);
        await panel.updateContent(filePath);
    });

    context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
