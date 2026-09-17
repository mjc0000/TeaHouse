[中文](./README.md) | **English**

<img src="web/logo.svg" width="96" alt="teahouse, a cup of steaming tea" />

# teahouse

A local single-user roleplay frontend. Three things: **character cards**, **world books**,
**prompt stack**.

The design goal is **full compatibility with SillyTavern world book files** — JSON world books
that work anywhere work here. World book files are stored byte-for-byte; edits are written back
through field mappings, so unknown fields are never lost.

Zero runtime dependencies, zero build steps.

> Design decisions and rationale live in [DESIGN.md](DESIGN.md): architecture, the compat
> layer, prompt-stack semantics and the test setup are all there.

## Quick start

```bash
node --version        # needs >= 23 (runs TypeScript natively)
npm start             # default http://127.0.0.1:8787
```

Once the page is open:

1. Click Settings (top right), fill in endpoint URL, API key, model name, save.
   - Any OpenAI-compatible endpoint works: DeepSeek, OpenAI, Ollama, LM Studio, vLLM,
     OpenRouter…
   - E.g. DeepSeek: `https://api.deepseek.com/v1` + `deepseek-chat`
   - Settings come in five groups (general / appearance / model / roleplay / world books);
     switch in the left column or with arrow keys. Groups with unsaved changes get a small dot.
2. Bottom left, Import character card: pick a PNG or JSON card (a card's embedded world book
   takes effect automatically).
3. Bottom left, Import world book: pick a JSON file, tick to attach it to the current chat.
4. Start chatting in the middle.

## Three panels

- **Left**: character cards / world books (ticked = attached) / chats
- **Middle**: chat, with streaming output, regeneration (swipe variants), restart from any message
- **Right**: prompt stack (click blocks to toggle, takes real effect and is remembered),
  **world book hits** (the top dropdown is this chat's retrieval mode; below it, which entry hit,
  which key matched, and why), request preview (the real messages)

The "world book hits" readout is the main debugging tool: when a world book doesn't fire, it
shows directly whether nothing matched this round, the budget squeezed it out, or cooldown
blocked it.

## Editing

**World book entries**: click a world book name to open the editor. Add, duplicate and delete
entries, edit them field by field, or change the book's own "scan depth / token budget /
recursive scan". The form is generated from field metadata served by
`GET /api/worlds/fields` — the same metadata the server validates patches against, so adding
a field never desyncs the two sides.

Edits are **written back in the original format**: array-shaped books (CharacterBook) still get
`keys` / `insertion_order` / `enabled`; Risu still gets comma-joined `key` and `insertorder`.
Fields we don't understand are preserved as-is, copies included. Changed fields with no home in
the foreign format go under `extensions.tavern`; defaults are never written.

**Character cards**: list item `⋯` → Edit card. Editable: **name, author, version, tags,
description, personality, scenario, first message, alternate greetings, example dialogue,
system prompt, post-history instructions, creator notes**. The form field table
(`web/js/character-fields.js`) and the server's accepted patch table (`EDITABLE_CARD_FIELDS`)
are the same list, cross-checked by `test:web` — so "fillable in the UI but silently dropped
on save" can't happen. Writes go through the importer's **lossless** path: a PNG card stays a
PNG card, unknown fields preserved as always.

The same menu renames the display name, changes the id (directory name, migrating its chats
along), exports the card JSON, **exports the card PNG**, deletes (refused by default when chats
exist; the UI asks whether to delete them too). PNG export hands over that card's own carrier
(with the current data embedded); cards whose carrier is JSON get this item greyed out with
the reason stated.

**Greetings**: a new chat automatically drops the card's **first message** in as message one
(the character speaks first, instead of an empty chat waiting for you). Cards with alternate
greetings get an extra menu item, "New chat (pick a greeting…)"; `POST /api/chats` accepts
`greeting: <index>` (`0` = first message, `-1` = no greeting), and the greeting text is taken
from the card by the server — callers can't smuggle in arbitrary text.

**World books export to the native tavern format** (list item `⋯` menu), so books from other
tools can go straight to SillyTavern.

## Interaction

**Every message**: hover for the toolbar, right-click for the same menu. Copy text, **inline
edit**, retry this reply, restart from here, delete just this one. Saving an edit refetches the
assembly preview, so tokens and hits follow the text.

Replies with swipe variants edit the **currently active** variant; the other candidates are
never silently dropped. "Delete just this one" re-hangs later messages onto its predecessor,
keeping the rest of the chat intact; "restart from here" first confirms how many messages
will go.

**Forking**: "Fork a new chat from here" in the message menu copies **the transcript up to this
message** into a **new chat** and switches to it; the original chat is untouched — the
non-destructive way to "keep this path and try another" (tavern branches are also separate chat
files, not a tree inside one file). Chat rows' `⋯` also offer "Duplicate as new chat", copying
the whole transcript.

**Chat log import/export**: chat row `⋯` → "Export as tavern jsonl" produces tavern JSONL
(header `chat_metadata` / `user_name` / `character_name`, per-message `mes` / `is_user` /
`send_date` / `swipes` / `swipe_id`); top-left Import record reads it back, **and our own
jsonl too**, so export-then-import round-trips losslessly. Unreadable lines are skipped and
counted instead of failing the whole file; everything except `greeting` is taken from the file.

