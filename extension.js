const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const util = require('util');
const execPromise = util.promisify(exec);

// Store active decorations globally
let activeDecorations = new Map();
let isBlameVisible = false;

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
    static lastActiveColumn = undefined;

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
        this._loadCommits();
    }

    static createOrShow(extensionPath, filePath) {
        RevisionSelectPanel.lastActiveColumn = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        const column = RevisionSelectPanel.lastActiveColumn || vscode.ViewColumn.One;

        if (RevisionSelectPanel.currentPanel) {
            RevisionSelectPanel.currentPanel.panel.reveal(column);
            return RevisionSelectPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            RevisionSelectPanel.viewType,
            'Select Revision',
            column,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(path.join(extensionPath, 'media'))],
                retainContextWhenHidden: true
            }
        );

        RevisionSelectPanel.currentPanel = new RevisionSelectPanel(panel, extensionPath, filePath);
        return RevisionSelectPanel.currentPanel;
    }

    async _loadCommits() {
        try {
            const commits = await this._getDetailedCommitHistory(this.filePath);
            this.panel.webview.postMessage({ type: 'commits', commits });
        } catch (error) {
            vscode.window.showErrorMessage(`Error loading history: ${error.message}`);
        }
    }

    _getDetailedCommitHistory(filePath) {
        return new Promise((resolve, reject) => {
            // Get current commit hash for the specific file
            exec(`git rev-list -1 HEAD "${filePath}"`, {
                cwd: path.dirname(filePath)
            }, (error, currentHash, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }

                currentHash = currentHash.trim();

                // Then get the commit history
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
                                message: messageParts.join('|'),
                                isCurrent: hash === currentHash
                            };
                        });

                    resolve(commits);
                });
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
            // Don't dispose the panel, just hide it
            this.panel.visible = false;
        }
    }

    show() {
        this.panel.reveal(RevisionSelectPanel.lastActiveColumn);
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
        
        // Create a diff editor with a back button
        const diffTitle = `${path.basename(filePath)} (Current ↔ ${revision})`;
        const diff = await vscode.commands.executeCommand('vscode.diff', uri1, uri2, diffTitle);
        
        // Add back button to editor title
        const backButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        backButton.text = "$(arrow-left) Back to Revision Selection";
        backButton.tooltip = "Go back to revision selection";
        backButton.command = 'vscode-file-history.backToRevisionSelect';
        backButton.show();

        // Clean up temp file and back button when diff editor is closed
        const disposable = vscode.window.onDidChangeVisibleTextEditors(editors => {
            const isDiffStillOpen = editors.some(e => e.document.uri.fsPath === tempFile);
            if (!isDiffStillOpen) {
                try {
                    require('fs').unlinkSync(tempFile);
                    backButton.dispose();
                    disposable.dispose();
                } catch (err) {
                    console.error('Error cleaning up:', err);
                }
            }
        });
        
    } catch (error) {
        vscode.window.showErrorMessage(`Error comparing files: ${error.message}`);
    }
}

