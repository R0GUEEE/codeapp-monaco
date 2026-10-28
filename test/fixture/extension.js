// Minimal web extension used by the CI smoke test.
// It exercises both the extension host itself (activate) and the API surface
// the iOS app relies on (commands, configuration, workspace).
const vscode = require('vscode');

function activate(context) {
  console.log('[fixture] activate() called');

  context.subscriptions.push(
    vscode.commands.registerCommand('codify.test.hello', () => {
      const greeting = vscode.workspace
        .getConfiguration('codify.test')
        .get('greeting', 'hello');
      return `${greeting}-from-extension`;
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codify.test.state', () => ({
      activated: true,
      extensionId: 'codify.codify-test-extension',
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) =>
        f.uri.toString()
      ),
      appName: vscode.env.appName,
    }))
  );

  // Signal activation to the page so the smoke test can wait for it.
  globalThis.__fixtureActivated = true;
}

function deactivate() {
  console.log('[fixture] deactivate() called');
}

module.exports = { activate, deactivate };
