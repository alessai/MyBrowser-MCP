# MyBrowser 2.0: plan

Status: draft for review, Nov 1 2026. Branch `exp/jev-experiments`.

## 1. What 2.0 is

MyBrowser 1.x makes the agent take one turn per small decision: find the
control, set it, look again to check it worked. In the Nov 1 Sampo Meta-ad
session that pattern took about 150 of 269 turns (about 90 of 170 working
minutes). The model's thinking, not the browser, is where the time went.

2.0 moves those small decisions out of the agent's turns:

1. **Bigger tools.** The agent hands over a whole list ("check these 40
   settings", "set these 18 fields", "wait until the upload is processed") and
   gets one structured answer back.
2. **A decision layer inside the tools.** Each item is resolved by fast
   code first, then by a decision model (Jev) when code is unsure, then handed
   back to the agent when both are unsure.
3. **A better page reader.** It reads the whole page, with section, row and
   label context, so both code and Jev see what a person sees.

### Rules that apply to every part of this plan

1. **Everything works without Jev.** No key, no network, a TypeSafe outage,
   or a revoked key: every tool still does its job. Without Jev, the items code
   can't settle go back to the agent as a short list of candidates, so the agent
   decides in one turn instead of several. Jev only makes it faster.
2. **Code first, Jev second, agent last.** An exact label match never costs a
   model call. Jev is asked only when code finds several or no candidates.
3. **Values stay on this machine.** Jev sees element roles, labels and section
   names. It never sees what is typed in a field, and the state of a control is
   always read from the page by code, never guessed by a model.
4. **Side effects fail closed.** Pay, delete, send and publish actions need
   high confidence and are never part of an automatic batch unless the agent
   names them explicitly.
5. **Measured before switched on.** Every Jev feature ships behind a flag and
   becomes default only after it passes its experiment gate (section 7).
6. **Not tied to TypeSafe.** The decision layer talks to any server that
   speaks the System One API: TypeSafe, a local open model, or a gateway.

### What 2.0 is not

- Not a fork. Same extension, hub, transport, login and tool names. 2.0
  upgrades six existing tools and adds three.
- Not a free-text generator. Jev cannot write text. Values the agent wants
  typed come from the agent.
- Not a replacement for the agent's judgment on new screens, sign-ins,
  payments or copywriting.

## 2. Evidence this plan rests on

### 2.1 Where the Sampo session spent its time (Nov 1, 16:53-20:26)

| What the turn was doing | Turns | Minutes |
|---|---|---|
| Checking a setting's state | 73 | 44 |
| Setting one field or toggle | 44 | 28 |
| Scrolling to find something | 32 | 18 |
| Waiting or reloading | 10 | 10 |
| Real decisions (copy, CTA, targeting) | 5 | 4 |
| No visible reasoning (mostly mechanical) | 92 | 55 |

Median turn: 34 s, of which about 27 s was the model thinking. The 280 browser
steps contained 290 `browser_eval` scripts the agent wrote itself. Jev's
existing click fallback ran 13 times and saved 5-10 minutes.

### 2.2 Experiments already run (`MyBrowser/experiments/jev/`)

Local replica pages in headless Chromium, scored against ground truth.

| # | Task | Result |
|---|---|---|
| E1 | Map 41 settings to their controls | Today's page reader 72/82, with section and row context 80/82, **0 wrong**. 41 checks in about 2.7 s |
| E1 | Batch size | 20 questions in 0.58 s; 41 rejected (too many tokens). 8 one by one 2.3 s, batched 0.45 s |
| E2 | Fill 18 fields from one list | 18/18, nothing else changed, 2.4 s, 4 Jev calls |
| E3 | Targets below the visible area | Today 1/12, whole page 12/12 |
| E3b | Targets in a 250-row table | Today 0/10, with row text 10/10, row-then-control 10/10 |
| E4 | Wait for "upload finished" | Detected about 0.2 s after it happened, 0 false alarms |

Limits: replica pages, not Meta's real DOM. Native inputs only. These measure
Jev's part, not turns saved in a real task.

### 2.3 Research (Nov 1 2026)

**TypeSafe's own docs**
- Jev 1.14 (`jev-latest`) is the stable model; 1.13 is what we pin today.
- Limits: 64k tokens per request, 32k per question, up to 255 Choice options.
  Our 41-question failure came from repeating the element list in every question.
- A long-context header raises both limits to 262k tokens, but answers are
  slower and less accurate.
- Images can go in the state, in a question's instructions, or as Choice
  options. Images and Box questions are still marked not production-ready.
- Known weak spots:
  - reads questions literally;
  - unreliable at counting, maths and dates;
  - accuracy drops with long, irrelevant state;
  - can be steered by adversarial page text;
  - leans towards the first Choice option;
  - cannot generate text.
- Useful patterns:
  - ask many questions in one request, including speculative ones;
  - set confidence thresholds by risk;
  - line-by-line search with an "is it there at all" Noul;
  - turn a sentence into a function name plus arguments (54 questions in one request);
  - rank, then re-check;
  - choose from candidates extracted by regex instead of asking for a value;
  - check citations;
  - screen messages for guardrails;
  - remember things across turns.

**Other browser agents built on Jev**
- browser-use `jev-ultrafast`: each step asks "which operation" (click, type,
  select, scroll, wait, done, blocked) and "which target for each operation" in
  one request. A small text model writes typed values. Measured 7.1 s for a
  Google Flights search.
- `jkudish/jev-browser`: checks finish with two independent judgments ("I'm
  done" and "the goal is met"). Reads elements from the DOM rather than the
  accessibility tree, because the tree misses inputs. Caps at 240 elements per step.
- `0x7067/jev-browse`: stops loops with step-cycle, revisit and idle limits,
  confirms DONE separately, and checks freshness before acting.
- `vlad-terin/jev-browser`: the agent plans once and Jev runs the loop. Large
  pages are split into up to 6 parallel requests. Control returns to the agent
  when a step needs help.
- CodexQA and jev-browser-qa: Jev checks whether an action took effect on the
  next page, and a test assertion passes only if "holds" is high and
  "contradicted" is low.
- Voice control at about 300 ms per decision; a careers-page crawler across
  many sites.

**Decision models other than Jev**
- Amazon's Strands Decider 2B is open source and serves the same
  `/v1/systemone` API. Strands reports a median of about 115 ms on an RTX 3090,
  and seconds per question on CPU. This machine has an RTX 5090 (32 GB), so a
  local decider is practical here. On JevBench it scores 0.72; I haven't checked Jev's score
  on the same scale.
- An ONNX build of Strands Decider runs inside the browser on WebGPU, about
  130 ms per question on an M3.
- LiteLLM and Vercel's gateway offer one decisions endpoint for several models.

## 3. Architecture

```
MCP client (agent)
   |  existing tools (6 upgraded) + 3 new ones
MyBrowser server  ---------------------------------------------------------+
   |  Engine: runs lists of items (verify / apply / find / wait / triage)  |
   |  Resolver: code -> decider -> hand back                               |
   |  Decider interface: typesafe | local System One | none                |
   |  Policies: risk classes, thresholds, redaction                       |
   |  Site memory: phrase -> element fingerprints, per domain              |
   |  Receipts: every decision logged locally (off by default)             |
   +-----------------------------------------------------------------------+
   |  hub + WebSocket (unchanged)
Extension
   |  Page Model v2 reader (new content script function)
   |  existing actions (click, type, select, scroll, eval)
```

The extension stays a thin executor. All decisions, thresholds and calls to
TypeSafe stay in the server, as in 1.4. The one extension addition is the
Page Model v2 reader, because whole-page reads need DOM access.

## 4. Building blocks

### 4.1 Page Model v2 (the page reader)

One read returns every interactive element on the page, not just the visible
part. Each element has:

| Field | Source | Sent to Jev? |
|---|---|---|
| `id` | stable fingerprint: role + name + section + row + position among equals | no (local key) |
| `role`, `name` | same rules as 1.4 (`aria-label`, `labelledby`, `<label>`, text) | yes |
| `section`, `sub` | nearest section or dialog heading; legend, `<details>` summary or `h3` | yes |
| `row` | the nearest row's text, or the parent's text if it is under 80 characters | yes |
| `state` | checked, on/off, mixed, selected option, value length | **no** (read locally) |
| `visible`, `inView`, `collapsed` | `checkVisibility()`, rect, closed `<details>`/collapsed accordion | flags only |
| `widget` | native, ARIA combobox, listbox, switch, slider, date picker, rich editor | yes (kind only) |
| `selector` | CSS path, re-checked before any action (as in 1.4) | no |
| `options` | for selects and open listboxes: option labels | yes, when asked about values |

**Coverage work (each with a fixture and a test):**
1. Open shadow DOM and same-origin iframes (read into the same list, tagged by frame).
2. Custom ARIA widgets: comboboxes that open listboxes, switches built from
   `div`s, sliders, date pickers. Meta, Google and Shopify admin use these instead
   of native inputs.
3. Lazy sections: an optional scroll sweep renders them, then returns to the
   original scroll position. Off by default, because it moves the page; on for
   `verify`, `apply` and `find` when the caller allows it.
4. Virtual lists, which only render visible rows: report "list continues"
   with a scroll target rather than pretending the page has been fully read.
5. Size budget: about 1,500 elements per read. Above that, read by section.

**Privacy rules (from 1.4, kept):**
- Field values are never used as names.
- URLs keep only the path and query keys.
- Long tokens in paths are masked.
- Editable text is never sent.

### 4.2 Decider interface (the decision layer)

```ts
interface Decider {
  name: "typesafe" | "local" | "none";
  ask(state: unknown, questions: Record<string, Question>, opts): Promise<Answers>;
  limits: { perRequestTokens: number; perQuestionTokens: number; maxOptions: number };
}
```

- **typesafe**: the 1.4 client, extended with:
  - batching to a token budget, using the response's `usage.input_tokens` to
    calibrate the estimate;
  - up to 4 requests in parallel when a batch has to split;
  - retries on 429 and 529, with backoff and the `retry-after` header;
  - an opt-in long-context header;
  - the model pinned per feature, because thresholds were measured per version.
- **local**: any `/v1/systemone` server, such as Strands Decider. It uses its
  own thresholds file, because confidence scales differ between models.
- **none**: no model at all. Everything code can't decide goes back to the agent.

Shared behaviour:
- **One element list per request.** The element list goes in the state once,
  and each question's options name element ids. This keeps a 41-check batch
  under the 64k limit (today it repeats the list in every question).
- **Short-lived cache.** Answers are reused for 30 s, keyed on state hash +
  question + model. Identical re-asks inside one tool call cost nothing.
- **Order check for risky or close calls.** If the top two options are within
  a 1.5× ratio, or the action is risky, the question is asked again with the
  options reversed, and the pick must agree. This addresses the documented
  first-option bias.
- **Receipts.** Each call is logged with its model, number of questions,
  number of options, latency, tokens, picks and confidences. Logging goes to the
  existing local telemetry, off by default, under the same fail-closed privacy
  rules: no labels or page text are stored, only counts and hashed ids.

### 4.3 Resolver v2 (from a phrase to an element)

For each item ("Daily budget", "the Threads checkbox"):

1. **Site memory.** If this domain has a remembered fingerprint for this
   phrase, and that element is on the page with the same role and section, use
   it. No model call.
2. **Code.** Score candidates by exact or normalised name match, synonyms
   ("CTA" = "call to action"), the section named in the phrase, and role words
   in the phrase ("checkbox", "switch", "dropdown"). If exactly one candidate
   clearly wins, use it.
3. **Decider.** Ask a Choice question over the candidates code kept, with
   "none" as an option.
   - Up to 254 candidates: one question.
   - More: two stages, first pick the section or row (as in E3b), then the
     element inside it.
4. **Decision rules:**
   - **Act:** confidence at or above the threshold for the item's risk class
     (4.6), and the order check agrees when it applies.
   - **Hand back:** anything else. The agent gets up to 5 candidates, each with
     a short id it can pass straight back.
5. **Learn.** Store the phrase → fingerprint mapping only when the action's
   result was verified (4.5), never on a guess.

### 4.4 Engine (runs a list of items)

`verify`, `apply`, `find`, `wait_until` and `triage` are thin layers on one
engine. The engine works in four steps:
1. One page read.
2. Resolve all items in as few decider calls as possible.
3. Act or read, item by item.
4. Re-read the changed parts and report per item: `done`, `already_set`,
   `mismatch` (with the actual value), `not_found`, `needs_choice` (with
   candidates), `blocked` (risky, or a dialog in the way) or `error`.

It stops early and reports when:
- the page navigates unexpectedly;
- a dialog opens that no item expects;
- the same item fails twice;
- the step budget runs out.

### 4.5 Did it work? (outcome checks)

Every action result gains a short, code-computed `effect` line:
- `navigated to <path>`;
- `dialog opened: "<title>"`;
- `value now "<x>"`;
- `toggled on`;
- `no change detected`.

Code computes this from a before/after diff, so it costs no model call. If the
caller passes `expect: "<what should happen>"`, the decider also answers two
questions:
- "does the page now show this?"
- "does the page contradict it?"

The result is `confirmed` only if the first is high and the second is low (the
jev-browser-qa rule).

### 4.6 Risk classes and thresholds

| Class | Examples | Code signal | Act at |
|---|---|---|---|
| read | verify, find, wait | none | 0.7 |
| reversible | toggles, fields, tabs, scroll | default | 0.7 |
| navigation | links, Next, Back | role link or nav | 0.75 |
| irreversible | pay, buy, delete, send, publish, submit, accept invitation | keyword list (several languages) **or** the 1.4 risk Noul at 0.5 or above | 0.9, and only when the agent named the action explicitly |

Rules for the irreversible class:
- It is never inferred inside `apply` or `triage`.
- `triage` actions (5.7) carry an explicit `action` and a dry run by default.

### 4.7 Site memory

`browser_learn` / `browser_site_info` already persist page models per domain in
`~/.mybrowser/sites/`. 2.0 adds three kinds of entries:
- **Phrase map:** "daily budget" → fingerprint, with hit and miss counts. An
  entry is dropped after 2 misses.
- **Quirks:** "Tracking section loads on scroll", "CTA is a custom listbox".
  Code writes these when it detects them, and they change how the next read runs.
- **Routes:** a recorded sequence (existing recordings) with a check before
  each step: "does the page still match this step?" (decider Noul, or a code
  fingerprint match without Jev).

## 5. Tools

Six existing tools are upgraded and three are added (71 → 74). Every tool
keeps working without a decider; section 6 lists exactly what changes without one.

### 5.1 `browser_outline` (new)

A compact, whole-page map for the agent: sections, then each element's short
`id`, role, name and current state, read by code. A select also lists its
options.

- **Why:** without Jev, this is what turns "scroll, snapshot, squint" into one
  call. The ids are stable fingerprints and work in every other tool.
- **Size:** aim for 2-4k tokens, against 7k or more for a full snapshot.
  Collapsed sections show a one-line summary.
- **`focus: "<question>"`:**
  - with a decider: one Noul per section ("is this section relevant to…"),
    and only relevant sections are returned;
  - without one: sections ranked by word overlap.
- **Test:** ids stay the same across two reads; ids stay stable after a
  re-render on fixtures; token size is held to budget on the adset fixture.

### 5.2 `browser_assert` (upgraded): check many things at once

New check types next to the existing ones (`text_contains`, `element_visible` and so on):
- `{ type: "setting", target: "Advantage+ audience", expect: "off" }`.
  `expect` can be `on`, `off`, an exact value, or `{ contains }`.
- `{ type: "page", question: "Is a sign-in wall shown?", expect: true }`.

Behaviour:
- `setting`:
  - Resolver v2 finds the control.
  - Code reads its state and compares it with `expect`.
  - Jev only finds the control; it never judges the value.
- `page`:
  - Answered by a decider Noul.
  - Without one, it returns `needs_judgment` with the relevant outline
    excerpt, for the agent to answer.
- **Output:** one line per check: `pass`, `fail (actual: "on")`, `not_found`,
  `needs_choice [ids]` or `needs_judgment`.
- **Test:** E1 runs through this tool. Mixed (tri-state) controls report
  `fail (actual: mixed)`.

### 5.3 `browser_fill_form` (upgraded): set many fields at once

Fields become a list: `{ target, value }`. Values are typed only from what the
caller passes.

Behaviour by control type:
- **Native inputs:** set as in 1.4.
- **Toggles and switches:** read first, then clicked only if the state differs.
- **Selects:**
  - an exact option match is used directly;
  - otherwise a Choice over the select's options (E2: "Get a quote" → "Get quote");
  - without a decider, the item returns `needs_choice` with the options listed.
- **Custom comboboxes and search-as-you-type fields:**
  1. open or type the value;
  2. wait for the listbox;
  3. pick the option, exactly or by Choice;
  4. confirm the chip or value appeared.

Options and safety:
- `dry_run: true` returns the field → element mapping without touching anything.
- `submit` stays a separate, explicit option, as today.
- Irreversible targets are refused inside a fill and reported as `blocked`.
- The result is re-read after filling, and a side-effect diff lists any other
  control that changed, as E2 checked.

Test: E2, E10.

### 5.4 `browser_find` (upgraded): semantic search on the page

New `query: "<plain-language target or question>"` alongside the existing
role, name and text search.

- **With a decider:**
  - a Choice over elements or text lines (line ids, as in the TypeSafe
    line-search recipe), split into two passes for long pages;
  - plus a Noul for "is it on this page at all".
  - Returns the top results with `exists` and an optional `scroll_to`.
- **Without one:** word-overlap ranking, with `exists: not_scored`.

### 5.5 `browser_wait_for` (upgraded): wait for a described state

New `until: "<plain-language condition>"`, with optional `fail_if: "<condition>"`.

- **With a decider:**
  - polls every 500 ms with Noul questions;
  - requires two readings in a row at 0.7 or above (E4: about 0.7 s after
    the change, 0 false alarms);
  - stops early if `fail_if` holds.
- **Without one:** the tool says it needs a code condition and lists them.
  Agents already have those (`text_visible`, `element_visible`, `url_contains`,
  `network_idle`), so nothing becomes impossible.

### 5.6 `browser_click` / `type` / `hover` / `select_option` (upgraded)

- Resolver v2 replaces the 1.4 fallback: site memory, then code, then decider,
  then hand back.
- Every result gains the code-computed `effect` line (4.5).
- Optional `expect: "<what should happen>"` adds the confirm/contradict check.
- `needs_choice` results list up to 5 candidate ids. Without a decider this is
  the main path, and it is still one turn.

### 5.7 `browser_triage` (new): sort a list on the page, then act on it

This is the LinkedIn invitation job as a tool.

**Input:**

```json
{
  "items": "auto | <css selector of one card>",
  "read": ["text", "link"],
  "labels": { "ignore": "based in India or Pakistan", "keep": "..." },
  "rules": "optional plain rules applied in code, e.g. country lists",
  "action": { "ignore": "the Ignore button on the card" },
  "dry_run": true,
  "pace_ms": 1500,
  "max_items": 500
}
```

**Steps:**
1. Code finds the repeating cards: same structure, with siblings.
2. Code reads each card's text and link. Load-more and infinite scroll are
   followed up to `max_items`.
3. **With a decider:**
   - one Choice per card over `labels`, with "unsure" added;
   - the card list goes in the state once, and requests are batched to the
     token budget;
   - answers below the threshold go to `review`.
4. **Without a decider:** returns the cards with ids for the agent to label.
   The agent then calls again with `labels_by_id`. That is two turns for 300 cards.
5. The dry run returns buckets, with counts and every card.
6. **Apply:**
   - the caller passes `confirm: [ids]` from the dry run;
   - each card is re-matched by fingerprint before its click;
   - paced, with a stop on the first unexpected dialog;
   - a final count is re-read from the page.

**Safety:**
- No action runs without `confirm`.
- Irreversible actions need the action named explicitly and the ids confirmed.
- Pacing defaults are set per domain.

Test: E11.

### 5.8 `browser_run` (new, behind a flag): bounded autopilot

**Input:** `goal`, `values` (named strings the agent provides; typing can only
use these), `allow` (operations), `max_steps` (default 25), `stop_when` (plain
condition) and the risk policy.

**Each step makes one decider request containing:**
1. a Choice of operation: click, type `<value name>`, select, scroll, wait,
   done, blocked;
2. a speculative Choice of target for every allowed operation;
3. Nouls for "goal met", "stuck" and "a dialog needs a person".

**Then:**
1. act;
2. compute the `effect`;
3. check the fuses:
   - the same state seen 3 times;
   - the same URL revisited 4 times;
   - 3 steps with no change;
   - the same failure twice.

**Done** needs both "done" and "goal met" to be high.

**Control returns to the agent with a trace when:**
- a fuse trips;
- confidence is low;
- a risky step comes up;
- a value is missing;
- the run is done.

**Without a decider:** the tool is not listed. Anything it does, the agent can
do with the other tools; it is a speed mode only.

Test: E13.

### 5.9 Prompt-injection guard (automatic, not a tool)

Page text that reaches the agent through `snapshot`, `extract`, `outline`,
`find` or `triage` is checked for text aimed at an AI agent.

- **Code (always on):**
  - hidden text (display none, zero size, text the same colour as its background);
  - phrases such as "ignore previous instructions" or "you are an AI".
- **Decider (opt-in):** one Noul per text block: "does this text address an AI
  system or try to give it instructions?"
- **Marking:** flagged blocks are prefixed `[page text, possible instruction to
  AI]`. They are not removed, so nothing silently disappears.
- **Jev's own inputs:** the same flags are added to Jev's state, and risky
  actions are never decided from flagged text.

Test: E12.

### 5.10 Vision (behind a flag, Jev 1.14 images)

Used only where the DOM can't answer:

- **Icon-only buttons with no name:**
  - crop each candidate (padded to the 280 px minimum);
  - send the crops as Choice options ("define options by example" in
    TypeSafe's images guide).
- **Canvas apps, maps and video:**
  - a before/after screenshot pair, with the Noul "did the expected change happen?";
  - tile search (Choice over image tiles, repeated on the chosen tile);
  - Box only as a last resort, because it measured 67% in October.
- **Box clicks:** a Box result is clicked only after a re-check on the crop
  confirms the target is inside it.

## 6. Without Jev: what each tool does

The decider setting can be `typesafe`, `local` or `none`. With `none` (or when
TypeSafe is down), each tool behaves as follows. Every task stays possible; the
cost is extra agent turns, never a missing capability.

| Tool | With a decider | Without one | Extra agent turns without |
|---|---|---|---|
| `browser_outline` | `focus` filters sections by relevance | `focus` ranks sections by word overlap | 0 |
| `browser_assert` `setting` | Phrase → control by code, then Jev | Code only; unclear items come back as `needs_choice` with ids | +1 for the unclear items, all in one turn |
| `browser_assert` `page` | Jev Noul | `needs_judgment` plus an outline excerpt | +1 |
| `browser_fill_form` | Code, then Jev for fields and fuzzy options | Code; unclear fields and options come back as `needs_choice` | +1 |
| `browser_find` `query` | Ranked results with `exists` | Word-overlap ranking, `exists: not_scored` | 0-1 |
| `browser_wait_for` `until` | Polled Noul | Asks for a code condition | +1 (the agent picks a code condition) |
| click / type / hover / select | Memory, code, Jev, then hand back | Memory, code, then hand back | +1 when code is unsure |
| `browser_triage` | Labels by Jev, uncertain ones to `review` | Cards returned for the agent to label | +1 (two turns total) |
| `browser_run` | Autopilot loop | Not listed | n/a: the agent drives with the tools above |
| Guard | Code + Jev | Code only | 0 |
| Vision | Icon matching, visual checks | Screenshots for the agent, as today | as today |

**Startup:**
- With no decider configured, the tools above are listed with the "without"
  behaviour described in their descriptions.
- A decider that fails at runtime (timeout, 429/529, 5xx) switches that call to
  the "without" path and says so in the result (`decider: unavailable`).
- A failing decider never changes or blocks the action path.

**Tests:**
- Every tool test runs twice: once with a replayed decider and once with `none`.
- The `none` run must finish the same fixture task, with `needs_choice` turns allowed.

## 7. Experiments and the gates each feature must pass

Experiments live in `MyBrowser/experiments/`. A **replay cache** stores decider
answers keyed by request hash, so the suites run in CI without a key and give
identical results. A live run refreshes the cache.

| # | What | How | Gate to switch the feature on |
|---|---|---|---|
| E5 | Real pages, read-only | Run `assert setting` checks and `outline` on real pages: the Sampo Meta Ads draft, GitHub repo settings, Gmail settings, a Shopify admin product form. Picks are labelled by hand. No clicks | 0 wrong picks; ≥ 90% resolved without hand-back |
| E6 | Agent A/B | Same tasks (18-field fill + 41 checks, and a Sampo-style ad set flow on fixtures) done by an agent with 1.4 tools and with 2.0 tools. Count turns, time, errors | 2.0 needs ≤ 50% of the turns, with no more errors |
| E7 | Thinking effort | E6 baseline at medium vs high effort | Informational (guides agent setup) |
| E8 | Providers | E1-E4 + E5 on jev-1.13, jev-1.14 and Strands Decider (local) | Thresholds file per provider; local default only if 0 wrong picks |
| E9 | Shared list and order check | One element list in the state vs repeated per question; options reversed | Same accuracy; tokens per 41-check batch under 64k |
| E10 | Custom widgets | Fixtures: ARIA combobox, search-as-you-type, date picker, virtual list, shadow DOM, iframe | `fill_form` sets 100% of the reachable fields; reports the rest as `not_found` |
| E11 | Triage | 300-card fixture with ground truth, including look-alike cards | ≥ 99% precision on the action bucket at the default threshold; uncertain cards go to `review` |
| E12 | Guard | 50 benign + 50 injected blocks (visible, hidden, in alt text, in aria-labels) | ≥ 95% of hidden injections caught by code alone; ≤ 2% false flags |
| E13 | Autopilot | 20 tasks on fixtures + 5 public test sites (the-internet.herokuapp.com, demo shops) | ≥ 85% success, 0 wrong irreversible actions, median steps reported |
| E14 | Without-Jev parity | E6 and E13-style tasks with `decider: none` | Every task completes; extra turns counted |

Existing E1-E4 are kept as regression suites.

## 8. Phases

Estimates are my implementation time as the agent, not human developer days.
Each phase ends with the full release gate from project rules:
- server and extension suites;
- both typechecks and both builds;
- a live smoke on ArchyMain;
- for releases, npm pack and an isolated install.

| Phase | Version | Contents | Estimate |
|---|---|---|---|
| P0 Foundation | 2.0.0-alpha.1 | Decider interface (typesafe, local, none), shared-list batching, retries, receipts, replay cache; Page Model v2 reader (native, shadow DOM, same-origin iframes, sections and rows, visibility, local state); `browser_outline`; Resolver v2 with code tier and site-memory phrase map | 1.5-2 days |
| P1 Bulk tools | 2.0.0-alpha.2 | `assert` setting/page, `fill_form` v2 with custom widgets, `find` query, `wait_for` until, `effect` lines and `expect` on actions; experiments E5, E6, E9, E10 | 2 days |
| P2 Lists and safety | 2.0.0-beta.1 | `browser_triage`, guard (code + optional Jev), site-memory quirks and routes; E11, E12, E14 | 1.5 days |
| P3 Speed modes | 2.0.0-beta.2 | `browser_run` (flag), vision (flag), local provider thresholds; E8, E13 | 2-3 days |
| P4 Release | 2.0.0 | Config migration, CLI, tutorial, README, tool descriptions that steer agents to the bulk tools, full gates, GitHub release and npm publish (only after your go-ahead, as always) | 0.5-1 day |

Total: about 8-10 days of agent work, plus live experiment runs. Each phase
can be released on its own; P0-P1 alone covers the Sampo-type slowdown.

## 9. Configuration and migration

```json
"decider": {
  "provider": "typesafe",
  "apiKey": "<kept in this file only, mode 0600>",
  "model": "jev-1.13.0",
  "localUrl": null,
  "timeoutMs": 3000,
  "longContext": false,
  "features": {
    "resolve": true, "assert": true, "fill": true, "find": true, "wait": true,
    "triage": true, "guard": "code", "run": false, "vision": false
  }
}
```

- An existing `jev` section is read as `provider: "typesafe"` with the same key
  and settings, so 1.4 configs keep working unchanged.
- CLI:
  - `mybrowser-mcp decider status | set-key | use-local <url> | off`;
  - `mybrowser-mcp jev set-key` stays as an alias;
  - every command validates before it writes, as `jev set-key` does today.
- The tutorial step changes from "add a Jev key" to "optional: add a decision
  model (TypeSafe key, or a local server)".

## 10. Risks and open questions

**Risks:**
1. **Real-site DOMs.** Meta, Google and Shopify use custom widgets my replica
   pages don't. E5 and E10 run first in P1, and their results can change P1's scope.
2. **Agents ignoring the new tools.** Agents wrote 290 `browser_eval` scripts
   in the Sampo session. Tool descriptions, plus a hint in long-form snapshot
   results ("12 settings in view: `browser_assert` can check them in one call"),
   are measured in E6.
3. **Vendor change.** TypeSafe is API-only and models move. Mitigations:
   pinned versions, per-model thresholds, the local provider, and the `none` path.
4. **Privacy.** Labels, section names and page text excerpts go to TypeSafe;
   values never do. The README says so, and the local provider keeps everything
   on the machine.
5. **Page text steering Jev.** Covered by the guard, by risk classes, and by
   checking every action's result.
6. **Rate limits.** TypeSafe limits are per organisation; batching keeps
   requests few, and at most 4 run in parallel.
7. **Site terms.** Bulk actions on LinkedIn and similar sites may break their
   rules. `triage` defaults to slow pacing and a dry run, and the README says
   the risk is the user's.

**Open questions (they don't block P0):**
1. Should the code-only guard be on by default from alpha.1? I recommend yes.
2. Any real sites besides Meta Ads, GitHub, Gmail and Shopify admin for E5?

## 11. Jev uses from the research, and where each lands

| Use found | Source | In this plan |
|---|---|---|
| Operation + speculative targets in one request | browser-use `jev-ultrafast` | `browser_run` step (5.8) |
| Two independent judgments before "done" | `jkudish/jev-browser` | `browser_run` done rule; `expect` confirm/contradict (4.5) |
| Loop fuses (cycle, revisit, idle) | `0x7067/jev-browse` | `browser_run` fuses; engine stop rules (4.4) |
| Plan once, Jev runs the loop, hand back on doubt | `vlad-terin/jev-browser` | `needs_choice` hand-back everywhere; `browser_run` |
| Effect check on the next page | CodexQA, jev-browser-qa | `effect` lines and `expect` (4.5) |
| Many questions in one request | TypeSafe fan-out pattern; E1 | Engine batching with one shared element list (4.2) |
| Line-by-line search plus "is it there" Noul | TypeSafe cookbook | `browser_find` `query` (5.4) |
| Sentence → function + arguments (54 questions in one call) | TypeSafe function-calling cookbook | Not adopted now: agents already call tools directly. Possible later as a natural-language entry point for voice control |
| Rank, then re-check | TypeSafe skill-suggestion cookbook | Order check on close or risky picks (4.2) |
| Pick from candidates found by code | TypeSafe pre-parsed extraction | Select options and combobox picks; `extract` values (5.3) |
| Citation check | TypeSafe cookbook | Possible P2 addition: check that `extract` results are supported by the page |
| Guardrail screening | TypeSafe cookbook, Spring AI | Prompt-injection guard (5.9) |
| Simple memory | TypeSafe cookbook | Site memory phrase map, learned only from verified actions (4.7) |
| Images as Choice options; frame history; tile search | TypeSafe images guide | Vision flag (5.10) |
| Confidence thresholds scaled by risk | TypeSafe confidence guide | Risk classes (4.6) |
| Self-consistency over repeated asks | TypeSafe cookbook | Order check only (cheaper); full self-consistency not needed at 0 wrong picks |
| Classifying many items | TypeSafe classification cookbooks; our LinkedIn run | `browser_triage` (5.7) |
| Open local decision models (Strands Decider, in-browser ONNX) | AWS Strands Labs | `local` provider (4.2); in-browser WebGPU noted for later, not planned |
| Real-time voice control at ~300 ms | community demo | Not planned; becomes possible on top of `browser_run` |
