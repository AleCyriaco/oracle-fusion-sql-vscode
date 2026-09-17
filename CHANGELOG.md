# Changelog

## 0.6.1

- Default models corrected against each provider's own quickstart: `gpt-5.6-sol`
  (was `gpt-4o`), `grok-4.6` (was `grok-4`), `deepseek-v4-pro` (was
  `deepseek-chat`). All three had been written from memory and were stale.
- DeepSeek's endpoint is `api.deepseek.com`, not `api.deepseek.com/v1` — it
  serves chat completions at the root.

## 0.6.0

- **Generated statements are checked before you get them.** A model writing SQL
  for a schema it cannot see will occasionally invent a table or a column, and
  the result looks plausible until it is run. Each statement is now executed as
  a single-row page against the active connection; Oracle resolves every
  identifier and names the offending one when it objects
  (`ORA-00904: "X": invalid identifier`), and that error goes back to the model
  to be corrected. Up to three attempts, then it is handed over marked as
  unverified rather than withheld.
- The panel says what happened: *Runs on FUSION-DEV · 7 columns*, or the error
  it could not get past.
- **Copy** and **Save…** join Insert and Run.
- `fusionSql.ai.validate` turns the check off for anyone who would rather not
  spend the round trip.

## 0.5.1

- **xAI (Grok) and DeepSeek** join Anthropic and OpenAI as providers for query
  generation — both speak the OpenAI chat-completions shape, so they needed an
  address and a default model rather than a transport of their own.
- `fusionSql.ai.baseUrl` now applies only to the `compatible` provider. A named
  provider always uses its own endpoint, so a URL left over from a previous
  provider can no longer send your key somewhere you did not intend.
- A missing key now says where to get one for the provider you chose.

## 0.5.0

- **The AI helper is findable now.** Setting it up was a command you had to know
  the name of. The Query History view offers **Add AI Helper (API Key)** until a
  key is stored, explains in a sentence what it does, and then offers
  **Generate Query with AI** instead. Both are also buttons in the view toolbars.
- Panel buttons carry an icon, sit on a comfortable click target rather than the
  browser default, and every one has a tooltip saying what it will do.
- Command titles were reworded to read well as hover tooltips on the toolbar and
  context-menu icons.

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
