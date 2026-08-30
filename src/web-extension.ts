import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";

export const WEB_SEARCH_URL = "https://html.duckduckgo.com/html/?q={query}";
export const WEB_RESULT_MAX_CHARS = 10_000;
export const WEB_FETCH_TIMEOUT_MS = 12_000;
export const WEB_SEARCH_CONCURRENCY = 1;
export const WEB_FETCH_CONCURRENCY = 3;

const browserHeaders: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

export type WebPageResult =
  | {
      ok: true;
      requestedUrl: string;
      finalUrl: string;
      title: string;
      text: string;
    }
  | { ok: false; requestedUrl: string; error: string };

let quietDepth = 0;
let originalWarn: typeof console.warn;
let originalError: typeof console.error;

async function quietly<T>(action: () => Promise<T>): Promise<T> {
  if (quietDepth++ === 0) {
    originalWarn = console.warn;
    originalError = console.error;
    console.warn = () => undefined;
    console.error = () => undefined;
  }
  try {
    return await action();
  } finally {
    if (--quietDepth === 0) {
      console.warn = originalWarn;
      console.error = originalError;
    }
  }
}

export async function fetchReadablePage(
  url: string,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
  timeoutMilliseconds = WEB_FETCH_TIMEOUT_MS,
): Promise<WebPageResult> {
  const timeout = AbortSignal.timeout(timeoutMilliseconds),
    deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    new URL(url);
    const response = await request(url, {
      headers: browserHeaders,
      redirect: "follow",
      signal: deadline,
    });
    if (!response.ok)
      return {
        ok: false,
        requestedUrl: url,
        error: `HTTP ${response.status} ${response.statusText}`.trim(),
      };
    const finalUrl = response.url || url,
      body = await response.text();
    if (!(response.headers.get("content-type") ?? "").includes("html"))
      return {
        ok: true,
        requestedUrl: url,
        finalUrl,
        title: finalUrl,
        text: body.trim(),
      };
    const { document } = parseHTML(body),
      extraction = await quietly(() =>
        Defuddle(document, finalUrl, {
          markdown: true,
          removeImages: true,
        }),
      );
    return {
      ok: true,
      requestedUrl: url,
      finalUrl,
      title: extraction.title || finalUrl,
      text: (extraction.content || "").trim(),
    };
  } catch (error) {
    return {
      ok: false,
      requestedUrl: url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function mapWithConcurrency<Input, Output>(
  items: readonly Input[],
  limit: number,
  action: (item: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      output[index] = await action(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return output;
}

export function normalizeWebUrls(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : [input],
    seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    for (const piece of item.split(/[\s,]+/)) {
      const candidate = piece.trim();
      if (!candidate) continue;
      try {
        const parsed = new URL(candidate);
        if (["http:", "https:"].includes(parsed.protocol)) seen.add(candidate);
      } catch {
        // Invalid model-supplied URLs are reported collectively by the tool.
      }
    }
  }
  return [...seen];
}

export function capWebResult(text: string): string {
  return text.length > WEB_RESULT_MAX_CHARS
    ? `${text.slice(0, WEB_RESULT_MAX_CHARS)}\n…(truncated)`
    : text;
}

export function buildWebSearchUrl(query: string): string {
  return WEB_SEARCH_URL.replace("{query}", encodeURIComponent(query));
}

export function unwrapDuckDuckGoLinks(markdown: string): string {
  const redirect =
    /(?:https?:)?\/\/(?:[a-z0-9-]+\.)?duckduckgo\.com\/l\/\?[^)\s"'<>]*?\buddg=([^&)\s"'<>]+)[^)\s"'<>]*/gi;
  return markdown.replace(redirect, (whole: string, encoded: string) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return whole;
    }
  });
}

const searchFollowUp = [
  "# Next step: evaluate the results",
  "",
  "These are previews — brief, and sometimes stale. If they do not fully answer the question, read the full pages:",
  "1. Choose the most relevant URLs below.",
  "2. Call `fetch_pages` with those URLs.",
  "3. Answer from what you read.",
  "",
].join("\n");

export function formatWebSearchResults(
  results: readonly { query: string; result: WebPageResult }[],
): string {
  const sections = [searchFollowUp];
  for (const { query, result } of results) {
    sections.push(`## Query: "${query}"`);
    if (!result.ok) {
      sections.push(`_search failed: ${result.error}_\n`);
      continue;
    }
    sections.push(
      `${capWebResult(unwrapDuckDuckGoLinks(result.text) || "_no results extracted_")}\n`,
    );
  }
  return sections.join("\n");
}

export function formatFetchedPages(results: readonly WebPageResult[]): string {
  const sections: string[] = [];
  for (const result of results) {
    if (!result.ok) {
      sections.push(
        `## ${result.requestedUrl}\n\n_fetch failed: ${result.error}_\n`,
      );
      continue;
    }
    const header =
      result.finalUrl === result.requestedUrl
        ? result.finalUrl
        : `${result.requestedUrl} → ${result.finalUrl}`;
    sections.push(
      `## ${result.title}\n<${header}>\n\n${capWebResult(result.text) || "_no content extracted_"}\n`,
    );
  }
  return sections.join("\n");
}

const searchParameters = {
  type: "object",
  properties: {
    searches: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description:
        "One or more search queries to run together. Pass several at once to cover a topic from multiple angles in a single call.",
    },
  },
  required: ["searches"],
  additionalProperties: false,
};

const fetchParameters = {
  type: "object",
  properties: {
    urls: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description:
        "One or more page URLs to read. Typically the best results from a prior web_search.",
    },
  },
  required: ["urls"],
  additionalProperties: false,
};

interface PiToolResult {
  content: { type: "text"; text: string }[];
}

interface PiToolApi {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      parameters: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<PiToolResult>;
  }): void;
}

export default function integralWebTools(api: PiToolApi): void {
  api.registerTool({
    name: "web_search",
    label: "web_search",
    description:
      "Search the web. Call this whenever current or external information would change your answer. Returns ranked result pages; follow up with fetch_pages to read the best ones.",
    promptSnippet:
      "web_search(searches: string[]): batch web search; returns ranked result pages",
    parameters: searchParameters,
    async execute(_toolCallId, parameters, signal) {
      const searches = Array.isArray(parameters.searches)
          ? parameters.searches.filter(
              (query): query is string =>
                typeof query === "string" && query.length > 0,
            )
          : [],
        results = await mapWithConcurrency(
          searches,
          WEB_SEARCH_CONCURRENCY,
          async (query) => ({
            query,
            result: await fetchReadablePage(buildWebSearchUrl(query), signal),
          }),
        );
      return {
        content: [{ type: "text", text: formatWebSearchResults(results) }],
      };
    },
  });
  api.registerTool({
    name: "fetch_pages",
    label: "fetch_pages",
    description:
      "Fetch one or more web pages and return their readable content as Markdown. Use it for sources from web_search or URLs you already have.",
    promptSnippet:
      "fetch_pages(urls: string[]): read web pages as clean Markdown",
    parameters: fetchParameters,
    async execute(_toolCallId, parameters, signal) {
      const urls = normalizeWebUrls(parameters.urls);
      if (urls.length === 0)
        return {
          content: [
            {
              type: "text",
              text: "No valid URLs to fetch. Pass each HTTP or HTTPS URL as a separate array element.",
            },
          ],
        };
      const results = await mapWithConcurrency(
        urls,
        WEB_FETCH_CONCURRENCY,
        (url) => fetchReadablePage(url, signal),
      );
      return {
        content: [{ type: "text", text: formatFetchedPages(results) }],
      };
    },
  });
}