async function compareWithBranch(filePath) {
    try {
        const gitRoot = await getGitRoot(filePath);
        const relativePath = await getRelativeToGitRoot(filePath);
        
        // Get list of branches
        const { stdout: branchOutput } = await execPromise('git branch', { cwd: gitRoot });
        const branches = branchOutput.split('\n')
            .map(b => b.trim().replace('* ', ''))
            .filter(b => b);
        
        // Let user select a branch
        const selectedBranch = await vscode.window.showQuickPick(branches, {
            placeHolder: 'Select a branch to compare with'
        });
        
        if (!selectedBranch) {
            return; // User cancelled
        }
        
        // Get the git show output for the file in the selected branch
        const { stdout: fileContent } = await execPromise(`git show ${selectedBranch}:${relativePath}`, { cwd: gitRoot });
        
        // Create a temporary file with the branch content
        const tempDir = path.join(gitRoot, '.git', 'temp');
        if (!require('fs').existsSync(tempDir)) {
            require('fs').mkdirSync(tempDir, { recursive: true });
        }
        const tempFile = path.join(tempDir, `${path.basename(filePath)}.${selectedBranch}`);
        require('fs').writeFileSync(tempFile, fileContent);

        // Open diff view
        await vscode.commands.executeCommand('vscode.diff',
            vscode.Uri.file(tempFile),
            vscode.Uri.file(filePath),
            `${path.basename(filePath)} (${selectedBranch} ↔ Current)`
        );

        // Clean up temp file after a delay
        setTimeout(() => {
            try {
                require('fs').unlinkSync(tempFile);
            } catch (e) {
                // Ignore cleanup errors
            }
        }, 1000);
    } catch (error) {
        vscode.window.showErrorMessage(`Error comparing with branch: ${error.message}`);
    }
}

function showRevisionSelect(filePath) {
    RevisionSelectPanel.createOrShow(vscode.extensions.getExtension('ChenChao.vscode-file-history').extensionPath, filePath);
}

async function showGitBlame(filePath) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active text editor found');
        return;
    }

    try {
        const gitRoot = await getGitRoot(filePath);
        const relativePath = await getRelativeToGitRoot(filePath);
        
        // Get git blame information
        const { stdout } = await execPromise(`git -C "${gitRoot}" blame -l --date=short "${relativePath}"`);
        const blameLines = stdout.split('\n');
        
        // Clear any existing decorations
        clearGitBlame();
        
        // Create decorations for each line
        blameLines.forEach((blameLine, index) => {
            if (!blameLine) return;
            
            const match = blameLine.match(/^([^\(]+)\s*\((.*?)\s+(\d{4}-\d{2}-\d{2})/);
            if (match) {
                const [, commitId, author, date] = match;
                const decoration = vscode.window.createTextEditorDecorationType({
                    after: {
                        contentText: `  ${author} • ${date.slice(2)} • ${commitId.slice(0, 7)}`,
                        color: '#888888',
                        margin: '0 0 0 3em',
                    }
                });
                activeDecorations.set(index, decoration);
            }
        });

        // Apply decorations
        activeDecorations.forEach((decoration, line) => {
            const range = new vscode.Range(line, 0, line, 0);
            editor.setDecorations(decoration, [range]);
        });

        isBlameVisible = true;
        vscode.commands.executeCommand('setContext', 'gitBlameVisible', true);

    } catch (error) {
        vscode.window.showErrorMessage(`Error showing git blame: ${error.message}`);
    }
}

function clearGitBlame() {
    activeDecorations.forEach(decoration => decoration.dispose());
    activeDecorations.clear();
    isBlameVisible = false;
    vscode.commands.executeCommand('setContext', 'gitBlameVisible', false);
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

    let compareWithRevisionDisposable = vscode.commands.registerCommand('vscode-file-history.compareWithRevision', function () {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            showRevisionSelect(editor.document.uri.fsPath);
        }
    });

    let compareWithBranchDisposable = vscode.commands.registerCommand('vscode-file-history.compareWithBranch', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            compareWithBranch(editor.document.uri.fsPath);
        }
    });

    let showGitBlameCommand = vscode.commands.registerCommand('vscode-file-history.showGitBlame', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            showGitBlame(editor.document.uri.fsPath);
        }
    });

    let closeGitBlameCommand = vscode.commands.registerCommand('vscode-file-history.closeGitBlame', () => {
        clearGitBlame();
    });

    // Clean up decorations when the editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            clearGitBlame();
        })
    );

    context.subscriptions.push(disposable);
    context.subscriptions.push(compareWithRevisionDisposable);
    context.subscriptions.push(compareWithBranchDisposable);
    context.subscriptions.push(showGitBlameCommand);
    context.subscriptions.push(closeGitBlameCommand);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
