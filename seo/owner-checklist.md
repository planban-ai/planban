# planban.ai SEO track: what is left for the owner

Updated 30 September 2026, evening: site PRs 1 to 5 shipped, Cloudflare done, Search Console verified with sitemap submitted, Umami live, product PR 13 merged, awesome-codex-cli issue filed.

## Email convention for Planban accounts

- **hello@planban.ai** owns every product account: Google (Search Console), Microsoft (Bing Webmaster), Umami, and any directory or listing account later. Recovery mail and notices all land in the one Proton inbox.
- **updates@planban.ai** is the sender for the Resend update list only.
- **support@planban.ai** is for support replies and, once you confirm the mailbox is live, the security policy contact.

Do each account step in Chrome (the Claude in Chrome extension is connected there), then tell me in chat. Everything after sign-in is mine.

## Done, no action needed

- Site PRs 1 to 4 merged and live: prerendering, robots.txt, sitemap, cache headers, 404, structured data, host pages, definition page, FAQ, docs, changelog, llms.txt, performance.
- Cloudflare: www to apex 301 redirect deployed and verified; Crawler Hints on.
- GitHub: repository descriptions, homepage and topics set; social preview uploaded; README and doc-fix branch pushed (PR 13 merges automatically when its CI is green).

## Done: Google account and Search Console

Domain property planban.ai verified (TXT record in Cloudflare), sitemap submitted (23 pages), indexing requested for the home page and /claude-code/. Nothing left to do here.

## Superseded: Step 1

1. Create the Google account: https://accounts.google.com/signup → "Use my current email address instead" → `hello@planban.ai` → enter the verification code Google emails to Proton.
2. In the Chrome tab I opened (it is on Google's sign-in page for Search Console), sign in with that account.
3. Tell me "Google signed in". I then: add the Domain property `planban.ai`, copy the TXT record, add it in Cloudflare DNS, verify, submit `https://planban.ai/sitemap.xml`, and request indexing for the home page, the two host pages, the definition page and the docs index.

## Deferred: Bing Webmaster Tools

Microsoft blocked account creation for hello@planban.ai. Skip for now; Crawler Hints already notifies Bing via IndexNow. Retry later with phone verification or a different address if you want Bing's citation reports; then tell me and I import the site from Search Console.

## Superseded: Step 2

1. Create the Microsoft account: https://account.microsoft.com/ → Create a Microsoft account → use `hello@planban.ai` as the email → verification code to Proton.
2. In Chrome, go to https://www.bing.com/webmasters and sign in with it.
3. Tell me "Bing signed in". I then: import planban.ai from Search Console (this verifies the site and imports the sitemap), and submit the home page URL. Do this after Step 1, because the import reads from Search Console.

## Done: Umami analytics

PR 5 merged and live: the script is on every page and the privacy policy is updated. Dashboard: https://cloud.umami.is/

## Superseded: Step 3

1. https://cloud.umami.is/ → Sign up with `hello@planban.ai` on the free Hobby plan → verification email to Proton.
2. Add a website: name `planban.ai`, domain `planban.ai`.
3. Copy the **Website ID** (a UUID shown on the tracking-code page) and paste it to me in chat. It is a public value that appears in page source.
4. I then open PR 5 adding the script to every page, an AI-referral grouping, and a privacy-page update, and you merge it.

## Step 4: Awesome-list submissions (partly done)

- awesome-codex-cli: filed as https://github.com/RoggeOhta/awesome-codex-cli/issues/345 from your account. Nothing to do.
- awesome-claude-code: NOT filed. Its form requires ticking "specific to Claude Code"; Planban is cross-host. Recommendation: skip. If you disagree, the field values are in seo/awesome-lists.md and it is a two-minute form.
- punkpeye/awesome-mcp-servers: needs a Glama listing first. Sign in at https://glama.ai/mcp/servers with GitHub and add https://github.com/piercekearns/planban (Dockerfile in seo/awesome-lists.md if asked), then tell me and I file the PR.

## Superseded: original Step 4

Exact entry text, field values and steps are in `seo/awesome-lists.md`. Submit from your own GitHub account (maintainers expect the project owner):

1. awesome-claude-code: issue form only. Answer the "specific to Claude Code" question honestly as no; if the form makes it mandatory, skip this list.
2. awesome-codex-cli: open the issue as written.
3. punkpeye/awesome-mcp-servers: first create a Glama listing (starter Dockerfile in the file), then open the PR with the given diff line.

Tell me the outcomes and I record them on the Board.

## Done: Board acceptance

Nine delivered Items moved to Complete on your instruction. Still open: registration (Bing deferred), directories (above), measurement (baseline in four weeks), comparison page (gated).

## Later, no action now

- Comparison page: revisit when Search Console has about eight weeks of query data; I will propose at most one comparison from the evidence.
- Eight weeks after indexing: I run the answer-engine citation check (ChatGPT search, Perplexity, Claude) and record the results.
- Host-framed screenshots for the Claude Code and Codex pages, if you want them.
- Confirm when `security@planban.ai` is live so the docs and SECURITY.md can name it.
