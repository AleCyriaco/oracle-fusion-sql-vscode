# Changelog

## 0.9.2

- New mark: a flat database stack in the logo's blue and orange with **OFSQL**
  beneath it, no frame around the artwork. Colours sampled from the reference
  rather than matched by eye. The activity bar icon carries OF over SQL, since
  five letters only fit a 24px square stacked, and stays monochrome because
  that is what the activity bar tints.

## 0.9.1

- **One results panel per connection.** A single panel made every query replace
  the last, which was wrong exactly when it mattered: running the same statement
  against DEV and PROD to compare them left one result and no way to see the
  other. The two now sit side by side as ordinary tabs, each keeping its own
  page and its own paging state — Previous and Next in one no longer move the
  other.
- Exported CSV is offered under the environment's name rather than untitled.

## 0.9.0

- **A connection per editor.** One active connection for the whole window is
  wrong as soon as two environments are open: comparing a query between DEV and
  PROD meant flipping a global setting and remembering which way it pointed. Each
  editor can now be pinned to a connection, and a status bar item shows which one
  the focused editor runs on — click it to change, or to let the editor follow
  the window default again. A pinned editor is marked, so changing the default
  cannot silently move a query you deliberately aimed somewhere.
- The results tab names the environment its rows came from.
- **Set as Active Connection** is now **Set as Default Connection**, which is
  what it does: editors pinned elsewhere keep their own.

## 0.8.1

- **FSQL** on the activity bar icon, set two rows over two so each letter is
  about twice the height four in a line would allow in a 24px square. Drawn as
  stroked paths rather than text, so it renders the same everywhere — and so
  the S reads as an S, which a square stencil does not. The gallery icon keeps
  the database mark with the wordmark beneath it.
- The dictionary guidance is now measured rather than assumed. On a live pod the
  connected user owns nothing, so `USER_TABLES`, `USER_TAB_COLUMNS` and
  `USER_CONS_COLUMNS` are entirely empty; every application name is a synonym
  onto a `_SEC` security view (`AP_INVOICES_ALL` → `AP_INVOICES_ALL_SEC`), which
  is why `ALL_TABLES` is empty too; and `ALL_CONSTRAINTS` holds nothing for
  those views. The model is told all of it, so it does not spend a lookup
  finding out.

## 0.8.0

- **A harness around the model, not just a prompt.** Every generated reply is
  inspected before it can run: one statement, `SELECT` or `WITH` only, and
  nothing that reaches outside the query — no `UTL_`, `DBMS_`, `APEX_`,
  `HTTPURITYPE`, database links or `EXECUTE IMMEDIATE`. A refused reply goes
  back with the reason. This is enforcement, not advice: on a live pod
  `UTL_HTTP.request` returns `ORA-29273`, meaning the call was attempted and
  only the network stopped it.
- **The model can check a name instead of guessing.** A reply that reads only
  the data dictionary is recognised as a lookup rather than an answer: it runs,
  and the rows go back so the real query can be written from them. Up to three
  lookups.
- The prompt carries what the dictionary actually looks like on Fusion, which
  is not what a model expects: the connected user reads through synonyms, so
  `ALL_TABLES` is usually empty for application objects and `ALL_CONS_COLUMNS`
  returns nothing — `ALL_TAB_COLUMNS`, `ALL_OBJECTS` and `ALL_SYNONYMS` are the
  ones that answer.
- Comments and string literals are masked before any of this, so a `--` note
  about deleting rows, or the word UPDATE inside a literal, is not mistaken for
  the statement.

## 0.7.0

- **The identity domain is worked out from the Fusion host.** An unauthenticated
  request to a Fusion page is bounced to whichever domain issues its tokens, so
  the address nobody knows by heart was already there for the asking. Choosing
  single sign-on fills it in; there is a **Detect** button for when it changes.
  Verified against three pods across two tenants.
- Where that domain federates onward — Microsoft Entra, Okta, anything — makes
  no difference: the token still comes from the Oracle domain, and the browser
  follows the rest of the chain with whatever session you already have.

## 0.6.3

- **Test Connection signs in first** on a single-sign-on connection that has no
  session yet, instead of telling you to save the form, close it and run a
  separate command.
- The form rejects the two ways the SSO fields are usually filled in wrong: the
  Fusion pod typed as the identity domain, and a Fusion username typed as the
  OAuth client ID. Both used to be accepted and to fail later with an opaque
  provider error.
- The redirect URI to register is shown in the form, so it can be handed to
  whoever administers the identity domain.

## 0.6.2

- **Adding a key now switches to that provider.** It used to store the key and
  then ask whether to switch, which left a state where the key belonged to one
  provider and the setting to another — and the failure then named a provider
  the user had never chosen.
- **Choosing the compatible endpoint now asks for its URL and model**, instead
  of accepting the choice and failing later with
  *"a compatible endpoint has no default model"*.
- **Fusion: Select AI Provider** switches provider without re-entering a key,
  and says if none is stored for the one you picked.
- The provider list shows each one's default model, so it is clear that
  Anthropic, OpenAI, xAI and DeepSeek need no configuration of their own.

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