**Right side**: a context usage bar on top (`used / total · remaining`, yellow past 80%, red
past 100%). The used value prefers provider-measured anchoring; the breakdown is estimated,
always marked `~`, and labeled which kind it is. The prompt stack folds into four groups
(system prompts / character & world books / chat & examples / absolute-position injections)
with subtotals; per-line toggles take real effect and are remembered. Request preview rows
expand to full text, copy individually, or export the whole JSON.

**World book hits**: a hit book gets a "hits N" badge in the left list; clicking it jumps to
the entry editor with the hit entries and matched keys highlighted. Empty hits explain why
(squeezed out by budget / blocked by timing / key outside the scan window).

**Quick replies**: a shortcut bar above the input box; each button holds a snippet of
frequently used text. **Click to insert into the input** (then keep editing),
**Ctrl/⌘+click to send directly**. The Edit button on the right adds/removes/edits entries
(each has button label, body, and a show/hide flag), and can **import tavern quick-reply JSON**
(the `{ quickReplySlots: [{ mes, label, enabled }] }` shape is accepted as-is); export gives
the same shape. Stored as `data/quick-replies.json`, plain text, hand-editable.

**Slash commands**: type `/` in the input and a command list pops up above — like an agent CLI:
keep typing to filter by prefix, ↑↓ to pick, Tab or Enter to complete, Esc to dismiss. Sending
executes it; **the command line itself is never sent as a message**. The list **only shows when
the input really is a command line and matches at least one command**: slashes inside normal
sentences (`10/20`), prefixes matching nothing (`/zzz`), or an emptied input stay hidden and
never cover the chat. Available now:

| Command | Effect |
|---|---|
| `/help` | List all commands (dialog) |
| `/send <text>` | Send the text as your message |
| `/sys <text>` | Insert a system message, no reply triggered |
| `/regen` | Regenerate the last reply |
| `/continue` | Keep writing the last reply (appends in place, no new message) |
| `/impersonate` | Generate one message in your place, stored as `user` |
| `/memory` | View, edit, or immediately refresh long-term memory |
| `/new [name]` | Open a new chat with the current character |
| `/model [name\|default]` | View or switch this chat's model (`default` = clear override) |
| `/persona [name\|default]` | View or switch this chat's persona (`default` = follow default) |
| `/world [book] [on\|off]` | View/attach/detach world books; no switch flips it |
| `/reasoning [on\|off]` | Show or hide thinking (global setting) |
| `/export` | Export the current chat as tavern JSONL |
| `/fork` | Duplicate the whole current chat into a new one |

Commands only call the same endpoints the UI itself uses — no new backend routes. A leading
`//` stays a normal message (to send a line starting with a slash, type two).

**Continue / speak for me**: "Continue / Speak for me" buttons next to the input. Continue keeps
writing the last AI reply (appends in place, no new message; with multiple swipe candidates it
edits the current one). Speak-for-me writes a new message for you, stored as a `user` message.
The impersonation prompt is a real block in the prompt stack (toggleable, token-counted); it is
injected as **the last user message of the request** — before the chat the model treats it as
continuation, and as `system` it treats it as background and keeps talking in character (both
are measured pitfalls). The wording follows **your recent messages' person and tone**, and
explicitly forbids speaking in character or continuing the last narration. With "auto-reply
after speak-for-me" on (general settings), it immediately runs one more round so the other side
answers (one extra model call, off by default). The message menu's "Continue" is only clickable
on the last message when it is an AI reply; `/continue` and `/impersonate` take the same
backend path.

**Context template**: "Context template" in settings → roleplay — tavern's story string
(`{{description}}` / `{{persona}}` / `{{wiBefore}}`…, conditional `{{#if}}`), rendered as a
real "Context Template" block in the prompt stack (after scenario, token-counted, toggleable).
Empty means the original stack; once filled, switch off the four matching standalone blocks so
nothing is sent twice. Tavern context preset JSON imports and exports both ways; "restore
tavern default" fills in its stock template. Bad field names or content fields missing from the
template are spelled out in the assembly preview warnings.

**Regex replacements**: "Regex…" at the bottom of the right-side prompt panel opens the editor.
Each rule has name, expression, flags, replacement, scope (display only / prompt only / both),
and a switch; replacements support `$1` / `$&`. Storage is always the original text: display
side only changes what you see, prompt side only changes the outgoing request (the preview says
which rule rewrote how many spots); editing and copying never see it. Uncompilable rules can't
be saved; each rule can be tried on a sample first.

**Message Markdown**: `**bold**`, `*italic*`, `***both***`, `~~struck~~`, `` `code` ``, fenced
code blocks, quotes, `#`…`######` headings, ordered/unordered lists (one nesting level
supported), `---` rules, `[text](https://…)` plus **bare URLs** and math render by default
(toggle in settings → appearance). **`---` always draws a rule** (never a CommonMark level-2
heading); `![image](…)` deliberately does not render an `<img>` — that would leak your IP to
an address the model made up. `\(…\)` inline math and `\[…\]` / `$$…$$` blocks (a LaTeX subset:
sub/superscripts, fractions and roots, sums and integrals, matrices, equation systems) typeset
directly; readout speaks formulas as words. Sanitizing is structural: only safe nodes are built,
never `innerHTML`, so a `<script>` hidden in a card shows up as punctuation. Editing and
copying always use the original text. `{{user}}`-style macros in model output only expand for
reading (storage untouched).

