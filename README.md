# PDF Text Swap

A browser-based PDF text editor. Click any text on a page to replace it in the same font, size and colour, and view or change the document's properties (title, author, dates). Everything runs locally in the browser; files are never uploaded.

## Run it

Serve this folder with any static web server, then open `index.html`. For example:

```bash
python3 -m http.server 8000
```

Then visit http://localhost:8000. Opening `index.html` directly from disk will not work, because browsers block it from loading its own scripts and fonts.

## Files

- `index.html` – the page: toolbar, editing box, properties panel
- `engine.js` – finds text, removes the old text and writes the new text
- `catalog.js`, `fontpacks/` – built-in open-licence fonts used when a character is missing from the document
- `mupdf.js`, `mupdf-wasm.js`, `mupdf-wasm.wasm` – the MuPDF library (AGPL-3.0) that reads and writes PDFs
- `sample.pdf` – the example page shown on first load

## Licences

MuPDF is licensed under AGPL-3.0. The bundled fonts are under the SIL Open Font License or the fonts' own open licences (Liberation, Carlito, Caladea and Google Fonts families).
