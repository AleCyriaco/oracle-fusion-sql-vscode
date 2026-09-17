# Changelog

## 0.4.1

- **Fixed:** a semicolon inside a comment split the statement, so only the
  comment was sent and the database answered `ORA-00900: invalid SQL statement`
  — which says nothing about the cause. Statements are now split on semicolons
  that actually end a statement, ignoring those inside comments and string
  literals.
- **Fixed:** pagination was skipped whenever a statement began with a comment —
  the shape almost every generated query arrives in, since the generator is
  asked to explain itself on the first line. `OFFSET`/`FETCH` was silently not
  applied and the whole result set came back.
- Comment-only text is now refused up front, with a message that says where to
  put the cursor.

## 0.4.0

- **Query history.** Every run is recorded — statement, connection, row count,
  duration — and appears in a **Query History** view: run again, open in an
  editor, copy, remove. Failures are kept too. Re-running a statement moves its
  entry to the top instead of stacking duplicates.
- **Generate queries with an AI model.** Describe what you want and get Oracle
  SQL written for Fusion: the model is given the dialect rules, the read-only
  constraint, the `_ALL` / `_B` / `_TL` / `_F` conventions and the common table
  names per module. Follow-up requests edit the statement instead of starting
  over. Bring your own key for Anthropic, OpenAI, or any OpenAI-compatible
  endpoint; keys live in the OS keychain and only the text you type is sent.

## 0.3.0

- Packaged for the Visual Studio Marketplace: icon, gallery banner, bundled
  MIT license and this changelog.

## 0.2.2

- **Fixed:** running a query could end in silence. The active connection lived
  in `workspaceState`, which is fragile with no folder open, so the extension
  fell through to a connection picker that races with the command palette
  closing — dismissed before it is seen, and the command returned quietly. The
  active connection now lives in `globalState`, the picker is skipped when only
  one connection exists, and every early return says something.
- **Added:** `Fusion: New Query`, and a button in the view toolbar, opening an
  editor already set to SQL. The Run button and <kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd>
  are contributed for SQL editors, and a file made with <kbd>Ctrl/Cmd</kbd>+<kbd>N</kbd>
  is plain text — so the toolbar looked empty and the extension looked broken.
- **Added:** `Fusion: Show Log`, recording each command, the editor and language
  it ran against, the connection chosen and the row count.
- Running a query from a non-SQL editor now warns, with a one-click
  **Set Language to SQL**.

## 0.2.0

- Connections are edited in a form instead of a chain of input boxes. Every
  field is visible at once, and **Test Connection** runs against what is on
  screen — including a password that has not been saved yet.
- Added **Duplicate Connection**, a grouped context menu and a welcome view.
- Renaming a connection now carries its password and token across.

## 0.1.0

- First release. Connections view, SQL execution with paged results and CSV
  export, username/password and single sign-on (OAuth 2.0 with PKCE),
  automatic deployment of the BI Publisher proxy report, and import from an
  existing `connections.json`.
