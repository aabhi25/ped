// PDF text-replacement engine built on MuPDF (WASM).
// Old text is deleted from the page's content stream via redaction, then the
// new text is written at the same baseline in the same font, size and colour.
// Words that did not change are left exactly as they were.
import CATALOG from "./catalog.js";

const BASE14 = {
	sans: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
	serif: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
	mono: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
};
// Longest alias first so "robotomono" wins over "roboto".
const ALIASES = [];
for (const [family, def] of Object.entries(CATALOG)) for (const a of def.aliases) ALIASES.push([a, family]);
ALIASES.sort((a, b) => b[0].length - a[0].length);

const WEIGHTS = [
	[/thin|hairline/, 100], [/extralight|ultralight/, 200], [/semibold|demibold|demi/, 600],
	[/extrabold|ultrabold/, 800], [/black|heavy/, 900], [/light/, 300], [/medium/, 500], [/bold/, 700],
];

function cleanName(name) {
	return String(name || "").replace(/^[A-Z]{6}\+/, "");
}

function describeFont(font, nameOverride) {
	const raw = cleanName(nameOverride || font.getName());
	const n = raw.toLowerCase().replace(/[\s_-]/g, "");
	let weight = 0;
	for (const [re, w] of WEIGHTS) if (re.test(n)) { weight = w; break; }
	if (!weight) weight = font.isBold() ? 700 : 400;
	const italic = font.isItalic() || /italic|oblique/.test(n);
	let family = null;
	for (const [alias, fam] of ALIASES) {
		if (!n.includes(alias)) continue;
		if (alias === "lato" && n.includes("palatino")) continue;
		if (alias === "inter" && !/^inter(?!state|national|face)/.test(n)) continue;
		family = fam; break;
	}
	let generic;
	if (family) generic = CATALOG[family].generic;
	else if (/courier|consolas|mono|menlo/.test(n)) generic = "mono";
	else if (/times|georgia|garamond|tinos|minion|palatino|bookman|century/.test(n) || (/serif/.test(n) && !/sans/.test(n))) generic = "serif";
	else if (/arial|helvetica|sans|arimo|verdana|tahoma|segoe/.test(n)) generic = "sans";
	else if (font.isMono()) generic = "mono";
	else if (font.isSerif()) generic = "serif";
	else generic = "sans";
	const bold = weight >= 600;
	return { name: raw, fullName: nameOverride || font.getName(), family, generic, weight, bold, italic, variant: (bold ? 1 : 0) + (italic ? 2 : 0) };
}

// Closest available file of a bundled family for a weight/slant.
function catalogFile(family, weight, italic) {
	const files = CATALOG[family] && CATALOG[family].files;
	if (!files) return null;
	let best = null, bestScore = Infinity;
	for (const key of Object.keys(files)) {
		const w = parseInt(key, 10), it = key.endsWith("i");
		const score = Math.abs(w - weight) + (it === italic ? 0 : 1000);
		if (score < bestScore) { bestScore = score; best = family + "/" + key; }
	}
	return best;
}

function invert(m) {
	const det = m[0] * m[3] - m[1] * m[2];
	const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
	return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}
const num = (v) => {
	const s = (Math.round(v * 10000) / 10000).toString();
	return s === "-0" ? "0" : s;
};
const hex4 = (n) => n.toString(16).padStart(4, "0");
const isSpace = (c) => c === " " || c === " " || c === "\t";

