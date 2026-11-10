# Web retrieval behaviors

These behaviors cover the bundled web extension, which Pi uses to search the
public web and read selected pages, and core's built-in public web rule, which
governs that traffic at the gateway.

## WEB-2ED07A71 — Provide web search and page-fetch tools

```text
Given Integral provisions an interactive Pi session or an isolated scheduled-task attempt
	When Pi starts with the bundled web extension enabled
		Then it has a `web_search` tool that accepts one or more search queries
			And searches the keyless DuckDuckGo HTML endpoint
			And returns ranked links and snippets for Pi to evaluate
			And unwraps DuckDuckGo redirect links to their destination URLs
		And it has a `fetch_pages` tool that accepts one or more HTTP or HTTPS URLs
			And follows redirects
			And returns readable Markdown for HTML pages
			And returns non-HTML response text without HTML extraction
```

## WEB-65AA5DDC — Govern read-only public web access

```text
Given an authenticated session sends an HTTP or HTTPS GET request that matches no connection rule
	When the request reaches the gateway
		Then the gateway applies core's built-in public web rule
			And permits the destination without requiring a configured connection
			And attributes and logs the request to the session
			And does not inject a credential through the built-in web rule
			And evaluates every redirected request through the same rule
	When the session attempts a non-GET request that matches only the built-in web rule
		Then the gateway denies the request
			And does not contact the requested upstream
	When software in the container attempts to bypass the gateway
		Then the locked network still prevents direct external access
```

## WEB-E1060C56 — Bound web retrieval failures and output

```text
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
```
