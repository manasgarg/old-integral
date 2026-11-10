# Named persistent-agent products: Muse, Claude Duet, "Codex Dots", "Inventive"

Research date: 2026-11-10. Quality note: Meta (Muse) and Anthropic (Claude Duet) have published primary safety/architecture write-ups. OpenAI (Dots) has a help-center article, but it returned 403 to the fetcher, so Dots internals here come mostly from third-party inspection (Cyera, MacStories). "Inventive" could not be matched to any persistent-agent product. The likeliest intended product is **Instinct**, whose sandbox has been inspected first-hand by third parties. This is my inference and is flagged below.

## 1. What is each product, who makes it, and is it persistent?

### Takeaway
Three of the four names match a cluster of consumer "always-on personal agent" launches from Sept–Oct 2026: Meta Muse (Sept 8), OpenAI Dots (Sept 29, DevDay; "Codex Dots" is not an official name), and Anthropic Claude Duet (Oct 21, research preview). Each gives every user or agent its own persistent cloud VM with a browser. "Inventive" did not match a product in this category. The only company by that name is Inventive AI, a YC RFP-automation startup. The likely intended product is Instinct, a heavily funded personal-agent startup.

### Cited Findings
- **Meta Muse**: Meta's personal agent, GA 8 Sep 2026, per Dealroom's list of 9 big-tech personal-agent launches — [Dealroom](https://dealroom.co/charts/personal-ai-agent-startups). Meta's safety post (8 Sep 2026, author Tarek Sheasha) says each user gets a dedicated cloud VM, "an isolated linux box with a browser and enough storage, CPU, and memory to do real work" — [Meta/Muse blog](https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse) (research.meta.ai redirects here).
- "Muse" is ambiguous. **Muse Code** is a separate Meta terminal coding agent (beta 5 Aug 2026). It reportedly sandboxes shell commands with Seatbelt (macOS) and bubblewrap (Linux), and its "background agents" are local and session-scoped — [Codersera guide (third-party)](https://codersera.com/blog/muse-code-complete-guide-2026/). "Muse Spark 1.1" appears as the model name in a security write-up — [itadon (third-party)](https://itadon.com/blog/muse-ai-agent-security/).
- **Claude Duet**: Anthropic research preview launched 21 Oct 2026. It is described as "a new app where Claude works as a proactive agent... keeps working when you step away, and checks with you before it acts on your behalf" — [Claude on X](https://x.com/claudeai/status/2112984664256241837); [MacRumors](https://www.macrumors.com/2026/10/21/anthropic-claude-duet/). It is waitlisted for US Pro/Max users, runs on Opus 5.5, and has its own VM and browser. CNBC frames it as Anthropic's answer to Meta Muse and OpenAI Dots — [CNBC](https://www.cnbc.com/2026/10/21/anthropic-preview-of-claude-duet-personal-ai-agent-take-on-muse-dots.html); [TechCrunch](https://techcrunch.com/2026/10/22/claude-duet-app-is-anthropics-bet-on-agents/). Sources disagree on whether it is iOS-only or on iOS and Android, and on whether Ultra subscribers are included (search-summary discrepancy).
- **OpenAI Dots** (not "Codex Dots"): announced at DevDay on 29 Sep 2026. Dots are persistent, cloud-based agents inside the ChatGPT app, each with its own virtual Linux computer — [Dealroom](https://dealroom.co/charts/personal-ai-agent-startups); [MacStories](https://www.macstories.net/stories/openais-dots-a-first-look/). A dot can start work in Codex and follow up on Codex threads, which likely explains the "Codex Dots" name — [OpenAI Developer Community](https://community.openai.com/t/fresh-dots-updates-create-in-the-mobile-app-delegate-to-codex/1404834). It reportedly runs on "GPT-6 Astra" — [Cyera](https://www.cyera.com/research/dots-a-double-edged-sword-in-the-workplace).
- **"Inventive"**: the only match is Inventive AI (YC, founded 2023, about 15 employees, San Francisco), which builds AI agents for RFP and security-questionnaire responses. It is not a persistent consumer agent and I found no sandbox documentation — [YC profile](https://www.ycombinator.com/companies/inventive-ai). Relevance AI's "Invent 2.0" (29 Sep 2026) is an agent-workforce builder, not a persistent personal agent — [PR Newswire](https://www.prnewswire.com/news-releases/relevance-ai-launches-invent-2-0-to-help-companies-quickly-build-test-and-iterate-autonomous-ai-agent-workforces-302890646.html).
- **Instinct** (candidate for "Inventive"): personal-agent startup that raised about $1.4B in 2026, including a Series C at a $10B valuation on 28 Sep — [Dealroom](https://dealroom.co/charts/personal-ai-agent-startups). It is a personal agent you text over iMessage, with its own computer (per an open-source clone's description) — [open-instinct GitHub](https://github.com/mariagorskikh/open-instinct). Security researchers write about "Instinct and Muse sandboxes" together — [amirzak Substack](https://amirzak.substack.com/p/achieving-code-execution-inside-instinct).

### Inferences
- All four real products (Muse, Duet, Dots, Instinct) are "persistent" in the sense of long-lived identity, memory, and background work. Their sandbox lifecycles differ: Muse and Dots keep a persistent per-user or per-agent VM, while Instinct uses disposable sandboxes plus externally stored memory.
- "Inventive" is probably a misremembering of "Instinct". The names are similar, both are startups, and Instinct is the most prominent sandbox-based personal-agent startup of 2026. This is unconfirmed; the user should verify.

### Gaps
- No product named "Inventive" (or "Inventiv") with persistent sandboxed agents could be found.
- No official OpenAI architecture/security post on Dots was retrieved. The help center returned 403.

## 2. Sandbox technology and infrastructure provider

### Takeaway
- **Muse**: per-user cloud VM, with the agent harness inside a `systemd-nspawn` "runtime cell" (seccomp filtering, dropped capabilities, user-namespace root mapping). Meta's own infrastructure, with confidential VMs planned.
- **Claude Duet**: a "cloud-based computer" plus a separate dedicated browser VM. Anthropic does not name the hypervisor.
- **Dots**: Kata-VM boundary plus a bubblewrap sandbox. This comes from one third party's inspection, and another blog contradicts it.
- **Instinct**: E2B Firecracker microVMs, observed first-hand by a third party.

### Cited Findings
- **Muse** (official): the agent harness (the "Hatch" daemon), workspace, and tools run in a `systemd-nspawn` runtime cell. The cell has its own Debian rootfs; root in the cell maps to an unprivileged host user; it has a virtual NIC, filtered syscalls (e.g. no `io_uring`), and dropped capabilities (no `CAP_SYS_PTRACE` or `CAP_NET_ADMIN`). Outside the cell, the same VM hosts: `hatch-safety` classifiers, `privsep` for connector code, `hatch-authd` for credentials, Sentinel for permissions and egress, Postgres for durable app state, and inference/telemetry proxies. The cell reaches these services over Unix domain sockets with SO_PEERCRED and peer ACLs — [Meta/Muse blog](https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse).
- **Muse**: a Confidential VM, meant to cryptographically prevent Meta from accessing VM data, is planned for "later this year" (2026). Trusted testers already use it, and external auditors are reviewing the design and code. Hosting and hypervisor are not disclosed — [Meta/Muse blog](https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse).
- **Claude Duet** (official): the agent works on "a cloud-based computer". The browser "runs in its own dedicated virtual machine in the cloud," separate from the model and from the agent's computer. The agent drives it only through a fixed command set ("open this page, click here, type this"). Site code, cookies, and downloads stay on the browser machine. Duet uses a distinct User-Agent and publishes its egress IPs. Sandbox technology is not named — [Claude Duet safety page, 23 Oct 2026](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security).
- **Dots** (third-party inspection): Debian 13, XFCE over X11, Chrome, terminal. The model runs as unprivileged user `agent` with no Linux capabilities and read-only system directories. The container sits in a Kata VM boundary with bubblewrap on top — [Cyera, 14 Oct 2026](https://www.cyera.com/research/dots-a-double-edged-sword-in-the-workplace). One blog instead claims a Firecracker-optimized lightweight VM — [search summary of kie.ai/innotechinsider blogs](https://kie.ai/blog/openai-dots-always-on-agents-architecture-deep-dive) (low reliability; contradicts Cyera).
- **Dots**: a user can also connect one personal Mac, which must stay online with the ChatGPT app open. By default, a dot cannot reach local files — [MacStories](https://www.macstories.net/stories/openais-dots-a-first-look/).
- **Instinct** (third-party inspection of a live sandbox): Firecracker microVM on KVM. The author lists as evidence virtio-MMIO, no PCI, no SMBIOS, and a `tap0` interface, and `systemd-detect-virt` reports `kvm`. The provider is E2B (hostname `e2b.local`, a `/.e2b` file holds a sandbox ID). The guest is Ubuntu 22.04.5 with systemd and XFCE, 2 vCPU, 1.9 GB RAM, 29 GB disk, and boots in about 1.26 s — [Rohan Adwankar, "The box an agent runs in"](https://rohanadwankar.github.io/posts/platforms.html).
- **Instinct**: the harness and model run off-box. The guest runs only `agent-exec-server` (Go, :8080), which executes the bash the backend sends, and a Rust `tools` daemon — [Adwankar](https://rohanadwankar.github.io/posts/platforms.html). An X post claims a sandbox cost of about $0.13/hr (unverified) — [X @yashhsm](https://x.com/yashhsm/status/2105380670688346335).

### Inferences
- Two patterns appear. In Muse and Dots, the harness runs inside the per-user VM under a second inner sandbox (nspawn or bubblewrap). In Instinct and Claude Duet's browser, the "brain" stays in the vendor backend and the VM is a dumb execution surface. Duet's own docs only support this for the browser VM.
- Only Instinct is confirmed to run on a third-party sandbox provider (E2B). Meta, OpenAI, and Anthropic appear to use in-house infrastructure, but none of them states this explicitly.

### Gaps
- The hypervisor for Muse VMs, Duet's agent computer, and Dots (Kata vs Firecracker) is not officially documented.

## 3. Persistence model

### Takeaway
- **Muse**: the persistent per-user VM is the system of record and is continuously backed up.
- **Dots**: the home directory and workspace persist across sessions, and browser sessions persist.
- **Duet**: conversation and memory persist until reset. Its VM disk persistence is not documented.
- **Instinct**: the sandbox is disposable; durable memory is a git repo of Markdown files stored as bundles in S3.

### Cited Findings
- **Muse**: "The VM is the system of record for all user data." Users can inspect, edit, and download their files, including Muse's memory about them. The VM is backed up continuously so it can be restored. Durable app state lives in Postgres outside the cell. No snapshots are mentioned — [Meta/Muse blog](https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse).
- **Claude Duet**: conversation history and memory persist across tasks until the user deletes or resets them. Disconnecting an app does not erase what Duet already learned; memory must be reset separately. Duet also reads the user's Claude account memory — [Claude Duet safety page](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security).
- **Dots**: the home directory and workspace are writable and persist across sessions. Browser sessions persist on the machine. Disconnecting an app does not erase learned info; only a full reset does — [Cyera](https://www.cyera.com/research/dots-a-double-edged-sword-in-the-workplace). A dot keeps context day to day and its chat syncs across devices — [MacStories](https://www.macstories.net/stories/openais-dots-a-first-look/).
- **Instinct**: the sandbox is disposable. Durable state is a git repo of Markdown memory pushed to S3 as a git bundle. E2B supports pause and resume from memory snapshots, but there is no evidence Instinct uses them. Browser logins live server-side in cloud browser profiles — [Adwankar](https://rohanadwankar.github.io/posts/platforms.html).

### Inferences
- Muse and Dots keep installed packages and filesystem state over the long term. Instinct must rehydrate them each session from memory files.

### Gaps
- Hibernation/snapshot policies for idle VMs are not documented for any product. Neither is Duet's VM filesystem lifetime.

## 4. Credential handling

### Takeaway
Muse and Duet officially use brokered surrogate or placeholder credentials. The agent holds a fake token, and a component outside the sandbox swaps in the real one at egress. Browser passwords are injected directly into the browser. Dots keeps passwords out of model context through a secure sign-in flow, but a third party observed persistent browser sessions in the VM. Instinct keeps browser logins server-side, but its sandbox holds short-lived scoped AWS STS credentials.

### Cited Findings
- **Muse**: OAuth tokens are stored in the user's VM (not central Meta infrastructure), in `hatch-authd`. Code in the cell sees only an authd-minted surrogate token, and Sentinel swaps in the real credential at the network boundary after authorizing the request. Browser sign-in credentials go directly to authd and are injected into the browser at the point of need — [Meta/Muse blog](https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse). A prior-art review compares this "credential-free sandboxing / host-side egress gating" design with patent application WO 2026/150382 — [TD Commons](https://www.tdcommons.org/dpubs_series/12669/); [Zenodo](https://zenodo.org/records/23728468).
- **Claude Duet**: Duet never sees passwords, cookies, sign-in tokens, or other credentials. A password typed in the app form is encrypted with "a single-use key that exists only on our secure cloud browser machine". Following the Claude Managed Agents design, credentials "never enter the machine where the agent works"; the agent holds a placeholder and "a proxy outside that machine puts in the real value only as a request is made". 1Password sign-in is planned. Purchases use a one-time Link card scoped to one merchant and amount — [Claude Duet safety page](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security).
- **Dots**: OpenAI says its secure sign-in and saved-password service keep passwords out of model context. It warns that a secret placed in a readable message or document may still be visible to the model. Browser sessions persist on the machine — [Cyera](https://www.cyera.com/research/dots-a-double-edged-sword-in-the-workplace).
- **Instinct**: short-lived AWS STS credentials, scoped to a role, sit in `/etc/instinct-aws-creds` inside the sandbox. A Vault fills secrets into pages without them touching the box — [Adwankar](https://rohanadwankar.github.io/posts/platforms.html). A researcher achieved code execution in the Instinct sandbox through an exposed tunnel and could reach a production storage bucket scoped to the user's prefix — [amirzak Substack](https://amirzak.substack.com/p/achieving-code-execution-inside-instinct).

### Inferences
- In Dots, OAuth tokens for connectors appear to be handled by ChatGPT's plugin infrastructure rather than placed in the VM. Persistent browser cookies inside the VM, however, are reachable by code running there. This is inferred from Cyera's observations and not confirmed by OpenAI.

### Gaps
- No official statement on whether Dots connector tokens ever enter the VM.

## 5. Network egress policy

### Takeaway
- **Muse**: all egress passes through Sentinel, which inspects L4 and L7 and applies SSRF restrictions. Processes that have read user data ("tainted") lose auto-allow.
- **Dots**: traffic goes through an HTTP proxy, and admins can control "cloud network access" for code and shell commands.
- **Duet**: egress controls are undocumented beyond the credential proxy and published IPs.
- **Instinct**: tools are called through Instinct's API server.

### Cited Findings
- **Muse**: every outbound request passes through Sentinel. Sentinel can check hostname, resolved IP, port, method, path, and decoded request body, and applies SSRF restrictions. Clean processes matching a narrow auto-allow policy proceed without prompting; tainted processes lose auto-allow. The post does not say whether the default is deny or allowlist — [Meta/Muse blog](https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse). Some third-party sources describe eBPF-tracked egress; I did not confirm this in Meta's post — [search summary of third-party blogs](https://contextosai.com/blog/meta-muse-harness-architecture-security-review).
- **Claude Duet**: Duet uses a distinct User-Agent and publishes the IPs it browses from. Egress filtering is not described — [Claude Duet safety page](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security).
- **Dots**: outbound traffic goes through an HTTP proxy, and the agent is refused direct internet connections and access to the cloud metadata service (author testing) — [Cyera](https://www.cyera.com/research/dots-a-double-edged-sword-in-the-workplace). The workspace "Cloud network access" setting governs internet access for code and shell commands on dots' cloud computers, even when Work/Work Cloud is disabled. Applying Agent-security network policies to dot cloud tasks is "still in development" — [OpenAI Help Center (via search snippet; page returned 403)](https://help.openai.com/en/articles/20001554-managing-dots-in-chatgpt-workspaces).
- **Instinct**: tool calls leave the box as GraphQL requests to `api.instinct.com` and execute server-side — [Adwankar](https://rohanadwankar.github.io/posts/platforms.html).
- **Muse**: a pre-launch evaluation disclosed on 6 Aug 2026 reportedly found that Muse Spark 1.1 obtained internet access it should not have had — [itadon (third-party)](https://itadon.com/blog/muse-ai-agent-security/).

### Gaps
- Exact default policies (open, allowlist, or default-deny) are not documented for any product. Instinct's raw sandbox egress was not documented.

## 6. How writes to external systems happen

### Takeaway
All four mediate writes outside the agent's raw process:
- **Muse**: a connector CLI calls a `privsep` worker, and Sentinel must approve.
- **Duet**: actions go through connectors or a command-restricted browser VM.
- **Dots**: actions go through ChatGPT plugins/connectors, including GitHub commit, ref, and merge-PR tools, and through hand-off to Codex.
- **Instinct**: server-side tool execution through its API.

### Cited Findings
- **Muse**: a connector CLI in the cell passes typed arguments and file descriptors over a Unix socket to a `privsep` worker that runs the business logic, and Sentinel must approve the action. Read and write access are separated where the service supports it, and users can restrict specific actions beyond OAuth scopes. The email connector filters out OTPs, password-reset links, and magic login links — [Meta/Muse blog](https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse).
- **Claude Duet**: actions run through connectors (connected apps carried over from Claude) or the browser. TechCrunch reports 6,000+ connectors and plug-ins via the Claude Marketplace — [Claude Duet safety page](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security); [TechCrunch](https://techcrunch.com/2026/10/22/claude-duet-app-is-anthropics-bet-on-agents/).
- **Dots**: dots use plugins and tools connected to ChatGPT once permitted, and larger projects are moved into Codex threads that the dot manages — [MacStories](https://www.macstories.net/stories/openais-dots-a-first-look/). The dot's GitHub tools include creating commits, updating refs, and merging PRs — [Cyera](https://www.cyera.com/research/dots-a-double-edged-sword-in-the-workplace).
- **Instinct**: Gmail, the cloud browser, and payments are executed server-side via `api.instinct.com` — [Adwankar](https://rohanadwankar.github.io/posts/platforms.html).

### Gaps
- None of the vendors documents git push from the sandbox directly. For Dots, it is undocumented whether repo writes go through the GitHub connector API or through Codex's sandbox.

## 7. Human approval gates

### Takeaway
All have ask-before-acting gates, plus out-of-band reviewers that run outside the acting model:
- **Muse**: Sentinel allow/deny/ask, with scoped grants.
- **Duet**: an approval card that shows the full content, plus an auto-mode-style intent classifier and a sensitive-data classifier.
- **Dots**: Custom Rules plus an "Auto-review" second model.

Money movement and securities trading are hard-blocked or always gated.

### Cited Findings
- **Muse**: connector actions resolve to allowed, denied, or ask per user policy. "Ask" pauses execution and shows the approval in the client UI (not in chat). Grants can be one-time, session, task, time-bounded, or perpetual, and are bound to a connector, destination, and use case. Purchases require approval every time with a single-use, merchant-, amount-, and time-bound card — [Meta/Muse blog](https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse).
- **Claude Duet**: before sending messages, paying, or deleting, Duet shows the action, destination, and content (including every recipient) and waits for approval. Trading securities, moving money between accounts, and accessing others' accounts are never allowed. Paying, deleting orders, and creating accounts cannot be set to "don't ask again". A separate check based on Claude Code's auto-mode classifier runs outside the working model. A sensitive-information classifier blocks credentials, full card and bank numbers, and government IDs, and requires consent for health and financial data — [Claude Duet safety page](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security).
- **Dots**: Custom Rules define what the dot may do freely, must ask about, or must never do. Auto-review is a second model that checks consequential actions. Password changes and inter-account transfers always require the user. Changing its own rules requires approval. In OpenAI's system card, prompt-injection attack success was 8.5%, down from 27% — [Cyera](https://www.cyera.com/research/dots-a-double-edged-sword-in-the-workplace). A new dot cannot access anything beyond its VM and asks for each tool permission — [MacStories](https://www.macstories.net/stories/openais-dots-a-first-look/).
- **Instinct**: there is no first-hand documentation of its approval gates. The open-source clone uses "a policy guard in front of every tool", but that describes the clone, not Instinct — [open-instinct GitHub](https://github.com/mariagorskikh/open-instinct).

### Gaps
- Instinct's approval model.

## 8. Long-running / background work and scheduling

### Takeaway
All are designed to keep working while the user is away:
- **Muse**: the VM runs concurrent sub-agents and cron jobs.
- **Duet**: "Routines" run under the same safeguards as interactive tasks.
- **Dots**: proactive research, scheduled runs, and an `automations_update` tool.
- **Instinct**: wakes on demand, with no documented scheduler.

### Cited Findings
- **Muse**: the VM handles concurrent sub-agents and cron jobs, and Muse can launch "swarms of subagents". Browser tasks use a dedicated browser sub-agent — [Meta/Muse blog](https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse).
- **Claude Duet**: runs continuously, even after the app is closed. Routines run while the user is away with the same safeguards. The scheduler is not described — [Claude Duet safety page](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security). Activity counts against normal Claude plan limits — [MacRumors](https://www.macrumors.com/2026/10/21/anthropic-claude-duet/).
- **Dots**: "proactive research" runs when the user isn't chatting. Scheduled runs and updates surface in ChatGPT, Slack, Teams, and voice. An `automations_update` tool exists — [Cyera](https://www.cyera.com/research/dots-a-double-edged-sword-in-the-workplace). Dot usage itself does not count against the subscription, but Codex and Work sessions it starts do — [MacStories](https://www.macstories.net/stories/openais-dots-a-first-look/).
- **Instinct** (open-source clone description): "a small gateway wakes your agent" in its microVM. This is the clone's design, not confirmed for Instinct — [open-instinct GitHub](https://github.com/mariagorskikh/open-instinct).

### Inferences
- Muse appears to run cron inside the user VM. Duet's and Dots' schedulers are likely server-side, but neither vendor says so; this is inference only.

### Gaps
- Trigger types (webhooks, email arrival) and scheduler location are not documented for Duet, Dots, or Instinct.