export function createEngine(mupdf, loadFontFile) {
	let doc = null;
	let fontSeq = 0;
	let pdfFontCache = new Map(); // key -> { ref, uni: Map(gid -> string) }
	let glyphMaps = null, glyphByName = null;
	let t3ById = new Map(), t3ByName = new Map(), t3Pages = new Map();
	const fontObjects = new Map(); // bundled / standard font name -> mupdf.Font
	let customFont = null;
	const unusable = new Set(); // embedded fonts that cannot take new text

	function open(bytes) {
		const d = mupdf.Document.openDocument(bytes, "application/pdf");
		if (!(d instanceof mupdf.PDFDocument)) throw new Error("That file is not a PDF.");
		if (d.needsPassword()) throw new Error("This PDF is password-protected. Remove the password first.");
		doc = d;
		pdfFontCache = new Map();
		glyphMaps = null;
	}

	function pageCount() { return doc.countPages(); }

	function pageSize(i) {
		const b = doc.loadPage(i).getBounds();
		return { width: b[2] - b[0], height: b[3] - b[1], x0: b[0], y0: b[1] };
	}

	function render(i, scale) {
		const page = doc.loadPage(i);
		const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
		const w = pix.getWidth(), h = pix.getHeight();
		const src = pix.getPixels();
		const out = new Uint8ClampedArray(w * h * 4);
		for (let s = 0, d = 0; s < src.length; s += 3, d += 4) {
			out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = 255;
		}
		pix.destroy();
		return { width: w, height: h, pixels: out };
	}

	// Which glyph the document itself uses for each character, per embedded font.
	// Embedded fonts are usually subsets with no usable lookup table of their own,
	// so the pages are the reliable source.
	function parseToUnicode(text) {
		const map = new Map();
		const dec = (h) => { let o = ""; for (let k = 0; k + 4 <= h.length; k += 4) o += String.fromCharCode(parseInt(h.slice(k, k + 4), 16)); return o; };
		for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
			for (const q of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(q[1], 16), dec(q[2]));
		for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
			for (const q of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
				const lo = parseInt(q[1], 16), hi = parseInt(q[2], 16);
				if (hi - lo > 4096) continue;
				if (q[3]) { const base = parseInt(q[3], 16); for (let c = lo; c <= hi; c++) map.set(c, String.fromCodePoint(base + c - lo)); }
				else { const items = [...q[4].matchAll(/<([0-9a-fA-F]+)>/g)]; for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, dec(items[c - lo][1])); }
			}
		}
		return map;
	}

	// Type 3 fonts (how Chrome stores many web fonts): each glyph is a drawing kept
	// in the page's own font resource. New text can point at those same drawings.
	function indexType3(pageIndex, pageObj) {
		const list = [];
		let res;
		try { res = pageObj.getInheritable("Resources"); } catch { return list; }
		if (!res || res.isNull()) return list;
		const fd = res.get("Font");
		if (!fd || fd.isNull() || !fd.isDictionary()) return list;
		fd.forEach((v) => {
			try {
				const o = v.resolve();
				const sub = o.get("Subtype");
				if (!sub || sub.isNull() || sub.asName() !== "Type3") return;
				const id = v.isIndirect() ? v.asIndirect() : -(++fontSeq);
				let r = t3ById.get(id);
				if (!r) {
					const fdsc = o.get("FontDescriptor");
					let name = "";
					if (fdsc && !fdsc.isNull()) { const fn = fdsc.resolve().get("FontName"); if (fn && !fn.isNull()) name = fn.asName(); }
					const tu = o.get("ToUnicode");
					if (!tu || tu.isNull()) return;
					const toUni = parseToUnicode(tu.readStream().asString());
					const fm = o.get("FontMatrix"), w = o.get("Widths");
					const widths = [];
					for (let k = 0; k < w.length; k++) widths.push(w.get(k).asNumber());
					r = { id, ref: v, name: name || "Type3-" + id, toUni, widths, first: o.get("FirstChar").asNumber(), a: Math.abs(fm.get(0).asNumber()) };
					t3ById.set(id, r);
					let byChar = t3ByName.get(r.name);
					if (!byChar) { byChar = new Map(); t3ByName.set(r.name, byChar); }
					for (const [code, str] of toUni) {
						const wd = widths[code - r.first];
						if (wd !== undefined && !byChar.has(str)) byChar.set(str, { res: r, code, adv: wd * r.a });
					}
				}
				list.push(r);
			} catch { /* skip this font */ }
		});
		return list;
	}

	// Which glyph the document itself uses for each character, per embedded font.
	// Embedded fonts are usually subsets with no usable lookup table of their own,
	// so the pages are the reliable source.
	function buildGlyphMaps() {
		glyphMaps = new Map(); // font pointer -> { name, map, clash, cmapOk }
		t3ById = new Map(); t3ByName = new Map(); t3Pages = new Map();
		const walker = {
			showGlyph(font, trm, gid, uni) {
				if (!font || gid < 0 || uni <= 0 || uni === 0xfffd || uni === 32) return;
				let e = glyphMaps.get(font.pointer);
				if (!e) { e = { font, name: font.getName(), map: new Map(), clash: new Set() }; glyphMaps.set(font.pointer, e); }
				const prev = e.map.get(uni);
				if (prev === undefined) e.map.set(uni, gid);
				else if (prev !== gid) e.clash.add(uni);
			},
		};
		const onText = (text) => { try { text.walk(walker); } catch { /* skip */ } };
		const dev = new mupdf.Device({ fillText: onText, strokeText: onText, clipText: onText, clipStrokeText: onText, ignoreText: onText });
		const n = Math.min(doc.countPages(), 400);
		for (let i = 0; i < n; i++) {
			try {
				const page = doc.loadPage(i);
				t3Pages.set(i, indexType3(i, page.getObject()));
				page.run(dev, mupdf.Matrix.identity);
			} catch { /* skip page */ }
		}
		try { dev.close(); } catch { /* fine */ }
		const nameCount = new Map();
		for (const e of glyphMaps.values()) nameCount.set(e.name, (nameCount.get(e.name) || 0) + 1);
		glyphByName = new Map();
		for (const e of glyphMaps.values()) {
			for (const u of e.clash) e.map.delete(u); // ambiguous (e.g. ligature parts)
			// Is the font's own lookup table trustworthy? Compare it against real usage.
			let agree = 0, total = 0;
			for (const [u, g] of e.map) { total++; try { if (e.font.encodeCharacter(u) === g) agree++; } catch { /* no */ } if (total >= 60) break; }
			e.cmapOk = total >= 3 && agree === total;
			if (nameCount.get(e.name) === 1) glyphByName.set(e.name, e);
		}
		matchType3();
	}

	// Pair each Type 3 text font with its page resource by comparing character
	// codes and advance widths, then record which resource draws which character.
	function matchType3() {
		const all = [...t3ById.values()];
		if (!all.length) return;
		for (const e of glyphMaps.values()) {
			if (!/T3$|Type3/i.test(e.name) || !e.map.size) continue;
			let best = null, bestHits = 0;
			for (const r of all) {
				let hits = 0, ok = true;
				for (const [u, code] of e.map) {
					const wd = r.widths[code - r.first];
					let adv = -1;
					try { adv = e.font.advanceGlyph(code, 0); } catch { /* unknown */ }
					if (wd === undefined || (adv >= 0 && Math.abs(adv - wd * r.a) > 2e-3)) { ok = false; break; }
					if (r.toUni.get(code) === String.fromCodePoint(u)) hits++;
				}
				if (ok && (hits > bestHits || (!best && hits === 0))) { best = r; bestHits = hits; }
			}
			if (!best) continue;
			e.t3 = best.name;
			const byChar = t3ByName.get(best.name);
			// The characters as the text extractor reads them take priority over the font's own table.
			for (const [u, code] of e.map) byChar.set(String.fromCodePoint(u), { res: best, code, adv: best.widths[code - best.first] * best.a });
		}
	}

	function type3NameFor(font) {
		if (!glyphMaps) buildGlyphMaps();
		const e = glyphMaps.get(font.pointer);
		return e && e.t3 ? e.t3 : null;
	}

	function origGlyph(f, cp) {
		if (!glyphMaps) buildGlyphMaps();
		const e = glyphMaps.get(f.font.pointer) || glyphByName.get(f.font.getName());
		if (e) {
			const g = e.map.get(cp);
			if (g) return g;
			if (!e.cmapOk) return 0;
		}
		try { return f.font.encodeCharacter(cp) || 0; } catch { return 0; }
	}

	const proj = (line, x, y) => (x - line.ox) * line.dir[0] + (y - line.oy) * line.dir[1];

	// Editable pieces of text. A visual line is split where there is a wide gap,
	// so table columns and "label    value" rows are edited independently.
	function lines(i) {
		const page = doc.loadPage(i);
		const st = page.toStructuredText("preserve-whitespace");
		const fonts = new Map();
		// True fill colour of every glyph, straight from the drawing commands.
		const colours = new Map();
		const ckey = (x, y) => Math.round(x * 5) + "," + Math.round(y * 5);
		try {
			const put = (text, ctm, col) => {
				if (![1, 3, 4].includes(col.length)) return;
				text.walk({ showGlyph(font, trm) { colours.set(ckey(trm[4] * ctm[0] + trm[5] * ctm[2] + ctm[4], trm[4] * ctm[1] + trm[5] * ctm[3] + ctm[5]), col); } });
			};
			// Type 3 glyphs arrive as filled shapes followed by an "ignore" notice, so remember the last fill.
			let lastFill = null;
			const dev = new mupdf.Device({
				fillPath(path, evenOdd, ctm, cs, color) { lastFill = Array.from(color || []); },
				fillText(text, ctm, cs, color) { put(text, ctm, Array.from(color || [])); },
				ignoreText(text, ctm) { if (lastFill) put(text, ctm, lastFill); },
			});
			page.run(dev, mupdf.Matrix.identity);
			try { dev.close(); } catch { /* fine */ }
		} catch { /* fall back to extracted colours */ }
		const out = [];
		let cur = null;
		const flush = (chars, dir, wmode) => {
			while (chars.length && isSpace(chars[chars.length - 1].c)) chars.pop();
			while (chars.length && isSpace(chars[0].c)) chars.shift();
			if (!chars.length || wmode !== 0) return;
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (const ch of chars) for (let k = 0; k < 8; k += 2) {
				x0 = Math.min(x0, ch.quad[k]); x1 = Math.max(x1, ch.quad[k]);
				y0 = Math.min(y0, ch.quad[k + 1]); y1 = Math.max(y1, ch.quad[k + 1]);
			}
			const first = chars[0];
			out.push({
				bbox: [x0, y0, x1, y1], dir, chars, text: chars.map((c) => c.c).join(""),
				ox: first.origin[0], oy: first.origin[1],
				size: first.size, fontName: first.f.info.name, info: first.f.info,
			});
		};
		st.walk({
			beginLine(bbox, wmode, dir) { cur = { wmode, dir, chars: [] }; },
			onChar(c, origin, font, size, quad, color) {
				let f = fonts.get(font.pointer);
				if (!f) {
					f = { font, info: describeFont(font) };
					if (/T3$|Type3/i.test(f.info.name)) {
						const t3 = type3NameFor(font);
						if (t3) { f.t3 = t3; f.info = describeFont(font, t3); }
					}
					fonts.set(font.pointer, f);
				}
				cur.chars.push({ c, origin, f, size, color: colours.get(ckey(origin[0], origin[1])) || color, quad });
			},
			endLine() {
				const { chars, dir, wmode } = cur;
				let seg = [], lastInk = null;
				for (const ch of chars) {
					if (!isSpace(ch.c) && lastInk) {
						// distance from the right edge of the previous glyph to this glyph
						const gap = (ch.origin[0] - lastInk.quad[2]) * dir[0] + (ch.origin[1] - lastInk.quad[3]) * dir[1];
						if (gap > Math.max(ch.size, lastInk.size) * 1.1) { flush(seg, dir, wmode); seg = []; }
					}
					seg.push(ch);
					if (!isSpace(ch.c)) lastInk = ch;
				}
				flush(seg, dir, wmode);
				cur = null;
			},
		});
		return mergeSegments(out);
	}

	// Text rewritten by an earlier edit sits in a separate drawing block, so the
	// extractor reports it apart from the untouched words before it. Join pieces
	// that share a baseline and sit a normal word gap apart.
	function mergeSegments(segs) {
		const endOf = (s) => { const c = s.chars[s.chars.length - 1]; return [c.quad[2], c.origin[1] + (c.quad[2] - c.origin[0]) * (s.dir[1] / (s.dir[0] || 1))]; };
		let merged = true;
		while (merged) {
			merged = false;
			outer: for (let a = 0; a < segs.length; a++) {
				for (let b = 0; b < segs.length; b++) {
					if (a === b) continue;
					const A = segs[a], B = segs[b];
					if (Math.abs(A.dir[0] - B.dir[0]) > 1e-3 || Math.abs(A.dir[1] - B.dir[1]) > 1e-3) continue;
					const end = endOf(A), st = B.chars[0].origin;
					const along = (st[0] - end[0]) * A.dir[0] + (st[1] - end[1]) * A.dir[1];
					const across = Math.abs(-(st[0] - end[0]) * A.dir[1] + (st[1] - end[1]) * A.dir[0]);
					const size = Math.max(A.chars[A.chars.length - 1].size, B.chars[0].size);
					if (across > size * 0.08 || along < -size * 0.1 || along > size * 1.1) continue;
					const last = A.chars[A.chars.length - 1];
					if (along > size * 0.12) A.chars.push({ c: " ", origin: end, f: last.f, size: last.size, color: last.color, quad: [end[0], end[1], end[0], end[1], end[0], end[1], end[0], end[1]] });
					A.chars.push(...B.chars);
					A.text = A.chars.map((c) => c.c).join("");
					A.bbox = [Math.min(A.bbox[0], B.bbox[0]), Math.min(A.bbox[1], B.bbox[1]), Math.max(A.bbox[2], B.bbox[2]), Math.max(A.bbox[3], B.bbox[3])];
					segs.splice(b, 1);
					merged = true;
					break outer;
				}
			}
		}
		return segs;
	}

	async function getFontObject(name) {
		if (fontObjects.has(name)) return fontObjects.get(name);
		let font = null;
		try {
			if (/^(Helvetica|Times|Courier)/.test(name)) font = new mupdf.Font(name);
			else {
				const data = await loadFontFile(name);
				if (data) font = new mupdf.Font(name, data);
			}
		} catch { font = null; }
		fontObjects.set(name, font);
		return font;
	}

	// Fonts to try, in order, when the document's own font cannot draw a word.
	function substituteNames(info, mode) {
		const names = [];
		const forced = mode === "sans" || mode === "serif" || mode === "mono" ? mode : null;
		if (!forced && info.family) names.push(catalogFile(info.family, info.weight, info.italic));
		const generic = forced || info.generic;
		names.push(BASE14[generic][info.variant]);
		names.push(catalogFile(generic === "serif" ? "liberation-serif" : generic === "mono" ? "liberation-mono" : "liberation-sans", info.weight, info.italic));
		names.push(catalogFile("noto-sans", info.weight, info.italic));
		return names.filter(Boolean);
	}

	const encodeAll = (font, word) => {
		const gids = [];
		for (const ch of word) { const g = font.encodeCharacter(ch.codePointAt(0)); if (!g) return null; gids.push(g); }
		return gids;
	};

	// Decide font + glyph ids for one word in the style of original font f.
	async function resolveWord(f, word, mode) {
		if (mode === "custom" && customFont) {
			const gids = encodeAll(customFont.font, word);
			if (gids) return { key: "custom:" + customFont.name, font: customFont.font, label: customFont.name, exact: false, gids };
		}
		if ((mode === "auto" || mode === "custom") && f.t3) {
			const byChar = t3ByName.get(f.t3);
			const parts = [];
			for (const ch of word) { const hit = byChar && byChar.get(ch); if (!hit) { parts.length = 0; break; } parts.push(hit); }
			if (parts.length) return { key: "t3:" + f.t3, t3: true, label: f.info.name, exact: true, parts };
		} else if ((mode === "auto" || mode === "custom") && !unusable.has(f.info.fullName)) {
			const gids = [];
			for (const ch of word) { const g = origGlyph(f, ch.codePointAt(0)); if (!g) { gids.length = 0; break; } gids.push(g); }
			if (gids.length) return { key: "orig:" + f.info.fullName, font: f.font, label: f.info.name, exact: true, gids };
		}
		for (const name of substituteNames(f.info, mode)) {
			const font = await getFontObject(name);
			if (!font) continue;
			const gids = encodeAll(font, word);
			if (gids) return { key: "std:" + name, font, label: name.replace("/", " "), exact: false, gids,
				matched: !!f.info.family && mode !== "sans" && mode !== "serif" && mode !== "mono" && name.startsWith(f.info.family + "/") };
		}
		return null;
	}

	function writeToUnicode(entry) {
		const pairs = [...entry.uni.entries()].sort((a, b) => a[0] - b[0]);
		let body = "";
		for (let k = 0; k < pairs.length; k += 100) {
			const chunk = pairs.slice(k, k + 100);
			body += `${chunk.length} beginbfchar\n`;
			for (const [gid, str] of chunk) {
				let u = "";
				for (let q = 0; q < str.length; q++) u += hex4(str.charCodeAt(q));
				body += `<${hex4(gid)}> <${u}>\n`;
			}
			body += "endbfchar\n";
		}
		const cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
			"/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" + body +
			"endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
		entry.ref.put("ToUnicode", doc.addStream(cmap, {}));
	}

	function pdfFontEntry(choice) {
		let entry = pdfFontCache.get(choice.key);
		if (!entry) {
			entry = { ref: doc.addFont(choice.font), uni: new Map(), names: new Map() };
			pdfFontCache.set(choice.key, entry);
		}
		return entry;
	}

	function pageFontName(page, entry, pageIndex) {
		if (entry.names.has(pageIndex)) return entry.names.get(pageIndex);
		const pageObj = page.getObject();
		let res = pageObj.get("Resources");
		if (!res || res.isNull()) {
			res = pageObj.getInheritable("Resources");
			if (!res || res.isNull()) res = doc.newDictionary();
			pageObj.put("Resources", res);
		}
		let fd = res.get("Font");
		if (!fd || fd.isNull()) { fd = doc.newDictionary(); res.put("Font", fd); }
		const name = "PxEd" + (++fontSeq);
		fd.put(name, entry.ref);
		entry.names.set(pageIndex, name);
		return name;
	}

	// Style for each new character: unchanged characters keep their own style;
	// typed characters take the style of what they replace, or of the text before.
	function restyle(oldChars, newChars, fallback) {
		const a = oldChars.map((c) => c.c), b = newChars;
		const n = a.length, m = b.length;
		if (!n) return b.map((c) => ({ c, f: fallback.f, size: fallback.size, color: fallback.color }));
		const W = m + 1;
		const t = new Uint16Array((n + 1) * W);
		for (let i = n - 1; i >= 0; i--)
			for (let j = m - 1; j >= 0; j--)
				t[i * W + j] = a[i] === b[j] ? t[(i + 1) * W + j + 1] + 1 : Math.max(t[(i + 1) * W + j], t[i * W + j + 1]);
		const src = new Array(m).fill(null);
		let i = 0, j = 0, gapOld = 0, gapNew = 0;
		const closeGap = () => {
			for (let k = gapNew; k < j; k++) {
				if (i > gapOld) src[k] = oldChars[Math.min(gapOld + (k - gapNew), i - 1)];
				else src[k] = k > 0 ? src[k - 1] : oldChars[Math.min(i, n - 1)];
			}
		};
		while (i < n && j < m) {
			if (a[i] === b[j]) { closeGap(); src[j] = oldChars[i]; i++; j++; gapOld = i; gapNew = j; }
			else if (t[(i + 1) * W + j] >= t[i * W + j + 1]) i++;
			else j++;
		}
		i = n; j = m; closeGap();
		return b.map((c, k) => ({ c, f: src[k].f, size: src[k].size, color: src[k].color }));
	}

	// Average width of a word space as the original line set it (justified text differs from the font's own).
	function measuredSpace(line) {
		let total = 0, count = 0, prev = null, spaces = 0;
		for (const ch of line.chars) {
			if (isSpace(ch.c)) { spaces++; continue; }
			if (prev && spaces) {
				const gap = proj(line, ch.origin[0], ch.origin[1]) - proj(line, prev.quad[2], prev.quad[3]);
				if (gap > 0) { total += gap; count += spaces; }
			}
			prev = ch; spaces = 0;
		}
		return count ? total / count : 0;
	}

	// Replace one piece of text. opts: { fontMode: auto|sans|serif|mono|custom, align: left|center|right }
	async function replaceLine(pageIndex, line, newText, opts = {}) {
		const mode = opts.fontMode || "auto";
		const align = opts.align || "left";
		const old = line.chars;
		const nw = Array.from(newText.replace(/[\r\n\t]+/g, " ").replace(/\s+$/, ""));

		// Keep the unchanged start of the line as it is; rewrite from the first changed word.
		let p = 0;
		if (align === "left") {
			while (p < old.length && p < nw.length && old[p].c === nw[p]) p++;
			if (p === old.length && p === nw.length) return { fonts: [], exact: true, unchanged: true };
			while (p > 0 && !isSpace(old[p - 1].c)) p--;
		}
		const tailOld = old.slice(p);
		const styled = restyle(tailOld, nw.slice(p), old[old.length - 1]);

		// Split into words (same style) and spaces.
		const tokens = [];
		for (const ch of styled) {
			const last = tokens[tokens.length - 1];
			if (isSpace(ch.c)) {
				if (last && last.space) last.count++; else tokens.push({ space: true, count: 1, f: ch.f, size: ch.size });
			} else if (last && !last.space && last.f === ch.f && last.size === ch.size && String(last.color) === String(ch.color)) last.text += ch.c;
			else tokens.push({ space: false, text: ch.c, f: ch.f, size: ch.size, color: ch.color });
		}

		// Resolve every font before touching the document, so a failure changes nothing.
		const report = { fonts: [], exact: true, missing: [] };
		for (const tk of tokens) {
			if (tk.space) continue;
			tk.choice = await resolveWord(tk.f, tk.text, mode);
			if (tk.choice && tk.choice.exact && !tk.choice.t3) {
				// Some embedded fonts (drawn-outline "Type 3" fonts) cannot be reused for new text.
				try { pdfFontEntry(tk.choice); }
				catch { unusable.add(tk.f.info.fullName); tk.choice = await resolveWord(tk.f, tk.text, mode); }
			}
			if (!tk.choice) throw new Error(`No available font has every character in “${tk.text.slice(0, 30)}”. Add a font file that covers it.`);
			tk.width = 0;
			if (tk.choice.t3) for (const part of tk.choice.parts) tk.width += part.adv * tk.size;
			else for (const g of tk.choice.gids) tk.width += tk.choice.font.advanceGlyph(g, 0) * tk.size;
			if (!report.fonts.includes(tk.choice.label)) report.fonts.push(tk.choice.label);
			if (!tk.choice.exact) { report.exact = false; report.missing.push(tk.text); if (!tk.choice.matched) report.generic = true; }
		}

		const page = doc.loadPage(pageIndex);
		const [dx, dy] = line.dir;
		const dx0 = dx, dy0 = dy;

		// Where the rewritten part starts and how wide the old one was.
		const endCh = old[old.length - 1];
		const endAdv = proj(line, endCh.quad[2], endCh.quad[3]) - proj(line, endCh.origin[0], endCh.origin[1]);
		const start = tailOld.length ? tailOld[0].origin : [endCh.origin[0] + dx0 * endAdv, endCh.origin[1] + dy0 * endAdv];
		const lastOld = old[old.length - 1];
		const oldWidth = tailOld.length ? proj(line, lastOld.quad[2], lastOld.quad[3]) - proj(line, start[0], start[1]) : 0;

		// 1. Delete the old glyphs of the changed part from the content stream.
		if (tailOld.length) {
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (const ch of tailOld) {
				if (isSpace(ch.c)) continue;
				for (let k = 0; k < 8; k += 2) {
					x0 = Math.min(x0, ch.quad[k]); x1 = Math.max(x1, ch.quad[k]);
					y0 = Math.min(y0, ch.quad[k + 1]); y1 = Math.max(y1, ch.quad[k + 1]);
				}
			}
			if (x0 < x1) {
				const horizontal = Math.abs(dy) < 1e-3;
				const insetY = horizontal ? (y1 - y0) * 0.2 : 0;
				const annot = page.createAnnotation("Redact");
				annot.setRect([x0 - 0.3, y0 + insetY, x1 + 0.5, y1 - insetY]);
				page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
			}
		}
		if (!tokens.some((t) => !t.space)) return report;

		// 2. Lay the new words out along the original baseline.
		const origSpace = measuredSpace(line);
		const fontSpace = (tk) => {
			if (!tk || tk.space) return 0;
			const c = tk.choice;
			if (c.t3) { const hit = t3ByName.get(tk.f.t3).get(" "); return hit ? hit.adv * tk.size : 0; }
			const g = c.exact ? origGlyph(tk.f, 32) : c.font.encodeCharacter(32);
			return g ? c.font.advanceGlyph(g, 0) * tk.size : 0;
		};
		let width = 0;
		tokens.forEach((tk, k) => {
			if (!tk.space) { width += tk.width; return; }
			const w = origSpace || fontSpace(tokens[k - 1]) || fontSpace(tokens[k + 1]) || tk.size * 0.27;
			tk.width = w * tk.count;
			width += tk.width;
		});
		let shift = 0;
		if (align === "right") shift = oldWidth - width;
		else if (align === "center") shift = (oldWidth - width) / 2;
		let px = start[0] + dx * shift, py = start[1] + dy * shift;

		const inv = invert(page.getTransform());
		let ops = "q\n" + inv.map(num).join(" ") + " cm\nBT\n";
		const touched = new Set();
		for (const tk of tokens) {
			if (!tk.space) {
				const col = tk.color && [1, 3, 4].includes(tk.color.length) ? tk.color : [0];
				ops += col.map(num).join(" ") + (col.length === 1 ? " g\n" : col.length === 3 ? " rg\n" : " k\n");
				const tm = `${num(dx)} ${num(dy)} ${num(dy)} ${num(-dx)} ${num(px)} ${num(py)} Tm\n`;
				if (tk.choice.t3) {
					// Point at the page's existing glyph drawings, one resource at a time.
					let k = 0, firstRun = true;
					while (k < tk.choice.parts.length) {
						const res = tk.choice.parts[k].res;
						let hex = "";
						while (k < tk.choice.parts.length && tk.choice.parts[k].res === res) hex += tk.choice.parts[k++].code.toString(16).padStart(2, "0");
						let entry = pdfFontCache.get("t3res:" + res.id);
						if (!entry) { entry = { ref: res.ref, uni: new Map(), names: new Map() }; pdfFontCache.set("t3res:" + res.id, entry); }
						ops += `/${pageFontName(page, entry, pageIndex)} ${num(tk.size)} Tf\n` + (firstRun ? tm : "") + `<${hex}> Tj\n`;
						firstRun = false;
					}
				} else {
					const entry = pdfFontEntry(tk.choice);
					const fname = pageFontName(page, entry, pageIndex);
					const chars = Array.from(tk.text);
					tk.choice.gids.forEach((g, k) => { if (!entry.uni.has(g)) { entry.uni.set(g, chars[k]); touched.add(entry); } });
					ops += `/${fname} ${num(tk.size)} Tf\n` + tm + "<" + tk.choice.gids.map(hex4).join("") + "> Tj\n";
				}
			}
			px += dx * tk.width; py += dy * tk.width;
		}
		ops += "ET\nQ\n";
		for (const entry of touched) writeToUnicode(entry);

		// 3. Append as a new content stream, isolating whatever state the page left behind.
		const pageObj = page.getObject();
		const contents = pageObj.get("Contents");
		const arr = doc.newArray();
		arr.push(doc.addStream("q\n", {}));
		if (contents && !contents.isNull()) {
			if (contents.isArray()) for (let k = 0; k < contents.length; k++) arr.push(contents.get(k));
			else arr.push(contents);
		}
		arr.push(doc.addStream("\nQ\n" + ops, {}));
		pageObj.put("Contents", arr);
		return report;
	}

	// Name of the bundled font file that best matches a line, for on-screen preview while typing.
	function previewFontName(line) {
		return line.info.family ? catalogFile(line.info.family, line.info.weight, line.info.italic) : null;
	}

	// Full rewrite: drops unreferenced objects and earlier revisions of the file.
	function snapshot() {
		const buf = doc.saveToBuffer("garbage=4,compress=yes");
		const bytes = buf.asUint8Array().slice();
		buf.destroy();
		return bytes;
	}

	// Final file: same rewrite, done on a copy so fonts can be trimmed to the glyphs used.
	function save() {
		const bytes = snapshot();
		try {
			const copy = mupdf.Document.openDocument(bytes, "application/pdf");
			copy.subsetFonts();
			const buf = copy.saveToBuffer("garbage=4,compress=yes");
			const out = buf.asUint8Array().slice();
			buf.destroy(); copy.destroy();
			return out.length < bytes.length ? out : bytes;
		} catch { return bytes; }
	}

	const META_KEYS = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"];

	function getMetadata() {
		const out = {};
		const info = doc.getTrailer().get("Info");
		for (const k of META_KEYS) {
			let v = "";
			try { if (info && info.isDictionary()) { const o = info.get(k); if (o && !o.isNull()) v = o.asString(); } } catch { v = ""; }
			out[k] = v;
		}
		const ver = doc.getVersion();
		return { fields: out, pages: doc.countPages(), version: Math.floor(ver / 10) + "." + (ver % 10) };
	}

	// Writes the given fields; an empty value removes the entry. The embedded XMP
	// copy of the properties is dropped so it cannot contradict the new values.
	function setMetadata(fields) {
		const trailer = doc.getTrailer();
		let info = trailer.get("Info");
		if (!info || !info.isDictionary()) {
			info = doc.addObject(doc.newDictionary());
			trailer.put("Info", info);
		}
		for (const k of META_KEYS) {
			if (!(k in fields)) continue;
			const v = String(fields[k] ?? "").trim();
			if (v) info.put(k, doc.newString(v)); else info.delete(k);
		}
		const root = trailer.get("Root");
		try { const m = root.get("Metadata"); if (m && !m.isNull()) root.delete("Metadata"); } catch { /* none */ }
	}

	function setCustomFont(name, bytes) {
		const font = new mupdf.Font(name, bytes);
		customFont = { name, font };
	}
	function clearCustomFont() { customFont = null; }

	return { open, pageCount, pageSize, render, lines, replaceLine, previewFontName, save, snapshot, getMetadata, setMetadata, setCustomFont, clearCustomFont, hasCustomFont: () => !!customFont };
}
