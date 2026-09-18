/**
 * Query generation through a language model.
 *
 * Deliberately provider-neutral and dependency-free: each provider here is a
 * single HTTP endpoint, and the extension ships with no runtime dependencies —
 * pulling in two vendor SDKs to make one request each would multiply the
 * package size and the supply-chain surface for no gain.
 */

export type ProviderId = 'anthropic' | 'openai' | 'xai' | 'deepseek' | 'compatible';

export type LlmConfig = {
    provider: ProviderId;
    apiKey: string;
    /** Empty means the provider's default below. */
    model?: string;
    /** Only for 'compatible': an OpenAI-shaped endpoint (Azure, Ollama, OpenRouter…). */
    baseUrl?: string;
    timeoutMs: number;
};

/**
 * The flagship each provider documents for work like this. Model ids drift
 * faster than anything else here, so they are only defaults: a provider that
 * answers 404 gets an error naming `fusionSql.ai.model`, and nothing needs
 * reinstalling to move on.
 *
 * Checked against the providers' own quickstarts, 2026-09-17.
 */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
    anthropic: 'claude-opus-5',
    openai: 'gpt-5.6-sol',
    xai: 'grok-4.6',
    deepseek: 'deepseek-v4-pro',
    compatible: '',
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
    anthropic: 'Anthropic (Claude)',
    openai: 'OpenAI',
    xai: 'xAI (Grok)',
    deepseek: 'DeepSeek',
    compatible: 'OpenAI-compatible endpoint',
};

/**
 * xAI and DeepSeek both serve OpenAI's chat-completions shape, so they need no
 * transport of their own — only where to send it. An empty entry means the
 * endpoint comes from settings.
 */
export const PROVIDER_BASE_URLS: Record<ProviderId, string> = {
    anthropic: 'https://api.anthropic.com',
    // Chat Completions remains supported alongside the newer Responses API.
    openai: 'https://api.openai.com/v1',
    xai: 'https://api.x.ai/v1',
    // DeepSeek serves chat completions at the root, not under /v1.
    deepseek: 'https://api.deepseek.com',
    compatible: '',
};

/** Where to get a key, shown when one is missing or rejected. */
export const PROVIDER_KEY_URLS: Record<ProviderId, string> = {
    anthropic: 'https://console.anthropic.com/settings/keys',
    openai: 'https://platform.openai.com/api-keys',
    xai: 'https://console.x.ai',
    deepseek: 'https://platform.deepseek.com/api_keys',
    compatible: '',
};

/**
 * What the model needs to know to write SQL that actually runs here. The rules
 * are as important as the table names: the transport only accepts a single
 * read-only statement, and pagination is bolted on afterwards.
 */
