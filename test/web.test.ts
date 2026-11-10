import assert from "node:assert/strict";
import test from "node:test";
import integralWebTools, {
  buildWebSearchUrl,
  capWebResult,
  fetchReadablePage,
  formatFetchedPages,
  formatWebSearchResults,
  mapWithConcurrency,
  normalizeWebUrls,
  unwrapDuckDuckGoLinks,
  WEB_FETCH_CONCURRENCY,
  WEB_FETCH_TIMEOUT_MS,
  WEB_RESULT_MAX_CHARS,
  WEB_SEARCH_CONCURRENCY,
} from "../src/pi-extensions/web-tools.ts";

interface RegisteredTool {
  name: string;
  parameters: Record<string, unknown>;
  execute(
    id: string,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: { type: "text"; text: string }[] }>;
}

function registeredWebTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  integralWebTools({
    registerTool(tool) {
      tools.set(tool.name, tool as RegisteredTool);
    },
  });
  return tools;
}

/* @covers WEB-2ED07A71
Given Integral provisions an interactive Pi session or an isolated scheduled-task attempt
	When Pi starts
		Then it has a `web_search` tool that accepts one or more search queries
			And searches the keyless DuckDuckGo HTML endpoint
			And returns ranked links and snippets for Pi to evaluate
			And unwraps DuckDuckGo redirect links to their destination URLs
		And it has a `fetch_pages` tool that accepts one or more HTTP or HTTPS URLs
			And follows redirects
			And returns readable Markdown for HTML pages
			And returns non-HTML response text without HTML extraction
*/
test("[WEB-2ED07A71] web tools search DuckDuckGo and extract selected pages", async () => {
  const tools = registeredWebTools();
  assert.deepEqual([...tools.keys()], ["web_search", "fetch_pages"]);
  assert.equal(
    (tools.get("web_search")!.parameters.properties as any).searches.minItems,
    1,
  );
  assert.equal(
    (tools.get("fetch_pages")!.parameters.properties as any).urls.minItems,
    1,
  );
  assert.equal(
    buildWebSearchUrl("governed agents"),
    "https://html.duckduckgo.com/html/?q=governed%20agents",
  );
  assert.equal(
    unwrapDuckDuckGoLinks(
      "[result](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle&rut=x)",
    ),
    "[result](https://example.com/article)",
  );

  const html = await fetchReadablePage(
    "https://example.test/start",
    undefined,
    async () =>
      new Response(
        "<html><head><title>Readable title</title></head><body><main><h1>Heading</h1><p>Useful body text.</p></main></body></html>",
        { headers: { "content-type": "text/html" } },
      ),
  );
  assert.equal(html.ok, true);
  if (html.ok) {
    assert.match(html.title, /Readable title/);
    assert.match(html.text, /Useful body text/);
  }
  const plain = await fetchReadablePage(
    "https://example.test/data",
    undefined,
    async () =>
      new Response('{"answer":42}', {
        headers: { "content-type": "application/json" },
      }),
  );
  assert.deepEqual(plain, {
    ok: true,
    requestedUrl: "https://example.test/data",
    finalUrl: "https://example.test/data",
    title: "https://example.test/data",
    text: '{"answer":42}',
  });
  assert.match(
    formatFetchedPages([
      {
        ok: true,
        requestedUrl: "https://example.test/start",
        finalUrl: "https://example.test/final",
        title: "Final",
        text: "body",
      },
    ]),
    /start.*→.*final/s,
  );
});

