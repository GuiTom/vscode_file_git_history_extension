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
                localResourceRoots: [vscode.Uri.file(path.join(extensionPath, 'media'))],
                retainContextWhenHidden: true
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

    async handleWebviewMessage(message) {
        switch (message.command) {
            case 'getDiff':
                try {
                    const { stdout: diff } = await exec(`git diff ${message.hash}^..${message.hash} -- "${message.filePath}"`, {
                        cwd: path.dirname(message.filePath)
                    });
                    this.panel.webview.postMessage({ command: 'showDiff', hash: message.hash, diff });
                } catch (error) {
                    console.error(error);
                }
                break;
            case 'saveViewMode':
                // Save the view mode preference
                await vscode.workspace.getConfiguration().update('fileHistory.viewMode', message.isUnified);
                break;
        }
    }
}

class RevisionSelectPanel {
    static currentPanel = undefined;
    static viewType = 'revisionSelect';

    constructor(panel, extensionPath, filePath) {
        this.panel = panel;
        this.extensionPath = extensionPath;
        this.filePath = filePath;
        this._disposables = [];

        this.panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this.panel.webview.onDidReceiveMessage(
            message => this._handleMessage(message),
            null,
            this._disposables
        );
        
        this.panel.webview.html = this._getWebviewContent();
        this._loadCommitsAndBranches();
    }

    static createOrShow(extensionPath, filePath) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (RevisionSelectPanel.currentPanel) {
            RevisionSelectPanel.currentPanel.panel.reveal(column);
            return RevisionSelectPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            RevisionSelectPanel.viewType,
            'Select Revision',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(path.join(extensionPath, 'media'))],
                retainContextWhenHidden: true
            }
        );

        RevisionSelectPanel.currentPanel = new RevisionSelectPanel(panel, extensionPath, filePath);
        return RevisionSelectPanel.currentPanel;
    }

    async _loadCommitsAndBranches() {
        try {
            const branches = await getBranches(this.filePath);
            this.panel.webview.postMessage({ type: 'branches', branches });

            const commits = await this._getDetailedCommitHistory(this.filePath);
            this.panel.webview.postMessage({ type: 'commits', commits });
        } catch (error) {
            vscode.window.showErrorMessage(`Error loading history: ${error.message}`);
        }
    }

    _getDetailedCommitHistory(filePath) {
        return new Promise((resolve, reject) => {
            exec(`git log --follow --pretty=format:"%H|%an|%ar|%s" "${filePath}"`, {
                cwd: path.dirname(filePath)
            }, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }

                const commits = stdout.split('\n')
                    .filter(line => line.trim())
                    .map(line => {
                        const [hash, author, date, ...messageParts] = line.split('|');
                        return {
                            hash,
                            author,
                            date,
                            message: messageParts.join('|')
                        };
                    });

                resolve(commits);
            });
        });
    }

    _getWebviewContent() {
        const mediaPath = path.join(this.extensionPath, 'media', 'revision-select.html');
        let htmlContent = require('fs').readFileSync(mediaPath, 'utf8');
        return htmlContent;
    }

    async _handleMessage(message) {
        if (message.type === 'select') {
            await compareWithRevision(this.filePath, message.revision);
            this.dispose();
        }
    }

    dispose() {
        RevisionSelectPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}

async function getBranches(filePath) {
    return new Promise((resolve, reject) => {
        exec('git branch -a', {
            cwd: path.dirname(filePath)
        }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            const branches = stdout.split('\n')
                .map(b => b.trim())
                .filter(b => b && !b.startsWith('*'))
                .map(b => b.replace('remotes/origin/', ''));
            resolve([...new Set(branches)]);
        });
    });
}

async function getGitRoot(filePath) {
    return new Promise((resolve, reject) => {
        exec('git rev-parse --show-toplevel', {
            cwd: path.dirname(filePath)
        }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout.trim());
        });
    });
}

async function getRelativeToGitRoot(filePath) {
    const gitRoot = await getGitRoot(filePath);
    return path.relative(gitRoot, filePath);
}

async function compareWithRevision(filePath, revision) {
    try {
        const gitRoot = await getGitRoot(filePath);
        const relativeFilePath = await getRelativeToGitRoot(filePath);
        const tempFile = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${revision}`);
        
        await new Promise((resolve, reject) => {
            exec(`git show ${revision}:"${relativeFilePath}"`, {
                cwd: gitRoot
            }, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }
                require('fs').writeFileSync(tempFile, stdout);
                resolve();
            });
        });

        const uri1 = vscode.Uri.file(filePath);
        const uri2 = vscode.Uri.file(tempFile);
        
        await vscode.commands.executeCommand('vscode.diff', uri1, uri2, `${path.basename(filePath)} (Current ↔ ${revision})`);
        
        // Clean up temp file after a short delay
        setTimeout(() => {
            try {
                require('fs').unlinkSync(tempFile);
            } catch (err) {
                console.error('Error cleaning up temp file:', err);
            }
        }, 1000);
    } catch (error) {
        vscode.window.showErrorMessage(`Error comparing files: ${error.message}`);
    }
}

async function compareWithBranch(filePath) {
    try {
        const branches = await getBranches(filePath);
        const selectedBranch = await vscode.window.showQuickPick(branches, {
            placeHolder: 'Select a branch to compare with'
        });

        if (selectedBranch) {
            await compareWithRevision(filePath, selectedBranch);
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Error comparing with branch: ${error.message}`);
    }
}

async function showRevisionSelect(filePath) {
    RevisionSelectPanel.createOrShow(vscode.extensions.getExtension('ChenChao.vscode-file-history').extensionPath, filePath);
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

        panel.panel.webview.onDidReceiveMessage(
            async message => {
                await panel.handleWebviewMessage(message);
            },
            undefined,
            context.subscriptions
        );

        // Get the saved view mode preference
        const savedViewMode = await vscode.workspace.getConfiguration().get('fileHistory.viewMode', false);

        // Read the HTML template
        const htmlPath = path.join(context.extensionPath, 'media', 'main.html');
        let html = require('fs').readFileSync(htmlPath, 'utf8');

        // Replace the placeholder with the saved view mode
        html = html.replace('{{initialViewMode}}', savedViewMode);

        panel.panel.webview.html = html;
    });

    let compareWithBranchDisposable = vscode.commands.registerCommand('vscode-file-history.compareWithBranch', function () {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            compareWithBranch(editor.document.uri.fsPath);
        }
    });

    let compareWithRevisionDisposable = vscode.commands.registerCommand('vscode-file-history.compareWithRevision', function () {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            showRevisionSelect(editor.document.uri.fsPath);
        }
    });

    context.subscriptions.push(disposable);
    context.subscriptions.push(compareWithBranchDisposable);
    context.subscriptions.push(compareWithRevisionDisposable);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