**Multiple personas**: the persona library in settings → roleplay adds/edits/deletes/sets the
default; the "Persona: X" button in the chat header pins a persona for this chat only (clear it
to follow the default); `/persona [name|default]` takes the same path. Old chats that never
joined the library keep using the two legacy fields; deleting a persona never breaks a chat
(it falls through to the next level).

**Images**: paperclip on the input attaches images (JPEG/PNG/GIF/WebP, 32MB each) that travel
with the message for the model to see (`deepseek-flash` vision verified against the official
Vision guide); thumbnails in the bubble, click to enlarge. Originals live in `data/images/`,
messages only reference them; history messages send text only (saves tokens), and the preview
states how many images and roughly how many tokens they add.

**Translation**: with a reply language set, foreign-language messages are auto-translated into
it for display (an English opening with a Chinese preset is exactly this case). Translations
show by default, an "original/translation" switch on the message flips back anytime, and the
menu's "Translate" re-translates manually. The original is always what's stored; the translation
is a cached attachment (editing, switching candidates or languages re-translates); import and
export don't carry it. Each foreign message costs exactly one model call; the switch is in
settings → general.

**Group chats**: top bar `teahouse ▾` → "**New group chat…**" → tick two or more characters →
create. The first ticked is the **initiator** (the chat's main character); tick order is the
default speaking order; an empty group name auto-builds from member names. **A group is a
property of the chat itself, not a switch**: 2+ members means group chat, with a "group N"
badge in the chat list and the lineup plus current mode in the chat header. To change the
lineup: chat row `⋯` → "Group members…" (ticking makes it a group, **unticking all returns it
to solo**).

**Who speaks is decided by "group mode"** (right column, only in group chats):

| | Mode | Who speaks |
| --- | --- | --- |
| **A** | Round-robin replies (default) | The director names one, the rest fill in lineup order |
| **B** | Natural | `@name` wins; the rest roll dice by **talkativeness**, all misses pick a talkative one |
| **C** | List | Lineup order, everyone in turn |
| **D** | Pooled | Prefer whoever hasn't spoken since your last message |
| **E** | Manual | Only `@`-mentioned members speak; nobody mentioned means no generation |

**Max replies per round** (set in the member picker) is the hard cap for all modes:
1 (default) / 2 / 3 / unlimited. A leading `@name` always wins (every mode); retry and
regeneration keep the original speaker. **Talkativeness** (one slider per member in the picker,
0–100, shy/regular/chatty) lives on the character itself, shared by all group chats; a card's
`extensions.talkativeness` is adopted first if present, otherwise 50.

**Each member can use their own endpoint and model** (first save endpoints in settings →
model → "extra connections", then assign per member in the picker). Unassigned members follow
the chat. So Enola can run DeepSeek while Haena runs GLM — styles instantly differ. Note these
remain "several independent calls", not multiple models in one room. Assignments show in the
header lineup (`Enola (GLM) · Haena`), and each trajectory turn records the model its speaker
actually used.

**Several members per round** ("replies per round" in the picker, default 1): one of your
messages can have **2 / 3 / all members** answer in turn. With several, the first is picked by
the director (or rotation), then each next one re-runs "who speaks" (so the same person never
doubles up); each reply is ordinary: its own `speaker`, trajectory entry, connection and model.
You say hi, three people answer in turn — no longer just one. The model first nominates who
replies (falls back to rotation, never stuck); `@name` in the input calls someone out;
retry/re-roll keeps the original speaker. Every reply records its speaker, the header shows the
lineup, the trajectory too. Members' embedded world books all enter the scan.

**Sprites**: the board at the top of the right column follows messages and swaps expressions
automatically; the manual dropdown pins one. No hand-copying: panel "Manage" → "Upload
sprites", pick files and fill in a keyword (same name replaces; × asks before deleting).
**Importing a PNG character card automatically sets its carrier image as the "default"
sprite**, never overwriting an established face. Dropping files straight into
`data/sprites/<character>/` works too — the filename is the keyword (`happy.png` shows up on
"happy"), `default.png` is the standing face. The current sprite also blurs across the chat
area as backdrop (panel "chat backdrop" switch, on by default, follows manual picks; "blur"
slider sets the amount, "up/down" nudges the framing, smart framing finds the face itself).

**Voice**: its own page in settings. "Read aloud" in the message menu speaks it; click again
to stop; a new message also stops playback. Two engines: local (browser's built-in Chinese
voices, offline and free, default) and online (OpenAI-compatible `/audio/speech`, key stored
only on this machine, proxied through the server, the browser only ever sees audio). It reads
the Markdown-stripped version; editing and originals unaffected.

**Appearance**: its own page in settings (general / appearance / model / roleplay / world
books); theme, accents and Markdown switches live here, and the small button bottom-right does
the same.

**Chat fonts**: six open font stacks on the appearance page (system default / Noto Sans SC /
LXGW WenKai / Noto Serif SC / IBM Plex Sans SC / monospace) + size; used when the machine has
them, falling through otherwise. Drop `.woff2` etc. into `data/fonts/` (or upload on the
appearance page) and they appear in the list. Choices live in this browser, server data
untouched.

**Trajectory**: the "Trajectory" button top-right flips the whole right panel to the trajectory
view (click again to flip back, shortcut `Ctrl+T`). It records **what the program did**,
stored apart from the chat record (what was said): `data/chats/<id>.trace.jsonl`, one event
per line.

- One line per request round: model, start time, **first-token latency**, total time, provider
  input/output tokens, visible length, thinking length, whether trimmed, which world book
  entries hit, failure reasons, plus **the messages actually sent that round** (only the latest
  20 rounds kept; older ones keep numbers).
- Plus rows for memory updates, edits, deletes, restarts-from-here, forks, imports, new
  candidate replies.
- A two-color bar (input / output) per round on top; clicking jumps to that round; filter by
  "all / requests / world books / memory / edits".
- Selecting a row shows three tabs: **overview / preview / raw** — numbers and hits, message by
  message, and copyable/exportable request JSON.
- Trajectory **only reads business data**: it never changes what the model sees, and "clear"
  only clears the trajectory — chats and memory untouched.

**Retrieval modes (one extra channel on top of keyword scanning)**: keyword scanning always
runs; the mode only decides **which extra** entries get injected. A dropdown above the right
column's "world book hits" pins it per chat; default follows the global setting (which is
"keyword only" until touched).

