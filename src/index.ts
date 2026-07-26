interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * EPA Regulations MCP — US Environmental Protection Agency regulations (40 CFR).
 *
 * EPA regulations ARE US federal regulations codified in Title 40 of the CFR
 * (Protection of Environment). Agents search "EPA regulation on X", "40 CFR
 * 261", "the Clean Air Act regulation for X" — never "eCFR title 40". This is
 * a thin, EPA-branded, keyless wrapper over the official eCFR API
 * (www.ecfr.gov/api), scoped to the whole of Title 40: part 60 new source
 * performance standards (emissions), part 261 hazardous waste identification
 * (RCRA), part 122 NPDES permits (Clean Water Act), part 141 drinking water,
 * part 262 hazardous waste generators, TSCA parts (700s), etc.
 *
 * DISTINCT from the epa-echo / epa-emissions packs: those return EPA DATA
 * (facility enforcement records, ECHO compliance, GHG emissions figures).
 * THIS pack returns EPA REGULATIONS — the binding rules/regulatory text in
 * 40 CFR.
 *
 * Tools:
 * - epa_regulation: full text of one EPA regulation by citation
 * - epa_search:     keyword search across EPA regulations (40 CFR)
 *
 * Self-contained: does NOT import the eCFR pack — calls the eCFR API directly.
 */


const BASE = 'https://www.ecfr.gov/api';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';
const TITLE = 40;
const CITE = '40 CFR';

// --- XML/entity helpers ------------------------------------------------------
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripHtml(s: unknown): string {
  if (typeof s !== 'string') return '';
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function xmlToText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<\?xml[^>]*\?>/g, '')
      .replace(/<HEAD>[\s\S]*?<\/HEAD>/g, '')
      .replace(/<\/(P|FP|HEAD|DIV\d+)>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

// --- eCFR fetch with per-attempt timeout + 503 retry -------------------------
async function ecfrOnce(path: string, accept: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}${path}`, {
      headers: { Accept: accept, 'User-Agent': UA },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function ecfrFetch(path: string, accept: string, retries = 3): Promise<Response> {
  let res: Response | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      res = await ecfrOnce(path, accept, 12000);
      if (res.status !== 503) return res;
    } catch {
      res = null; // aborted (timeout) or network error — retry
    }
    if (i < retries - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  if (res) return res;
  throw new Error('eCFR temporarily unavailable (the eCFR text endpoint is timing out — retry in a few seconds).');
}

async function ecfrGet(path: string): Promise<Record<string, unknown>> {
  const res = await ecfrFetch(path, 'application/json');
  if (!res.ok) throw new Error(`eCFR: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Record<string, unknown>;
}

// Current currency date for this title, with a 7-day-ago fallback.
async function currentDate(): Promise<string> {
  try {
    const data = await ecfrGet('/versioner/v1/titles.json');
    const titles = Array.isArray(data.titles) ? (data.titles as Array<Record<string, unknown>>) : [];
    const t = titles.find((x) => Number(x.number) === TITLE);
    if (t && typeof t.up_to_date_as_of === 'string' && t.up_to_date_as_of) return t.up_to_date_as_of;
  } catch {
    /* fall through to date fallback */
  }
  return new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
}

// --- citation parsing --------------------------------------------------------
// Forgiving: "261.4", "40 CFR 261.4", "§261.4", "261.4(a)", "part 60", "60".
// Returns the section (part.section) or a bare part.
function parseCitation(raw: string): { section: string | null; part: string | null } {
  let s = raw.trim();
  s = s.replace(/§+/g, ' ');
  s = s.replace(/\b(40\s*cfr|cfr|part|sections?|sec\.?)\b/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  const secMatch = s.match(/(\d{1,4})\.(\d+[A-Za-z]*)/);
  if (secMatch) return { section: `${secMatch[1]}.${secMatch[2]}`, part: secMatch[1] };
  const partMatch = s.match(/\b(\d{1,4})\b/);
  if (partMatch) return { section: null, part: partMatch[1] };
  return { section: null, part: null };
}

// Best-effort subpart lookup for a section, via the eCFR search hierarchy.
async function lookupSubpart(section: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ query: section, per_page: '5', order: 'relevance' });
    params.append('hierarchy[title]', String(TITLE));
    const data = await ecfrGet(`/search/v1/results?${params.toString()}`);
    const results = Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : [];
    for (const r of results) {
      const h = (r.hierarchy as Record<string, unknown> | undefined) ?? {};
      if (h.section != null && String(h.section) === section && h.subpart != null) {
        return String(h.subpart);
      }
    }
  } catch {
    /* ignore — subpart is optional metadata */
  }
  return null;
}

