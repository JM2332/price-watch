# Price Watch — project handover

**Business:** KML Foodservice, Barnsley. Independent wholesale food service.
**Owner:** Jake (director).
**Purpose:** Read Nationwide Produce's daily price list, report what changed against a
previous day, and flag when produce starts arriving from a different country.

This is the second generation of the tool — rebuilt as a split-file app
(`index.html` / `app.js` / `style.css`) using the same design system and Firebase
(Firestore + Auth) pattern as KML's other two tools, `canvassing-tool` and
`staff-holiday-tracker`. The parsing/comparison logic below is unchanged from the
original single-file prototype; only the storage layer and UI chrome changed.
Read this document before changing the parser or comparison logic — most of what
follows was discovered by testing against real files, and several findings
contradict what the data appears to say at first glance.

---

## 1. The single most important thing

**Nationwide's product codes are not stable.** A long numeric code in the source
sheet looks like a product ID. It is not. It tracks the consignment — it changes
when the grower or box mark changes, even when the product, pack and price are
identical.

Measured across 29 Jul → 3 Aug 2026: 131 codes present on the 29th were absent on
the 3rd, and 101 of those products were still being sold, under a **new** code.
Keying on the code produces a report claiming ~130 products were delisted and
~130 are new, every single day, while hiding roughly a third of genuine price
movements among them.

### The key that works

```
DESCRIPTION + SIZE + COUNT + PACKAGING     (all uppercased and trimmed)
```

Do not "improve" this by adding the code, the box mark, or the origin to the key.
Box mark and origin change constantly by design — that's what we're trying to
observe, not identify by. Implemented in `groupItems()` in `app.js`.

---

## 2. Source file anatomy

Filenames vary: `Nationwide_List_29_07_26.xls`, `Price_List_29_07_2026.xls`. Legacy
binary `.xls` (BIFF), not xlsx — SheetJS (loaded from CDN in `index.html`) handles it.

The sheet is **sectioned**, not flat: a branding block of varying height at the
top, section title rows (`Fruit`, `Vegetables`, etc.), a `Product`/`Description`
column header row repeated once per section, and blank spacer rows throughout.
`parseNationwide()` in `app.js` scans the first 40 rows for the header row rather
than assuming a fixed position, and skips repeated header/section rows as data.

Country of origin sits in a column with **no heading** — found by content (a
column where most values are two-letter codes), not by position, since its index
isn't fixed either.

Row counts for sanity checking: ~450-470 priced rows collapsing to ~420-460
products, depending on the day.

---

## 3. Multiple growers per product

The same product spec often appears several times on one day from different
growers at different prices. **Jake is not brand-loyal — buying is cost-led.** So
every offer for a product spec is retained in an `offers[]` array (sorted
ascending), `best` is the cheapest, and comparison runs cheapest-against-cheapest.
Jake's instruction: compare all offers on the current list against the previous
day even if there was only one offer the previous day.

---

## 4. Country of origin

Jake wants to notify customers of seasonal changeovers — a product moving country
usually means a change in size, appearance and flavour worth telling chefs about.
A change is flagged when both days have non-empty origin sets for a product and
the sets differ. There's a "Copy a customer note" button on the origin section of
the Changes tab producing plain text for pasting into an email.

---

## 5. Architecture

Split into `index.html` / `app.js` / `style.css`, same convention as
`canvassing-tool` and `staff-holiday-tracker`. Styling uses the shared KML design
tokens (`--forest` / `--chartreuse` / `--sage` / `--charcoal` / `--cream`, the
gradient topbar with the chartreuse logo-mark, `.btn-primary` / `.btn-outline`,
`.stat-card`, `.pill`, `.alert`) — see those two projects' `style.css` for the
canonical token set if it ever needs to change everywhere at once.

**Storage:** Firestore (`days/{date}` documents) is the source of truth when
signed in; a `localStorage` copy is kept as an offline/instant-load cache, same
pattern as `canvassing-tool`. Unlike the first prototype, **the raw parsed rows
are stored, not just the grouped output** (`groupItems()` re-derives groups from
the raw rows on every read, in `dayOf()`). This means future changes to the
grouping/derivation logic apply retroactively to already-imported days without
needing the original `.xls` files re-dropped in — this was the first
prototype's biggest known limitation, and storing raw rows fixes it structurally.

**Auth:** shared-passcode login via Firebase Auth (`SHARED_LOGIN_EMAIL` constant
in `app.js`), same UI pattern as `canvassing-tool`'s login overlay.

**Firebase setup status:** `FIREBASE_CONFIGURED` in `app.js` is `false` until a
real Firebase project exists. Until then the app runs fully functional in
local-only mode (localStorage only, no login gate, "Local only" shown in the
topbar). To turn on sync:

1. Create a new Firebase project (Firebase console, e.g. named `kml-price-watch`).
2. Enable **Firestore** (production mode) and **Authentication → Email/Password**.
3. In Authentication, add one user with the same email as `canvassing-tool` uses
   (`jacob@kmlfoodservice.internal`) and a passcode of your choice.
4. Copy the web app's `firebaseConfig` object from Project Settings into the
   `firebaseConfig` constant at the top of `app.js`, and flip
   `FIREBASE_CONFIGURED` to `true`.
5. Firestore security rules should require `request.auth != null` for read/write
   on `days/{date}`, matching the `overrides` collection rules already in use on
   the `canvassing-tool` Firebase project.

**Hosting:** not yet pushed anywhere — currently local files only. To host on
GitHub Pages like `canvassing-tool`: `git init`, create a GitHub repo (private is
fine — Firestore data isn't in the repo, only code), push, enable Pages on the
`main` branch. Once Firebase is configured, the `firebaseConfig` values are safe
to publish (they're client identifiers, not secrets — access is controlled by
Firestore security rules and the Auth passcode, not by hiding the config).

---

## 6. What exists, what doesn't

**Built:** drag-and-drop import, comparison of any two stored days, movement
banded by magnitude (Major 20%+ / Significant 10–20% / Moderate 5–10% / Minor
2–5% / Negligible under 2%, collapsible, top three open by default), sort within
band, new-to-list / no-longer-listed sections, origin change section with
customer-note export, CSV and plain-text export, JSON backup/restore (now also
pushes restored days to Firestore, not just local storage), storage-unavailable
detection.

**Deliberately not built:** any matching against Jake's own Orderlion product
list (an earlier attempt reached only ~60% automatic match; Jake reviews changes
and updates Orderlion by hand — don't reintroduce this without asking). No
pricing groups / markup rules. No Orderlion API integration.

**Known gaps worth considering:**
- Only the first worksheet is read.
- **No multi-day trend view** — a product climbing 5% daily for a week reads as
  five separate minor changes, never one major one. Probably the highest-value
  addition, and now easier than before since raw rows for every day are kept.
- Origin history isn't queryable beyond a two-day comparison.
- No handling for a second supplier.
- No login/access separate from the single shared passcode — fine for one
  person, would need real per-user accounts if more people use it.

---

## 7. Context on how Jake works

New to coding but builds real tools and iterates fast. Prefers being told plainly
when something is wrong with an approach rather than being agreed with. The
business runs 03:00–14:00; this tool gets used early, under time pressure, to
decide what to reprice. Concise output beats comprehensive output.