/* @covers WEB-E1060C56
Given Pi calls `web_search` with several queries
	When one search fails, times out, or returns no extractable results
		Then the tool reports that query's failure beside the successful query results
			And serializes searches to avoid bursting the search provider
			And gives each search request at most twelve seconds
Given Pi calls `fetch_pages` with several URL values
	When a value contains repeated, comma-separated, whitespace-separated, malformed, or unsupported-scheme URLs
		Then the tool keeps unique HTTP and HTTPS URLs in input order
			And ignores malformed and unsupported-scheme values
	When no valid URL remains
		Then the tool returns a clear validation result without making a network request
	When one page fails, times out, or returns no extractable content
		Then the tool reports that page's failure beside the successful page results
			And fetches no more than three pages concurrently
			And gives each page request at most twelve seconds
	When a search result or fetched page exceeds the per-result output limit
		Then the tool truncates that result after ten thousand characters with an explicit marker
			And does not let one response consume unbounded model context
*/
test("[WEB-E1060C56] web retrieval normalizes input and bounds concurrency, failures, time, and output", async () => {
  assert.equal(WEB_SEARCH_CONCURRENCY, 1);
  assert.equal(WEB_FETCH_CONCURRENCY, 3);
  assert.equal(WEB_FETCH_TIMEOUT_MS, 12_000);
  assert.deepEqual(
    normalizeWebUrls([
      "https://one.test/a, https://two.test/b",
      "https://one.test/a ftp://ignored.test/file not-a-url",
      42,
      " ",
    ]),
    ["https://one.test/a", "https://two.test/b"],
  );

  let active = 0,
    maximum = 0;
  const values = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (n) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return n * 2;
  });
  assert.deepEqual(values, [2, 4, 6, 8, 10, 12]);
  assert.equal(maximum, 3);

  const timedOut = await fetchReadablePage(
    "https://slow.test/",
    undefined,
    async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal!.reason as Error),
          { once: true },
        );
      }),
    5,
  );
  assert.equal(timedOut.ok, false);
  assert.deepEqual(
    await fetchReadablePage(
      "not a URL",
      undefined,
      async () => new Response("not called"),
    ),
    { ok: false, requestedUrl: "not a URL", error: "Invalid URL" },
  );
  assert.deepEqual(
    await fetchReadablePage(
      "https://denied.test/",
      undefined,
      async () => new Response("denied", { status: 403 }),
    ),
    {
      ok: false,
      requestedUrl: "https://denied.test/",
      error: "HTTP 403",
    },
  );

  const formatted = formatWebSearchResults([
    {
      query: "working",
      result: {
        ok: true,
        requestedUrl: "https://search.test/",
        finalUrl: "https://search.test/",
        title: "results",
        text: "one result",
      },
    },
    {
      query: "broken",
      result: {
        ok: false,
        requestedUrl: "https://search.test/",
        error: "timed out",
      },
    },
  ]);
  assert.match(formatted, /one result/);
  assert.match(formatted, /broken/);
  assert.match(formatted, /search failed: timed out/);
  assert.match(
    formatFetchedPages([
      {
        ok: false,
        requestedUrl: "https://broken.test/",
        error: "offline",
      },
      {
        ok: true,
        requestedUrl: "https://empty.test/",
        finalUrl: "https://empty.test/",
        title: "Empty",
        text: "",
      },
    ]),
    /fetch failed: offline[\s\S]*no content extracted/,
  );
  assert.equal(
    unwrapDuckDuckGoLinks("https://duckduckgo.com/l/?uddg=%E0%A4%A"),
    "https://duckduckgo.com/l/?uddg=%E0%A4%A",
  );

  const capped = capWebResult("x".repeat(WEB_RESULT_MAX_CHARS + 1));
  assert.equal(capped.slice(0, WEB_RESULT_MAX_CHARS), "x".repeat(10_000));
  assert.match(capped, /…\(truncated\)$/);

  const tools = registeredWebTools(),
    originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("unexpected network request");
  };
  try {
    const invalid = await tools
      .get("fetch_pages")!
      .execute("call", { urls: ["ftp://files.test", "not-a-url"] });
    assert.match(invalid.content[0]!.text, /No valid URLs/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    requested.push(url);
    return url.includes("broken.test")
      ? new Response("denied", { status: 502 })
      : new Response("retrieved text", {
          headers: { "content-type": "text/plain" },
        });
  };
  try {
    const search = await tools.get("web_search")!.execute("search", {
      searches: ["first query", 7, ""],
    });
    assert.match(search.content[0]!.text, /retrieved text/);
    assert.equal(
      requested[0],
      "https://html.duckduckgo.com/html/?q=first%20query",
    );
    const pages = await tools.get("fetch_pages")!.execute("fetch", {
      urls: ["https://working.test/", "https://broken.test/"],
    });
    assert.match(pages.content[0]!.text, /retrieved text/);
    assert.match(pages.content[0]!.text, /fetch failed: HTTP 502/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