// --- tools -------------------------------------------------------------------
const tools: McpToolExport['tools'] = [
  {
    name: 'epa_regulation',
    description:
      'Get the full text of one EPA regulation — a US Environmental Protection Agency rule codified in 40 CFR — by its citation. Returns the exact regulatory wording currently in force. Answers "what does 40 CFR 261 say", "what is the EPA regulation for X", "does the EPA require X", "read 40 CFR 60.1", "the RCRA hazardous waste rule", "the Clean Air Act / Clean Water Act regulation for X". Forgiving citation input: "261.4", "40 CFR 261.4", "§60.1", even "261.4(a)" (paragraph stripped to the section). Covers 40 CFR part 60 new source performance standards (emission standards / Clean Air Act), part 261 identification & listing of hazardous waste (RCRA), part 262 hazardous waste generators, part 122 NPDES permits (Clean Water Act), part 141 national primary drinking water regulations, part 63 NESHAP air toxics, TSCA parts (700s) toxic substances — the whole of Title 40 (air, water, waste, chemicals). This is EPA REGULATIONS (the rules/regulatory text); for EPA DATA (facility enforcement, ECHO compliance, GHG emissions) use the epa-echo / epa-emissions tools. Pass a whole part (e.g. "261" or "60") to get that part\'s section list. Example: epa_regulation({ citation: "261.4" }) -> exclusions from hazardous waste; epa_regulation({ citation: "40 CFR 60.1" }) -> applicability of emission standards. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        citation: {
          type: 'string',
          description:
            'EPA regulation citation. A section: "261.4", "40 CFR 261.4", "§60.1", "261.4(a)". Or a whole part: "261", "part 60" -> returns the part\'s section list.',
        },
      },
      required: ['citation'],
    },
  },
  {
    name: 'epa_search',
    description:
      'Keyword search across EPA regulations — US Environmental Protection Agency rules in 40 CFR. Answers "what EPA regulations cover X", "the environmental regulation / EPA rule about X", "find the EPA requirement for X". Great for topics: hazardous waste identification (RCRA), emission standards and air quality (Clean Air Act), NPDES water discharge permits (Clean Water Act), drinking water standards, air toxics / NESHAP, toxic substances (TSCA), Superfund / CERCLA, pesticide registration (FIFRA), greenhouse gas reporting requirements, underground storage tanks, stormwater. Returns matching EPA regulations with citation (40 CFR), heading, excerpt, and source URL. This searches EPA REGULATIONS (regulatory text); for EPA DATA (facility enforcement, ECHO, GHG emissions figures) use the epa-echo / epa-emissions tools. Example: epa_search({ query: "hazardous waste identification" }); epa_search({ query: "emission standards", limit: 15 }). Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Environmental-regulation topic or phrase, e.g. "hazardous waste identification", "emission standards", "NPDES permit", "drinking water", "toxic substances".',
        },
        limit: { type: 'number', description: 'Max results to return, 1-20 (default 10).' },
      },
      required: ['query'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'epa_regulation':
        return getRegulation(args);
      case 'epa_search':
        return searchRegulations(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function getRegulation(args: Record<string, unknown>): Promise<unknown> {
  const raw = typeof args.citation === 'string' ? args.citation : '';
  if (!raw.trim()) return { error: 'provide a citation, e.g. "261.4" or "40 CFR 60.1"' };

  const { section, part } = parseCitation(raw);
  if (!part) {
    return {
      error: `Could not parse an EPA citation from "${raw}". Use a section like "261.4" or "40 CFR 60.1", or a part like "261".`,
    };
  }

  const date = await currentDate();

  // ---- whole part requested: return its section list -----------------------
  if (!section) {
    const res = await ecfrFetch(
      `/versioner/v1/full/${date}/title-${TITLE}.xml?part=${encodeURIComponent(part)}`,
      'application/xml',
    );
    if (res.status === 404) return { error: `${CITE} part ${part} not found as of ${date}.`, part, date };
    if (res.status === 503) return { error: 'eCFR temporarily unavailable — retry in a few seconds.', part };
    if (!res.ok) throw new Error(`eCFR: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const xml = await res.text();
    const blocks = xml.split(/<DIV8\b/).slice(1);
    const sections = blocks
      .map((b) => {
        const n = b.match(/\bN="([^"]+)"/)?.[1] ?? null;
        const head = b.match(/<HEAD>([\s\S]*?)<\/HEAD>/);
        return { section: n, heading: head ? stripHtml(head[1]) : null };
      })
      .filter((s) => s.section);
    return {
      part,
      citation: `${CITE} Part ${part}`,
      date,
      source: 'eCFR / EPA 40 CFR',
      source_url: `https://www.ecfr.gov/current/title-${TITLE}/part-${part}`,
      section_count: sections.length,
      note: `This is a whole EPA part (${sections.length} sections). Call epa_regulation with a specific citation (e.g. "${sections[0]?.section ?? part + '.1'}") to get full text.`,
      sections: sections.slice(0, 500),
    };
  }

  // ---- single section ------------------------------------------------------
  const res = await ecfrFetch(
    `/versioner/v1/full/${date}/title-${TITLE}.xml?part=${encodeURIComponent(part)}&section=${encodeURIComponent(section)}`,
    'application/xml',
  );
  if (res.status === 404 || res.status === 400) {
    return {
      error: `EPA regulation ${CITE} ${section} not found as of ${date}. Check the citation, or use epa_search to find it.`,
      citation: `${CITE} ${section}`,
      part,
      date,
    };
  }
  if (res.status === 503) return { error: 'eCFR temporarily unavailable — retry in a few seconds.', citation: `${CITE} ${section}` };
  if (!res.ok) throw new Error(`eCFR: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.text();
  // eCFR returns JSON {"error":"No matching content found."} for removed/absent sections
  if (body.trim().startsWith('{')) {
    return {
      error: `EPA regulation ${CITE} ${section} not found as of ${date}. Check the citation, or use epa_search to find it.`,
      citation: `${CITE} ${section}`,
      part,
      date,
    };
  }
  const xml = body;

  const headMatch = xml.match(/<HEAD>([\s\S]*?)<\/HEAD>/);
  const heading = headMatch ? stripHtml(headMatch[1]) : null;
  const full = xmlToText(xml);
  const CAP = 30000;
  const truncated = full.length > CAP;
  const subpart = await lookupSubpart(section);

  return {
    citation: `${CITE} ${section}`,
    part,
    subpart: subpart ?? null,
    heading,
    text: truncated ? full.slice(0, CAP) : full,
    truncated,
    date,
    source: 'eCFR / EPA 40 CFR',
    source_url: `https://www.ecfr.gov/current/title-${TITLE}/section-${section}`,
  };
}

async function searchRegulations(args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { error: 'provide a query, e.g. "hazardous waste identification" or "emission standards"' };

  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);

  // eCFR search returns one row per matching PARAGRAPH, so a single dense
  // section can fill an entire page. Dedupe by citation and walk up to 3 pages
  // (20/page, the API max) until `limit` distinct sections are collected.
  const seen = new Set<string>();
  const results: Array<Record<string, unknown>> = [];
  let total: unknown = null;

  for (let page = 1; page <= 3 && results.length < limit; page++) {
    const params = new URLSearchParams({
      query,
      per_page: '20',
      page: String(page),
      order: 'relevance',
    });
    params.append('hierarchy[title]', String(TITLE));

    const data = await ecfrGet(`/search/v1/results?${params.toString()}`);
    const meta = (data.meta as Record<string, unknown> | undefined) ?? {};
    if (total == null) total = meta.total_count ?? null;
    const rawResults = Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : [];
    if (rawResults.length === 0) break;

    for (const r of rawResults) {
      if (results.length >= limit) break;
      const h = (r.hierarchy as Record<string, unknown> | undefined) ?? {};
      const headings = (r.headings as Record<string, unknown> | undefined) ?? {};
      const hHeadings = (r.hierarchy_headings as Record<string, unknown> | undefined) ?? {};
      const part = h.part != null ? String(h.part) : null;
      const section = h.section != null ? String(h.section) : null;
      const subpart = h.subpart != null ? String(h.subpart) : null;
      if (!section && !part) continue;
      const heading =
        (typeof headings.section === 'string' && stripHtml(headings.section)) ||
        (typeof hHeadings.section === 'string' && stripHtml(hHeadings.section)) ||
        null;
      let citation: string;
      let source_url: string;
      if (section) {
        citation = `${CITE} ${section}`;
        source_url = `https://www.ecfr.gov/current/title-${TITLE}/section-${section}`;
      } else {
        citation = `${CITE} Part ${part}`;
        source_url = `https://www.ecfr.gov/current/title-${TITLE}/part-${part}`;
      }
      if (seen.has(citation)) continue;
      seen.add(citation);
      results.push({
        part,
        subpart,
        section,
        citation,
        heading,
        excerpt: stripHtml(r.full_text_excerpt ?? (r as Record<string, unknown>).excerpt).slice(0, 300),
        source_url,
      });
    }
    if (rawResults.length < 20) break;
  }

  return {
    query,
    total_matches: total,
    count: results.length,
    scope: 'FCC regulations — 47 CFR (Federal Communications Commission / telecommunications)',
    source: 'eCFR / FCC 47 CFR',
    results,
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
