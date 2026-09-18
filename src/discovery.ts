/**
 * Finding the identity domain from the Fusion host.
 *
 * An unauthenticated request to a Fusion page is bounced to whichever identity
 * domain issues its tokens, so the address the user would otherwise have to
 * look up in the Oracle Cloud console is already there for the asking. Where
 * that domain federates onward — to Microsoft Entra, Okta, or anything else —
 * makes no difference here: the token still comes from the Oracle domain, and
 * the browser follows the rest of the chain on its own.
 */
import { normalizeBaseUrl } from './protocol';

/** A page that always requires authentication, so it always redirects. */
const PROBE_PATH = '/fscmUI/faces/FuseWelcome';
const MAX_HOPS = 6;

/**
 * The identity domain among a redirect chain, or undefined.
 * Pure, so the matching rules can be tested without a pod.
 */
export function pickIdentityDomain(urls: string[]): string | undefined {
    for (const raw of urls) {
        let url: URL;
        try { url = new URL(raw); } catch { continue; }
        // Either signal is enough on its own: the well-known Oracle identity
        // hostname, or any host that answers on the OAuth authorize path.
        if (/^idcs-[0-9a-f]+\.identity\./i.test(url.hostname)
            || /\/oauth2\/v1\/authorize$/i.test(url.pathname)) {
            return url.hostname;
        }
    }
    return undefined;
}

export type FetchLike = (url: string, init: { redirect: 'manual' }) => Promise<{
    headers: { get(name: string): string | null };
}>;

/** Walk the redirect chain from the Fusion host and return the identity domain. */
export async function discoverIdentityDomain(
    fusionHost: string,
    timeoutMs = 20_000,
    fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
    const visited: string[] = [];
    let url = `${normalizeBaseUrl(fusionHost)}${PROBE_PATH}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        for (let hop = 0; hop < MAX_HOPS; hop++) {
            visited.push(url);
            const found = pickIdentityDomain(visited);
            if (found) { return found; }

            const response = await fetchImpl(url, { redirect: 'manual' });
            const location = response.headers.get('location');
            if (!location) { break; }
            url = location.startsWith('http') ? location : new URL(location, url).toString();
        }
        const found = pickIdentityDomain([...visited, url]);
        if (found) { return found; }
    } finally {
        clearTimeout(timer);
    }
    throw new Error(
        'Could not work out the identity domain from that host. Check the Fusion host, or enter '
        + 'the domain by hand — the Oracle Cloud console lists it under Identity & Security → Domains.',
    );
}