const SYSTEM_PROMPT = `You write Oracle SQL for an Oracle Fusion Cloud ERP database.

You are not a chat assistant. Every reply you make is sent straight to a database.

OUTPUT CONTRACT
- Reply with one SQL statement and nothing else. No prose, no explanation, no
  markdown fences, no "here is your query", no apology, no follow-up question.
- A leading "-- comment" line is the only place for a remark, and it is optional.
- No trailing semicolon.
- If the request is ambiguous, choose the most common reading and say so in that
  leading comment. Never ask a question back: a question is not a statement and
  cannot be run.
- If the request cannot be answered with a query at all, reply with a single
  comment line beginning "-- cannot:" and the reason.

WHAT YOU MAY WRITE
- SELECT and WITH only. Anything that writes — INSERT, UPDATE, DELETE, MERGE,
  DDL, GRANT, COMMIT — is rejected before it runs.
- One statement. Not two, not a block, no PL/SQL, no BEGIN, no EXECUTE IMMEDIATE.
- Read tables and views. Nothing else: no UTL_ or DBMS_ or APEX_ packages, no
  HTTPURITYPE, no database links. These are not merely discouraged — on this
  database UTL_HTTP genuinely attempts the call, so the harness refuses them.
- No bind variables and no substitution variables; the statement runs as written.
- Do not add OFFSET/FETCH or ROWNUM paging: the client paginates for you.

CHECKING A NAME BEFORE YOU USE IT
If you are unsure a table or column exists, do not guess. Reply with a query
against the data dictionary alone, and the rows come back to you; then answer
the original request. Such a reply is recognised as a lookup, not as the answer,
so it must read nothing but these views:
  ALL_TAB_COLUMNS, ALL_TABLES, ALL_VIEWS, ALL_OBJECTS, ALL_SYNONYMS,
  ALL_TAB_COMMENTS, ALL_COL_COMMENTS, ALL_CONSTRAINTS, ALL_CONS_COLUMNS,
  ALL_INDEXES, ALL_IND_COLUMNS, DUAL

What the dictionary looks like on Fusion, which is not what you may expect:
- The connected user reads through synonyms, so ALL_TABLES is usually EMPTY for
  application objects and ALL_CONS_COLUMNS returns nothing. Do not conclude a
  table is missing from an empty ALL_TABLES.
- Use ALL_TAB_COLUMNS to find both table names and columns:
    SELECT DISTINCT table_name FROM all_tab_columns WHERE table_name LIKE 'PO_HEADERS%'
    SELECT column_name, data_type FROM all_tab_columns WHERE table_name = 'AP_INVOICES_ALL'
- ALL_OBJECTS shows what a name really is (VIEW, SYNONYM), and ALL_SYNONYMS
  resolves it — PO_HEADERS_ALL is a synonym for a security-filtered view.
- Write the name in UPPER CASE when comparing: the dictionary stores it that way.
- Spend a lookup only when it settles something. Two or three at most.

FUSION SCHEMA NOTES
- Tables live in the FUSION schema; reference them unqualified.
- "_ALL" tables are multi-org: filter or group by ORG_ID when the question is
  org-specific.
- "_B" is the base table and "_TL" its translations; join _TL with
  LANGUAGE = USERENV('LANG'), or use the "_VL" view when one exists.
- Date-effective HCM tables ("_F", "_M") need TRUNC(SYSDATE) BETWEEN
  EFFECTIVE_START_DATE AND EFFECTIVE_END_DATE.
- Flexfield values are ATTRIBUTE1..N on the owning table.

COMMON TABLES
- Payables: ap_invoices_all, ap_invoice_lines_all, ap_invoice_distributions_all,
  ap_checks_all, ap_invoice_payments_all, ap_payment_schedules_all,
  poz_suppliers, poz_supplier_sites_all_m
- Receivables: ra_customer_trx_all, ra_customer_trx_lines_all,
  ar_payment_schedules_all, ar_cash_receipts_all, hz_parties, hz_cust_accounts,
  hz_cust_site_uses_all
- General Ledger: gl_je_headers, gl_je_lines, gl_je_batches, gl_code_combinations,
  gl_balances, gl_ledgers, gl_periods
- Purchasing: po_headers_all, po_lines_all, po_line_locations_all,
  po_distributions_all, po_requisition_headers_all, po_requisition_lines_all
- Inventory / items: egp_system_items_b, egp_system_items_tl, inv_org_parameters,
  inv_onhand_quantities_detail, inv_material_txns
- Projects: pjf_projects_all_b, pjf_project_parties
- Fixed assets: fa_additions_b, fa_books, fa_deprn_summary
- HCM: per_all_people_f, per_all_assignments_m, per_person_names_f,
  hr_all_organization_units

PRACTICE
- Put a sensible WHERE on large transaction tables — a date range or a status —
  rather than scanning everything.
- Alias tables and qualify every column in a join.
- Prefer explicit column lists over SELECT * unless asked to see everything.`;

export type GenerateOptions = {
    /** What the user asked for, in their own words. */
    request: string;
    /** The statement being edited, when the user wants it changed rather than replaced. */
    current?: string;
    /**
     * The database's own complaint about `current`, when a previous attempt was
     * rejected. Passing it verbatim is what lets the model fix an identifier it
     * guessed wrong — ORA-00904 names the offending column.
     */
    databaseError?: string;
    /** Why the harness refused the previous reply, when it did. */
    refusal?: string;
    /** Rows from a dictionary query the model asked for. */
    lookup?: { sql: string; table: string };
};

export function buildPrompt(options: GenerateOptions): string {
    const current = options.current?.trim();
    if (options.lookup) {
        return `You asked:\n\n${options.lookup.sql}\n\nThe database returned:\n\n`
            + `${options.lookup.table}\n\n`
            + `Now answer the original request with a single statement: ${options.request}`;
    }
    if (current && options.refusal) {
        return `This reply was refused before it could run, because ${options.refusal}:\n\n`
            + `${current}\n\nReply again, within the rules. The request was: ${options.request}`;
    }
    if (current && options.databaseError) {
        return `This statement was rejected by the database:\n\n${current}\n\n`
            + `The database said:\n\n${options.databaseError}\n\n`
            + `Fix it. The original request was: ${options.request}\n`
            + 'Oracle names the offending object in the error — correct that identifier rather '
            + 'than rewriting the query, and do not invent a table or column to work around it.';
    }
    if (current) {
        return `Current statement:\n\n${current}\n\nChange it so that: ${options.request}`;
    }
    return options.request;
}