- **Keyword only**: default. Only keyword hits enter.
- **Full injection**: pours the character's whole **embedded book** (the one skill imports land
  as references) in, ignoring keywords. When embedded and world-book text collide, the world
  book entry wins by default and the embedded duplicate is dropped; "force embedded on
  conflict" in settings keeps both. "Full injection also covers world books" pours attached
  world books too (costs more).
- **Vector retrieval**: next section (needs an embedding endpoint).
- **Model-picked**: one extra cheap model call per round, letting it pick wanted entries from a
  candidate catalog (configurable cap).
- **Agent file reading**: closest to the Agent Skills idea. Skill-pack files plus card-embedded
  book entries are listed as a catalog for the model, which gets a `read_file` tool; it decides
  what to read, and what it reads is injected as standalone blocks. Bounded (default 3 rounds /
  6 files, adjustable on the settings page), reads only this app's own skill packs and embedded
  books, **executes nothing**.

Modes stay compatible with old configs: the legacy `scan.modelSelect` / `vector.enabled`
switches map to modes on **first read**, then modes take over — the settings page **no longer
shows those switches**, and if they're still on while the mode disagrees, the world book page
shows an orange migration hint telling you exactly which "injection mode" to pick. Vector
retrieval is now controlled by the mode alone: queries only go out with the "vector retrieval"
tier.

**Vector storage (semantic world book activation)**: entries that fire on embedding match
instead of keywords work here now. Settings → model holds **two endpoint configs** (both saved,
"currently used" switches):

- **Local**: default `http://127.0.0.1:11434/v1` (Ollama; LM Studio / llama.cpp / vLLM serve
  `/v1/embeddings` the same way), no key, nothing leaves the machine. Install:
  `ollama pull nomic-embed-text`.
- **Remote**: any OpenAI-compatible embedding service (OpenAI / SiliconFlow / Zhipu…), needs
  URL, key, model. **Note**: remote mode sends world book entry text and recent messages to
  that endpoint.

After configuring: tick "vectorized" in the entry editor (or flip "index all entries") →
click the "vectors N/M" badge on the world book list for incremental rebuilds (settings →
world books → vector retrieval also has "rebuild all indexes" and a status overview) → switch
"injection mode" to "vector retrieval". Each round then queries once with recent messages; hits
enter **the same injection pipeline as keyword hits** (position, depth, budget all apply), the
right-side hits panel writes "vector hit 0.42", and the score is what you tune the threshold
with; "try a query" previews what a sentence would hit.

