# Oracle Fusion SQL — VS Code extension

> An independent open-source project. Not affiliated with, endorsed by, or
> sponsored by Oracle Corporation. Oracle and Oracle Fusion are trademarks of
> Oracle Corporation.

Run SQL against **Oracle Fusion Cloud** from VS Code. No JDBC, no Java, no
SQL Developer: the extension talks to BI Publisher over HTTPS by itself.

Queries travel as a parameter of a small BI Publisher proxy report — the SQL is
gzipped and base64-encoded, the proxy's data model decodes it inside the
database and opens a cursor, and the rows come back as delimited text.

## Install

Download the packaged extension from the
[latest release](https://github.com/AleCyriaco/oracle-fusion-sql-vscode/releases/latest)
and install it from inside VS Code: <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>
→ **Extensions: Install from VSIX…**

> Installing with `code --install-extension` **while VS Code is running** is not
> reliable: the running instance rewrites its extension list from memory and
> reverts the change, after the CLI has already reported success. Either install
> from inside VS Code as above, or quit it first:
>
> ```bash
> curl -L -o /tmp/fusion-sql.vsix https://github.com/AleCyriaco/oracle-fusion-sql-vscode/releases/latest/download/fusion-sql.vsix
> osascript -e 'quit app "Visual Studio Code"'
> code --install-extension /tmp/fusion-sql.vsix --force && open -a "Visual Studio Code"
> ```
>
> Confirm with `code --list-extensions --show-versions | grep fusion-sql`.

### Publishing (maintainers)

Upload the `.vsix` at
[marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
— drag and drop, and the version in `package.json` is what identifies it.

That page needs nothing but the Microsoft account that owns the publisher. The
`vsce publish` route additionally requires a personal access token from an
Azure DevOps **organization**, and creating one can demand a linked Azure
subscription — a detour worth skipping unless publishing is automated.

To build it yourself:

```
npm install && npm run compile && npm run package
```

Press <kbd>F5</kbd> in this folder to run from source in an Extension
Development Host.

## Using it

1. **Oracle Fusion** in the activity bar → **+** for a new connection, or
   **Import from connections.json** to reuse an existing `fusion-query` / MCP
   setup.
2. Fill the form and press **Test Connection** before saving — a wrong host or
   password is only ever discovered by trying.
3. Click a connection to make it active.
4. **New Query** in the view toolbar opens an editor already set to SQL. Press
   <kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd>, or click ▷ in the editor toolbar.

> The Run button and the keybinding only appear on editors whose language is
> **SQL**. A file made with <kbd>Ctrl/Cmd</kbd>+<kbd>N</kbd> starts as plain
> text, so the toolbar looks empty — use **New Query**, or click the language
> name in the status bar and pick SQL.

Every query you run is kept under **Query History** — right-click to run it
again, open it in an editor, copy it, or remove it. A query that failed is kept
too: that is the one you come back to fix.

Right-click a connection for **Test**, **Edit**, **Duplicate**, **Delete**, and
**Sign In / Sign Out** on SSO connections. Editing opens the same form, with the
stored password left alone unless you type a new one; renaming carries the
secrets across.

Results open beside the editor, one page at a time, with **Export CSV**.

## Signing in

**Username and password** — the ordinary case. Works everywhere, and can deploy
the proxy report for you the first time you connect.

**Single sign-on (OAuth 2.0)** — browser sign-in against IDCS / OCI IAM using
Authorization Code with PKCE, so no client secret ships with the extension. You
need an application registered in your identity domain with
`vscode://AleCyriaco.fusion-sql/auth` as a redirect URI, and its client ID.

> **SSO cannot deploy the proxy report.** BI Publisher's SOAP services
> authenticate from `<v2:userID>`/`<v2:password>` *inside the request envelope*,
> which a bearer token cannot satisfy. An SSO connection therefore requires
> `reportPath` to point at a proxy report that already exists — deploy it once
> with a username/password connection, or share one.
>
> Some pods also answer the BI Publisher REST endpoint with HTTP 500 and only
> work over SOAP. On those, SSO cannot run queries either, and the extension
> says so instead of failing obscurely.

Passwords and tokens go to **VS Code SecretStorage** (the OS keychain). Settings
hold only the host, username and report path, so they stay safe to sync.

## Generating queries with an AI model

**Fusion: Generate Query with AI** (or the ✨ button on a SQL editor) opens a
panel: describe what you want, get a statement, then keep asking for changes —
each follow-up edits the statement rather than starting over. Copy it, save it
to a file, insert it into the editor, or run it straight away.

**The statement is checked before you get it.** A model writing SQL for a schema
it cannot see will occasionally invent a table or a column, and the result looks
perfectly plausible until it is run. So the extension runs it — a single-row page
against your active connection. Oracle resolves every identifier and, when it
objects, names the offending one:

```
ORA-00904: "COLUNA_QUE_NAO_EXISTE": invalid identifier
```

That error goes straight back to the model, which corrects that identifier
rather than rewriting the query. Up to three attempts, then the statement is
handed over anyway — marked as unverified, because you may know something the
model does not. The panel says which happened: *Runs on FUSION-DEV · 7 columns*,
or the error it could not get past. Turn the whole thing off with
`fusionSql.ai.validate` if you would rather not spend the round trip.

The model is told what it needs to know to be useful here: Oracle dialect rather
than generic SQL, `SELECT` only, no hand-written paging (the client adds it), and
the Fusion conventions that trip people up — `_ALL` multi-org tables, `_B`/`_TL`
translations, date-effective `_F`/`_M` rows — along with the usual table names
across Payables, Receivables, GL, Purchasing, Inventory, Projects, Assets and HCM.

Bring your own key — **Add AI Helper (API Key)**, offered in the Query History
view until one is stored, or from the view toolbar:

```
Fusion: Add AI Helper (API Key)
```

| Provider | Default model | Endpoint |
|---|---|---|
| Anthropic | `claude-opus-5` | `api.anthropic.com` |
| OpenAI | `gpt-4o` | `api.openai.com` |
| xAI (Grok) | `grok-4` | `api.x.ai` |
| DeepSeek | `deepseek-chat` | `api.deepseek.com` |
| OpenAI-compatible | *(set one)* | your own — Azure OpenAI, OpenRouter, Ollama, vLLM, via `fusionSql.ai.baseUrl` |

Change the model with `fusionSql.ai.model`; a model that no longer exists comes
back as a plain "not found" naming that setting. `fusionSql.ai.baseUrl` applies
only to the compatible provider — the named ones always use their own endpoint,
so a setting left over from another provider cannot send your key elsewhere.

Keys go to the OS keychain, the same place as connection passwords, and are sent
only to the provider you selected. Nothing about your connections, credentials or
query results is sent anywhere — only the words you type in the panel and the
statement being edited.

## Settings

| Setting | Meaning |
|---|---|
| `fusionSql.connections` | Environments. See below. |
| `fusionSql.pageSize` | Rows per page (default 200). |
| `fusionSql.timeoutSeconds` | HTTP timeout (default 120). |
| `fusionSql.ai.provider` | `anthropic`, `openai` or `compatible`. |
| `fusionSql.ai.model` | Model id; blank uses the provider default. |
| `fusionSql.ai.baseUrl` | Endpoint for the `compatible` provider. |
| `fusionSql.ai.timeoutSeconds` | How long to wait for the model (default 90). |
| `fusionSql.ai.validate` | Run a generated statement before handing it over, and send any database error back to be fixed (default on). |

```jsonc
"fusionSql.connections": [
  {
    "name": "FUSION-DEV",
    "url": "pod.fa.us2.oraclecloud.com",
    "authMode": "basic",
    "user": "FUSION_USER"
  },
  {
    "name": "PROD-SSO",
    "url": "pod.fa.us2.oraclecloud.com",
    "authMode": "sso",
    "reportPath": "/Custom/FusionQuery/v1/csv.xdo",
    "oauth": {
      "authorizeUrl": "https://idcs-xxxx.identity.oraclecloud.com/oauth2/v1/authorize",
      "tokenUrl": "https://idcs-xxxx.identity.oraclecloud.com/oauth2/v1/token",
      "clientId": "abc123",
      "scope": "openid offline_access"
    }
  }
]
```

## Limits

- **Read-only.** The proxy runs `SELECT`; there is no DML, DDL or PL/SQL.
- Pagination is added automatically as `OFFSET … FETCH NEXT`, unless the
  statement already paginates.
- Values are returned as text, exactly as BI Publisher formatted them — so a
  15-digit `PO_HEADER_ID` keeps every digit instead of becoming a float.

## Troubleshooting

**Fusion: Show Log** (or *Output* → **Oracle Fusion SQL**) records every command,
the editor and language it ran against, the connection it chose and the row count
— so a command that appears to do nothing can be traced to the step that stopped.

## Developing

```
npm test          # protocol, CSV, ZIP and template patching
npm run watch
```

The layers are deliberately separate: `protocol.ts` and `zip.ts` are pure
functions with no VS Code and no I/O, which is why they can be unit-tested with
plain `node --test`.

## License

MIT.