export async function generateSql(config: LlmConfig, options: GenerateOptions): Promise<string> {
    if (!config.apiKey) {
        const where = PROVIDER_KEY_URLS[config.provider];
        throw new Error(
            `No API key stored for ${PROVIDER_LABELS[config.provider]}. `
            + `Run "Fusion: Add AI Helper (API Key)"${where ? ` — get one at ${where}` : ''}.`,
        );
    }
    const prompt = buildPrompt(options);

    const raw = config.provider === 'anthropic'
        ? await callAnthropic(config, prompt)
        : await callOpenAiShaped(config, prompt);
    return cleanSql(raw);
}

async function callAnthropic(config: LlmConfig, prompt: string): Promise<string> {
    const body = {
        model: config.model || DEFAULT_MODELS.anthropic,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
    };
    const data = await post(config, `${PROVIDER_BASE_URLS.anthropic}/v1/messages`, body, {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
    }) as { content?: { type: string; text?: string }[]; stop_reason?: string };

    if (data.stop_reason === 'refusal') {
        throw new Error('The model declined to answer that request.');
    }
    // content is a discriminated union; only text blocks carry SQL.
    const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    if (!text.trim()) { throw new Error('The model returned an empty response.'); }
    return text;
}

/**
 * Where a chat-completions request goes. A custom base URL applies only to
 * 'compatible': for the named providers the endpoint is theirs, and honouring a
 * setting left over from another provider would send the key somewhere the user
 * never intended.
 */
export function chatCompletionsUrl(config: Pick<LlmConfig, 'provider' | 'baseUrl'>): string {
    const configured = config.provider === 'compatible'
        ? config.baseUrl
        : PROVIDER_BASE_URLS[config.provider];
    const base = (configured || '').replace(/\/+$/, '');
    if (!base) {
        throw new Error('Set "fusionSql.ai.baseUrl" — a compatible endpoint has no address of its own.');
    }
    return `${base}/chat/completions`;
}

/** OpenAI and every endpoint that mimics its chat-completions shape. */
async function callOpenAiShaped(config: LlmConfig, prompt: string): Promise<string> {
    const url = chatCompletionsUrl(config);
    const model = config.model || DEFAULT_MODELS[config.provider];
    if (!model) {
        throw new Error('Set "fusionSql.ai.model" — a compatible endpoint has no default model.');
    }
    const data = await post(config, url, {
        model,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
        ],
    }, { Authorization: `Bearer ${config.apiKey}` }) as {
        choices?: { message?: { content?: string } }[];
    };

    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) { throw new Error('The model returned an empty response.'); }
    return text;
}

async function post(
    config: LlmConfig, url: string, body: unknown, headers: Record<string, string>,
): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error(`The model did not answer within ${Math.round(config.timeoutMs / 1000)}s.`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        throw new Error(describeFailure(response.status, (await response.text()).slice(0, 400)));
    }
    return response.json();
}

/** Say which knob to turn, since every provider words these differently. */
function describeFailure(status: number, body: string): string {
    const detail = extractMessage(body);
    if (status === 401 || status === 403) {
        return `The API key was rejected (HTTP ${status}). Run "Fusion: Set AI API Key" to replace it.`;
    }
    if (status === 404) {
        return `The model was not found (HTTP 404). Check "fusionSql.ai.model".${detail ? ' ' + detail : ''}`;
    }
    if (status === 429) {
        return 'Rate limited by the provider — wait a moment and try again.';
    }
    return `The provider returned HTTP ${status}.${detail ? ' ' + detail : ''}`;
}

function extractMessage(body: string): string {
    try {
        const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
        return parsed.error?.message ?? parsed.message ?? '';
    } catch {
        return body.slice(0, 200);
    }
}

/**
 * Models are asked for bare SQL and usually comply, but a fenced block still
 * slips through often enough that stripping it is cheaper than a retry.
 */
export function cleanSql(text: string): string {
    let sql = text.trim();
    const fence = /^```(?:[a-zA-Z]*)\n([\s\S]*?)\n?```$/.exec(sql);
    if (fence) { sql = fence[1]; }
    return sql.trim().replace(/;+\s*$/, '');
}

/**
 * The part of a failure worth showing a person — and worth sending back to the
 * model. BI Publisher wraps the database error in several layers of Java
 * exception text; the ORA- line inside is the whole diagnosis, and it names the
 * table or column that was wrong.
 */
export function firstOracleError(message: string): string {
    const ora = /ORA-\d{5}[^\n]*/.exec(message);
    if (ora) { return ora[0].trim(); }
    return message.split('\n')[0].slice(0, 200);
}
