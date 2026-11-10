# Development workflow behaviors

These behaviors cover the repository's local verification commands.

## DEV-8A71E49C — Validate package contents without a writable npm home cache

```text
Given a developer runs the package validation command with an unusable inherited npm cache location
	When the command packages Integral for validation
		Then it uses an owned temporary npm cache
			And completes package validation without writing to the inherited cache location
```