Your chat endpoint often has **no** embedding API (measured: DeepSeek's `/embeddings` is 404),
hence the separate config — "test vector service" in settings tells you straight whether it
connects. Indexes live in `data/worlds/<id>.vectors.json`, sidecar files that **don't touch a
word of the world book originals**; switching embedding models invalidates old indexes and
asks for a rebuild.

**Long-term memory**: with it on (settings → roleplay), every N messages (default 10, same as
tavern's Memory extension) the model extends **the previous summary** with "messages since the
last summary" into one passage, injected as a standalone `[Summary: …]` block at 2nd-from-last
position. It is a real block in the prompt stack: its own token count, visible injected content
in the right column's assembly preview, toggleable on its own; **not one chat record is
rewritten** (summaries only add, never delete messages).

The "memory" badge in the chat header (tinted when an update is due), "Edit long-term
memory…" in the right column, and `/memory` all open the editor: edit text, summarize now,
freeze (stop auto-updates, manual still works), clear. Summaries live in
`chats/<id>.meta.json`, off by default; import/export converts both ways with tavern's
Memory extension `extra.memory`, so memories move over and keep working.

**Looks / themes**: a permanent small button bottom-right (palette icon) switches **accents**
(indigo / violet / teal / amber / rose / moss) and **brightness** (light / dark / follow
system) — two seconds, no settings needed. Settings → appearance has the same pickers (two
entries to one implementation, plus chat fonts and size). Switching flips one attribute; every
color comes from a palette token, so **adding a theme never touches a component** — one block
in `web/style.css` plus one record in `web/js/themes.js` does it; `test:web` checks every theme
defines the whole contract. Choices live in the browser (not `data/config.json`); "follow
system" is driven by the stylesheet's `prefers-color-scheme`, following system switches
instantly.

**Accents are a second orthogonal axis**: they only override the accent family (including your
own message bubbles), so 6 accents × 2 brightnesses = 12 looks, while adding an accent is the
same few lines of CSS — tests watch it too: all three brightness variants complete, both light
copies identical, button swatches matching the palette. Accents and brightness live in the
browser, switchable anytime.

**Panel folding**: two buttons top-right fold the side panels away IDE-sidebar style; the middle
chat area takes the space.

**Provider presets**: the top row of settings → model is a "provider preset" dropdown with 29
built-ins: DeepSeek / Zhipu GLM / Z.AI (incl. the domestic coding endpoint) / **OpenCode Zen
and OpenCode Go** / OpenAI / OpenRouter / Gemini / Anthropic compatibility layer /
Moonshot (domestic and international) / Qwen / SiliconFlow / Groq / Mistral / xAI / Together /
Cerebras / Fireworks / NVIDIA NIM / Hugging Face Router / Baseten / Vercel AI Gateway /
Xiaomi MiMo / Ant Ling / plus local Ollama, LM Studio, llama.cpp. Picking one fills in the
"endpoint URL". **It only fills fields, it doesn't save for you** — still press Save. Endpoints
missing from the table work fine typed by hand.

Why so simple: these endpoints now speak one protocol, **OpenAI Chat Completions** (Gemini has
official `/v1beta/openai/`, Anthropic has an official OpenAI-compatible layer, at the cost of
no caching/extended thinking). So "supporting a new provider" is **one data row**, not code;
endpoints missing from the table work typed by hand all the same.

Model IDs / context windows / max output ride in the same table (**only values stated in
vendor docs**; otherwise "unrecorded", never guessed): picking a known model shows "known X:
window … · max output …", and "apply window" fills it into "context window".

**The window is a fact about the model, not a preference**: whenever the current model has a
known window (measured values win over documented ones) while "context window" still sits at
the factory default 65536, the server **adopts** the known value — otherwise a fresh setup
keeps rationing a 1M model with 65536 forever and never heals (too far apart for overflow
learning to trigger). Any value you filled in yourself (even smaller than default) is **left
alone**; the next save writes the adopted value into config.json, so field and effective value
never disagree.

**Models** come in two layers once endpoint and key are set (the app pulls `POST /api/models`
once at startup):

- **Default model** (`config.model`): picked in settings → model, applies on save. Only here
  changes it.
- **Chat model** (`chats/<id>.meta.json`'s `model`): a new chat **snapshots the then-default
  model in**; afterwards the chat uses its own. Changing the default never rewrites existing
  chats. The top bar dropdown switches this value and **never** touches the default. When it
  differs from default, the first dropdown item is "follow default (X)" — clicking it clears
  the override.
- Generation and assembly take "chat model → (old chats without one) default".

**Sampling parameters**: temperature, frequency penalty, presence penalty, `top_p`, same two
layers as models:

- **Defaults** (settings → model → sampling & budget): a new chat **snapshots all four values
  in at build time**; later default changes never rewrite existing chats.
- **Chat values** (right column "request parameters"): sliders + number boxes; dragging only
  changes the number, releasing saves; stored as this chat's own snapshot. "Restore defaults"
  deletes the snapshot and the chat follows live defaults.
- Forked chats carry the original snapshot along; `frequency_penalty` / `presence_penalty`
  really go to the provider (temperature/`top_p`/cap used to be the only ones passed).

Both are custom dark dropdowns (not native `select`/`datalist` — those popups are browser-drawn
and can't follow the theme), one component renders both; "fetch model list" button/menu item
re-pulls anytime; a successful connection test reuses the returned list. **Pulled lists are
cached to `localStorage` (`teahouse.models.v1`)**: boot reads the cache first, a successful
pull overwrites, a failed pull (offline) keeps serving the last list labeled "offline cache"
instead of going empty. Providers without `/models` give an empty list; hand-typing still
works. Choices persist in the browser. Shortcuts `Ctrl+B` (left) / `Ctrl+Alt+B` (right).

**Reply language**: settings can dictate which language the model answers in. The language is
**free text**, so "中文", "English" and "文言文" all work — even "Martian" gets an honest
attempt. Empty means no instruction is injected. The instruction itself is editable (the
template's `{{language}}` is replaced with your language), and settings **live-preview the
line about to be injected**.

It is a real prompt block (called `Reply Language`, after Main Prompt), so it shows in the
right-side prompt stack, has its own token count, and can be switched off alone — instead of
an invisible splice hidden inside the system prompt.

### Keyboard

| Key | Action |
|---|---|
| `Ctrl+Enter` | Send |
| `Esc` | Close the topmost dialog, menu or command list; cancel while editing; abort while generating |
| `Ctrl+B` / `Ctrl+Alt+B` | Fold/unfold the left / right panel |
| `Ctrl+T` | Right panel: prompt / trajectory switch |
| `Ctrl+E` | Edit the focused message |
| `Ctrl+Shift+C` | Copy the focused message |
| `Ctrl+Shift+R` | Regenerate the focused reply (confirms first when it isn't the last one) |
| `Shift+F10` / menu key | Open the action menu on the focused message |
| `Tab` / `↑` `↓` / `Enter` | Cycle focus inside dialogs; navigate and activate inside menus |
| `↑` `↓` / `Home` `End` | Switch categories in the settings dialog's left column (pages follow) |

## Settings

The left column holds categories (each with an inline SVG icon); the right shows one page at a
time. Every row is "name + description" on the left, control on the right, a thin divider
between rows; multi-line text (persona, instruction templates) spans the full row, and the
world book page groups rows as "vector retrieval / scan range / budget / recursion / background
injection / compat switches". The appearance page (theme + accents + chat fonts/sizes +
Markdown switches) and the small bottom-right button are the same implementation.

Every field is declared once in `web/js/settings-schema.js` (page, icon, group, control type,
ranges, save payload). A few behaviors worth knowing:

| Category | Covers |
|---|---|
| General | Reply language, custom instruction template, language presets + a live preview of the line about to be injected, foreign auto-translation, **auto-reply after speak-for-me** |
| Appearance | Theme, accents, chat fonts and sizes, self-hosted fonts, message Markdown switches |
| Model | Endpoint (**provider presets** / URL / key / model), **extra connections** (endpoint list for group members to use individually), **sampling & budget** (temperature, `top_p`, **frequency penalty**, **presence penalty**, context window, reply reserve, **per-reply cap `maxTokens`**, **stop strings**), **token counting** (`tokenizer.json` path, **real-request-usage switch**, current counting mode, connection test, model list pull), **thinking** (show thinking / disable thinking) |
| Roleplay | Your name and your description (legacy pair, fallback), persona library (add/edit/delete/set default), context template (with tavern preset import/export) |
| World books | Scan depth and minimum activation, budget percent and cap, recursion, and 5 tavern-compat switches |

About some of the parameters:

- **Per-reply cap `maxTokens`**: 0 = don't send the parameter, use the server default. ⚠️ On
  reasoning models a small cap lets thinking eat the allowance and **the body comes back an
  empty string** (measured); leave headroom if you cap at all.
- **`top_p`**: nucleus sampling, 1 = no trimming. Usually only touch temperature; tuning both
  gets out of hand fast.
- **Stop strings**: one per line (or comma-separated); hitting one stops generation. Use them
  to cut the model talking to itself or mimicking extra speaker prefixes.
- **Real request usage**: on, requests carry `stream_options.include_usage`, giving the
  provider's real prompt/output usage — both the budget bar anchoring and the counter
  calibration rest on it; off leaves only estimates.

- Saving **PUTs the whole config at once**, and every page's controls are built together, so
  switching pages halfway never loses edits.
- Text fields **always send** (clearing "reply language" really clears it); emptied number
  boxes **don't send** (never become 0); list fields send as arrays (stop strings never become
  one comma-joined line); an API key showing `***` is not sent.
- Out-of-range values never save silently: the dialog jumps to the offending category, pins the
  reason under that row, and focuses it.
- Keyboard reachable: arrow keys / `Home` / `End` switch categories, `Tab` is trapped inside
  the dialog (controls on hidden pages are never tabbed to), `Esc` closes. All of it really
  pressed by `test:ui`.

## Thinking (reasoning models)

Reasoning models like `deepseek-flash` first output **thinking** (`reasoning_content`) before
the body. Two consequences: a blank stretch before the body that looks stuck; and if
`maxTokens` is set too small, thinking may eat the budget and the body comes back an empty
string.

Both switches live in settings → model → thinking:

- **Show thinking** (default on): shows "thinking…" live during generation, turning into
  "thinking" once the body starts; after the round it is stored with the message, collapsed by
  default, expandable anytime for review (saved per candidate reply — swiping shows the current
  one's thinking). It is **never** sent back to the model: assembly only reads the body.
- **Disable thinking (experimental)** (default off): sends `reasoning_effort: "none"` together
  with `thinking: {"type":"disabled"}` in the request, letting the model skip thinking (first
  byte sooner). Both measured effective on api.deepseek.com; unknown parameters are just
  ignored there without error, but if a strictly-validating endpoint errors on them, switch
  this back off.

## Tests

```bash
npm test
```

Eight suites, 3958 checks:

| Suite | Contents |
|---|---|
| `test:conformance` | 468 checks: 12 owned samples × (format recognition, lossless round-trip, field writes, add/delete restore, **per-field round-trip of new entries**) |
| `test:scan` | 100 checks: key splitting and match primitives, activation rules, scan depth, recursion, budget, inclusion groups, sticky/cooldown/delay, position buckets |
| `test:prompt` | 289 checks: marker filling, card overrides, macro expansion, absolute injection, **reply-language block**, **long-term memory block and trigger logic**, **impersonation block**, **context template rendering**, **regex rewriting**, **translation detection**, **image sniffing**, **display macros**, **retrieval modes (mode parsing and legacy-switch mapping, full-injection scope / conflict dedup / force switch)**, **agent file reading (readable catalog / lenient arg parsing / whitelist and out-of-bounds refusal / round and file caps / preview never calls / provider failure)**, **overflow recognition and number extraction (real vendor wordings for DeepSeek / OpenAI / Anthropic / Google / Together / xAI / Qwen, numberless wordings, rate limits don't count as overflow, cache key normalization)**, **model-picked retrieval (candidate catalog / lenient parsing / cap and truncation)**, **group modes (roster generation: A's first seat + rotation, B's mentions/dice/fallback and no-repeat rule, C all members, D skipping recent speakers, E mentions-only; @ matching edges and CJK; per-round cap)**, trimming |
| `test:tokenizer` | 39 checks: BPE round-trip, special-token atomicity, counting and calibration convergence |
| `test:api` | 795 checks: end-to-end HTTP, incl. message-level edit/delete/retry, **continue (append in place) / impersonate (stored user message)**, **context template (store config → preview renders → off)**, **regex (store/fetch, illegal rejected, prompt-side rewriting, try-one)**, **persona library (store/fetch, illegal rejected, default into requests, per-chat pin and follow)**, **fonts (list/upload/serve bytes, traversal and suffix rejected, delete)**, **skill import (SKILL.md / zip → character card, frontmatter mapping, references into the embedded book, unknown fields and originals kept, bad/empty/binary packs rejected)**, **translation (translate/cache, system messages and empty targets refused, batch endpoint: many lines per request, cache, per-line failure)**, **images (upload sniffing/serve bytes/sent with new messages/unknown rejected)**, **plain-text completion (flattened/stop strings/no error)**, **voice (masking/proxied speech/empty and overlong refused)**, entry add/edit/delete, character rename/re-id/delete, connection test, provider usage anchoring, **per-chat models (snapshot on create + override)**, **thinking channel (forwarded/stored/never re-injected into prompts/switches)**, reply language, **retrieval modes (full injection of embedded books, conflict dedup and force switch with world books, per-chat pinning and follow-default, model-picked once per round / bad answers never break the round)**, **agent file reading (tool-call loop, skill-pack files and embedded entries both readable, only whitelisted paths listed, prompt frame reports what was read)**, **provider presets (table contents, query-style matching, queries never change saved values)**, **overflow learning (warning frame, window written back to config and cache, single retry, no guessing without numbers)**, **long-term memory (switch/summarize/freeze/hand-edit/clear/failure kept/anchor untouched/interchange with tavern extra.memory)**, **trajectory (per-round numbers and bodies, failures recorded, memory and edit rows, bodies kept for the latest 20 rounds, bad rows never corrupt the file, clearing never touches chats)**, **vector storage (index/incremental/model-switch invalidation/disabled entries skipped/dead endpoint only drops semantic search/deleting indexes never touches books)**, original-format write-back, SSE, restart durability |
| `test:web` | 1456 checks: asset serving, module syntax, **import resolution**, **architecture constraints**, **settings schema and save-payload rules (config-path uniqueness for scoped fields, mode options matching server constants, retired switches hidden, migration-hint logic)**, **provider presets (unique ids, positive model caps, URL normalization and matching, path-style base URLs never rewritten)**, **learned caps beating documented ones**, **fixed settings-dialog size and scrollbar styling**, **`hidden` states requiring matching CSS rules (class names aren't pixels)**, **three-column grid with draggable gutters (track variables, column slots, col-resize, folded gutters)**, **skill import accept (.md / .zip) and "full injection / model-picked" labels**, **budget arithmetic unit tests**, **client/server language-rendering parity**, **display-side regex parity with server**, **context preset round-trip and default-template parity**, **Markdown never touching innerHTML**, **persona parsing parity**, **appearance page ownership**, **font registry and fallback**, **translation detection and cache freshness**, **display macro parity**, **voice page and Markdown stripping**, **slash command registry**, panel folding styles, DOM id and state field cross-checks |
| `test:ui` | 230 checks: **really running the settings dialog** — six categories, arrow/Home/End keys, Tab focus trap, Esc closing, row layout, illegal values jumping pages, save payload, control round-trips of all 41 entry fields, **migration-hint slot for retired switches**, **provider preset row with address fill** |
| `test:boot` | 581 checks: **really booting the whole page** — real `index.html` + real `app.js` + real server: importing world books/cards, rendering three panels, assembly preview and hits, panel folding and **gutter drag/keyboard resize with persistence**, settings dialog, inline editing, **really sending a message and streaming it to completion**, **live thinking display and fold-back review, both thinking switches**, **card editing and greetings**, **chat log interchange and forking**, **request parameter switches and PNG export**, **quick replies (insert/direct-send/tavern JSON import)**, **slash commands (palette open/filter/arrows/complete/Esc, show and no-show edges, unknown commands never sent, /sys, Ctrl+Enter sending, /regen, /continue, /impersonate, /model, /persona, /world, /new, /export, /help)**, **continue and speak-for-me (input buttons, message menu, slash — three entries)**, **render trio (Markdown (bold/code/script-escaping, rules/ordered lists/nesting/bold-italic/bare URLs), voice dropdown race, display-side regex rewriting but storing originals, template as a real stack row, regex editor open/save, re-renders reusing parsed Markdown)**, **persona library (header badge and menu pinning, /persona, settings page management)**, **appearance page (theme cards, font stack selection and fallback, sizes)**, **images (attach-send, bubble thumbnails, click-to-zoom)**, **translation (auto-translating foreign text, original/translation switch, menu re-translate)**, **voice (voice page, voiceless-environment notice, menu readout)**, **group chats (members, speakers, @ mentions)**, **sprites (keyword switching, manual picks)**, **brand menu**, **long-term memory (auto-summary after replies land, header badge, editor hand-edit/freeze/clear, /memory, injection in previews)**, **trajectory (mode switch/timeline/bar chart/three tabs/filter/clear)**, **vector storage (two endpoints/test connection/tagging and indexing/retrieval mode picker with "vector hit" in the hits panel/deleting indexes never touches books)**, **provider preset row with unknown-endpoint hint**, **new chats snapshotting the default model, top-bar switching of chat models (default untouched), model list disk cache**, world book editor, assorted menus and double confirmations |

`test:ui` uses `scripts/shim-dom.ts`: a hand-written minimal DOM (zero dependencies) implementing
only what `web/js` really uses. No jsdom keeps "zero dependencies"; the cost is that it isn't
general — unimplemented APIs are simply absent and throw on use, instead of quietly behaving
differently from a browser. "Clicking settings does nothing" errors are green in syntax checks
and id checks; only a real click exposes them — which is why these two suites exist.
`test:boot` goes further: it parses `index.html` into this DOM and feeds it real data from a
real server, so "the view reads a field the server never sends" also becomes an error overlay
that fails the test.

`test:api` embeds a fake OpenAI-compatible service, so no real API key is needed.

All test data is generated by `npm run fixtures`; **the repo contains no third-party content**.
To additionally verify against real world books from the web, drop JSON files into
`corpus/local/` (not versioned) — conformance picks them up automatically; real samples only
**report** unknown fields without failing, and that report is the entry point for discovering
new vocabulary. See `corpus/README.md`.

## Token counting: totals anchored to the provider, breakdowns estimated

Borrowing the DeepSeek Harness approach, **no per-model exact tokenization is chased**:

- **Totals (bar / percent) anchor to real usage**. After each generation the server stores
  `usage.prompt_tokens` from the response as this chat's anchor; the next preview's used value
  = anchor + heuristic deltas of later content (`projectedTokens`). So numbers are
  provider-measured, yet react immediately to edits and block toggles.
- **The breakdown itself is estimated**. Block subtotals, per-message rows and world book hits
  all use a fixed `~4 chars/token` estimate, always marked `~` in the UI, never forced to sum
  to the total (Chinese/JSON is systematically underestimated by this density).
- Exact is available if wanted: drop the model's `tokenizer.json` (HuggingFace format) at any
  path, fill in that path in settings, and the mode flips to `exact`. An optional override,
  not the default flow.

**What eats the window: an expandable "breakdown" sits under the right-column bar** (collapsed
by default). Expanded, it shows a per-channel share bar + one row per channel (prompt stack /
world books / long-term memory / agent-read files / chat history / images), each row listing
that channel's biggest entries (which book and entry for world hits, which messages for
history; past 12 folded into one "N more" row), and finally "available for prompts / reply
reserve / remaining". Percentages divide by the **window**, same as the bar above; channels not
counted get their own "other / uncategorized" row instead of being quietly swallowed. The
anchored/estimated and exact/estimated states collapse from three explanation lines into one
small mark on the title row (`estimated · anchored`).

**The context window learns itself when exceeded.** Successful responses never carry the window
size (only how many tokens this call used), but **overflow errors do**, and requests rejected
by providers aren't billed. So:

- When a generation is rejected for "input too long", the server recognizes the overflow from
  the raw error (20+ vendors' wordings, including `This model's maximum context length is N
  tokens`, `prompt is too long: N > M maximum`, `Range of input length should be [1, N]`…),
  extracting the window number;
- takes the "you actually used N tokens" in the error as a free counting calibration (Chinese
  underestimation is common);
- writes it to `data/model-limits.json` (cached per "endpoint#model"), changes "context
  window" to a working value, emits a `warning` frame + toast saying what changed, then
  **retries exactly once** — the prompt stack re-trims history to the new window;
- every new chat afterwards uses the cached value directly; the settings table marks it
  "(measured)" instead of "(documented)".
- Errors without numbers (e.g. Groq's "Please reduce the length of the messages"), providers
  that never error (z.ai silently accepts, Xiaomi MiMo truncates input) — warning only, no
  guessing.

## Data

All plain text files under `data/`, readable, editable, backup-friendly:

```
data/config.json
data/characters/<id>/card.png
data/worlds/<id>.json           ← imported raw bytes
data/chats/<id>.jsonl           ← one message per line
data/chats/<id>.meta.json       ← attached world books, macro variables, sticky/cooldown state
data/model-limits.json          ← windows/output caps learned from providers (deletable)
```

Runtime state like `sticky`/`cooldown` lives in chats, never polluting world book files.

## World book compatibility

Supports and **losslessly writes back** these sources:

| Source | Fingerprint |
|---|---|
| SillyTavern native | `entries` is an object keyed by uid |
| Standalone CharacterBook | `entries` is an array; entries use `keys` / `secondary_keys` / `insertion_order` |
| Card-embedded | `data.character_book` |
| Agnai Memory Book | `kind === "memory"` |
| Risu Lorebook | `type === "risu"` |
| NovelAI Lorebook | `lorebookVersion` |

The "standalone CharacterBook" row deserves a note: **tavern imports it but never triggers
it** (import only checks `entries` exists, while the frontend consumes an `entries[uid]`
object and reads `entry.key`). Huge popular world book sets online (e.g. the 1221-entry Elden
Ring collection) are exactly this shape. They work normally here, and export to the tavern
native format in one click.

Scan semantics align with tavern's `checkWorldInfo` entry by entry, including: regex keys
`/pattern/flags`, whole-word matching degrading to substring for multi-word phrases, budget as
a percent of the context window, recursion / minimum activation / delayed recursion as one
state machine, inclusion groups (sticky > activated > override > score > weighted random).

See [DESIGN.md](DESIGN.md) for details.
