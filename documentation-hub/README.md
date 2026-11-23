# Documentation Hub (MyGeotab add-in)

A MyGeotab add-in that shows a reseller's own documents (an onboarding PDF and a searchable FAQ)
inside MyGeotab, in English or French. **The documents are not part of the add-in.** They are loaded
at runtime from the `content/` folder, so whoever owns the content can change it without
rebuilding or reinstalling anything.

Status: prototype with sample content.

## How it works

```
documentation-hub/
  dist/       the built add-in (what MyGeotab loads)
  content/    the documents, edited by the content owner
    manifest.json     list of documents and their files per language
    en/  fr/          one folder per language
  src/        add-in source (React)
  dev/        local test page that fakes the MyGeotab api
  config.json the add-in configuration pasted into MyGeotab
```

The add-in fetches `content/manifest.json`, picks a language, and shows the document list on the
left and the selected document on the right.

### Language
Order of preference: the user's last manual choice (EN/FR buttons), then the language on their
MyGeotab user record, then the browser language, then the manifest's default. If a document has no file in
the chosen language, the default-language file is shown with a short notice.

### Document types
| `type` | File | Shown as |
|---|---|---|
| `pdf` | a `.pdf` | the browser's PDF viewer, with Open and Download links |
| `faq` | a `.json` | searchable question list (plain text answers) |

FAQ format:
```json
{ "sections": [ { "title": "Getting started", "items": [ { "q": "Question?", "a": "Answer.\n\nSecond paragraph." } ] } ] }
```

## Updating content (no rebuild needed)
1. Replace or add files under `content/en/` and `content/fr/`.
2. If you add a document, add an entry to `content/manifest.json`.
3. Publish. Users see the change on their next visit.

## Install in MyGeotab (test database)
1. Host this folder over HTTPS (for example GitHub Pages) so `dist/` and `content/` are public.
2. Check `config.json`: the `url` must point to the hosted `dist/` folder.
3. In MyGeotab: Administration > System > System Settings > Add-Ins. Make sure **Allow unverified Add-Ins** is Yes.
4. Select **New Add-In**, paste the contents of `config.json`, save, and refresh.
5. The menu item appears where `path` puts it (currently `GettingStartedLink/`, the Support menu). Other built-in menu IDs, such as `ActivityLink/`, work the same way.

## Build
```bash
npm install
npx vite build        # writes dist/
```
`vite.config.js` must keep the `define` for `process.env.NODE_ENV`, or the add-in fails to register.

## Test locally
```bash
python3 -m http.server 8123
# then open http://127.0.0.1:8123/dev/index.html?lang=fr
```
`?lang=fr` sets the fake user's language, `?open=faq` opens the FAQ, `?q=text` types in the search box.

## Still to verify in a real MyGeotab database
- The user record's `language` value format (the code accepts `en`, `fr`, `fr-CA` and similar).
- That the PDF viewer shows inside the add-in frame in each browser.
- Hosting requirements if content moves to another host: HTTPS, and no headers that block framing
  or cross-site loading of the files.
- Geotab's add-in guide says the absolute URL must not contain `-`, `@` or `#`. Hyphenated URLs
  already work for other add-ins, but test with the final host and repository name.
- Accessibility: built with labelled controls and keyboard focus styles, but not yet audited against WCAG 2.2 AA.
