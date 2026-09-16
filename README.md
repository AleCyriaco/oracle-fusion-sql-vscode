# Oracle Fusion SQL — VS Code extension

Run SQL against **Oracle Fusion Cloud** from VS Code. No JDBC, no Java, no
SQL Developer: the extension talks to BI Publisher over HTTPS by itself.

Queries travel as a parameter of a small BI Publisher proxy report — the SQL is
gzipped and base64-encoded, the proxy's data model decodes it inside the
database and opens a cursor, and the rows come back as delimited text.

## Install

```
npm install && npm run compile && npm run package
```

then **Extensions → … → Install from VSIX**. Press <kbd>F5</kbd> in this folder
to run it from source in an Extension Development Host.

## Using it

1. **Oracle Fusion** in the activity bar → **+** to add a connection, or
   **Fusion: Import from connections.json** to reuse an existing
   `fusion-query` / MCP setup.
2. Click a connection to make it active.
3. Open a `.sql` file and press <kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd>.

Results open beside the editor, one page at a time, with **Export CSV**.

## Signing in

**Username and password** — the ordinary case. Works everywhere, and can deploy
the proxy report for you the first time you connect.

**Single sign-on (OAuth 2.0)** — browser sign-in against IDCS / OCI IAM using
Authorization Code with PKCE, so no client secret ships with the extension. You
need an application registered in your identity domain with
`vscode://alecyriaco.fusion-sql/auth` as a redirect URI, and its client ID.

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

## Settings

| Setting | Meaning |
|---|---|
| `fusionSql.connections` | Environments. See below. |
| `fusionSql.pageSize` | Rows per page (default 200). |
| `fusionSql.timeoutSeconds` | HTTP timeout (default 120). |

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
