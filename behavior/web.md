# Web retrieval behaviors

These behaviors cover the built-in, credential-free tools Pi uses to search
the public web and read selected pages through Integral's governed gateway.

## WEB-2ED07A71 — Provide web search and page-fetch tools

```text
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
```

## WEB-65AA5DDC — Govern read-only public web access

```text
Given an authenticated Pi session uses `web_search` or `fetch_pages`
	When the tool makes an HTTP or HTTPS GET request
		Then the request uses the session-authenticated Integral gateway
			And the gateway permits the destination without requiring a configured connection
			And attributes and logs the request to the session
			And does not inject a credential through the built-in web boundary
			And evaluates every redirected request through the same boundary
	When the session attempts a non-GET request through the built-in web boundary
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
