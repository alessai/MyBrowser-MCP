# Jev experiments

Checks whether TypeSafe Jev (`jev-1.13.0`, the model the product pins) can take
over the step types that made the Nov 1 2026 Sampo Meta-ad session slow:
checking settings, setting fields, finding things off screen, and waiting.

Everything runs against local fixtures in headless Chromium, so no real browser
or account is touched. Answers are scored against `data-gt` ground truth, which
is never sent to Jev. Actions use 0.7 confidence, the product default.

```
npm install          # playwright-core only; uses the cached Playwright Chromium
node run.mjs         # all experiments, or: node run.mjs E1 E3b
```

Needs `jev.apiKey` in `~/.mybrowser/config.json`. Results go to `results/`.

## Fixtures

- `fixtures/adset.html`: an Ads Manager-style edit page with 81 controls (85 once
  lazy content loads). It mixes `<label for>`, wrapping labels, `aria-label`,
  `aria-labelledby`, and controls labelled only by sibling text in a `<div>`.
  Traps: two fields called "Name", four "Advantage+" settings, a tri-state
  parent checkbox, a closed `<details>` section, and a Tracking section that
  renders only after scrolling.
- `fixtures/campaigns.html`: 250 campaign rows, 1,250 controls. Every row has
  the same five controls, so only row text tells them apart.
- `fixtures/upload.html`: a video upload card with timed state changes, a
  "Draft saved" toast and help text containing the word "failed".

## Results (run Nov 1 2026)

| # | Question | Result |
|---|---|---|
| E1 | Can Jev map "setting X" to the right control so its state can be read? 41 phrases x 2 runs | Today's descriptions: 72/82 right, 0 wrong. With section + row context: 80/82 right, 0 wrong. All 34 state verdicts matched ground truth. 41 checks take about 2.7 s in 6 requests |
| E1 | How many checks fit in one request? | 20 questions: 0.58 s. 41 questions: rejected (`max_tokens_exceeded`, limit between 51k and ~100k input tokens). 8 questions one by one: 2.3 s; batched: 0.45 s |
| E2 | Can Jev fill a whole form from one spec? 18 fields x 2 runs | 18/18 set correctly both runs, 0 other settings changed, 4 Jev calls, 2.4 s including the scroll sweep. Fuzzy values ("landing page views", "Get a quote") picked at confidence 1.00 |
| E3 | Off-screen targets (page scrolled to top), 12 targets | Today (viewport only): 1/12. Whole page: 12/12, 0 wrong |
| E3b | Targets in a 250-row table, 10 targets | Today: 0/10. Whole page with today's descriptions: 1/10. With row context: 10/10. Two-step (row, then control): 10/10. 0 wrong in every mode |
| E4 | Wait for "upload finished" / "preview visible", never-true "error shown", 5 runs | Detected 185-234 ms after the change with one poll at 0.7, about 700 ms with two in a row. 0 early or false detections, including the "failed" help text |

What failed and why:
- Today's descriptions decline controls labelled only by sibling text in a
  `<div>` ("Campaign spending limit", "Multi-advertiser ads"), and duplicates
  that only the section name separates ("Ad name"). Section and row context fixed both.
- "Budget type (daily or lifetime)" was declined at 0.52-0.68 in every mode: the
  control is labelled just "Budget". A decline, not a wrong pick.
- Controls inside the closed `<details>` are still readable, so checking them
  works. Clicking them would need the section expanded first.

Changes made between runs (so the numbers are not a blind first try): after run
1, row text stopped falling back to a whole section's text, and controls inside
`<details>` got its summary as their sub-heading.

## Limits

- Fixtures, not Meta's real DOM. The real Ads Manager uses custom dropdowns,
  search-as-you-type fields, virtualised lists and React state. E2 only used
  native inputs and selects.
- E4's states are plain text ("Upload complete"). Real pages may only show an icon.
- These measure Jev's part. They do not measure how many agent turns a real
  task saves; that is E6.

## Phase 2 (not run yet)

- **E5, real page, read-only:** run the E1 mapping on the real Sampo draft in
  Ads Manager through MyBrowser's `browser_eval`, then label the picks by hand.
- **E6, agent A/B:** the same 18-field spec and 41 checks on `adset.html`, done by
  an agent with today's tools versus with prototype `browser_verify` /
  `browser_apply`. Measure turns, wall time and errors.
- **E7, thinking effort:** E6's baseline at medium versus high effort.
