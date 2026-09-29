import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readAppCss } from "./readAppCss";

// jsdom does not run a layout engine, so clientHeight / overflow cannot be
// measured here (see design.md § 8 risk). Instead we assert the CSS contract
// that *enforces* the layout: fixed header heights, a single scrollbar style,
// the two-column grid model, screen-gutter tokens, and the removed diet classes.
const css = readAppCss();

function rule(selector: string): string {
	// Grab the first `{ ... }` block whose selector LIST starts with this
	// selector. The `(?<!,)` guard is what keeps a shared rule out of the way:
	// `.main-header` is also the last line of the header-band selector list, and
	// without it `rule(".main-header")` would return the band block instead of
	// the screen header's own one.
	const re = new RegExp(
		`(^|(?<!,)\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
	);
	const m = css.match(re);
	return m ? m[2] : "";
}

// The one header band shared by the title strip, the navigator head and the
// screen header (App.css § The header band).
function bandRule(): string {
	const m = css.match(
		/\.app-topbar,\s*\.side-head,\s*\.main-header\s*\{([^}]*)\}/,
	);
	return m ? m[1] : "";
}

describe("screen layout contract (CSS)", () => {
	it("defines the screen-gutter tokens, density-aware", () => {
		expect(css).toMatch(/--pad-screen-x:\s*24px/);
		expect(css).toMatch(/--pad-screen-y:\s*16px/);
		expect(css).toMatch(
			/\[data-density="compact"\][^}]*--pad-screen-x:\s*20px/,
		);
		expect(css).toMatch(/\[data-density="cozy"\][^}]*--pad-screen-x:\s*28px/);
	});

	it("fixes the two header rows via density-aware tokens", () => {
		expect(bandRule()).toMatch(/height:\s*var\(--header-row-1\)/);
		// Both blocks: since `rule()` reads only an element's OWN declarations, a
		// `min-height` slipped into the shared band rule would otherwise pass.
		expect(bandRule() + rule(".main-header")).not.toMatch(/min-height/);
		expect(rule(".main-subheader")).toMatch(/height:\s*var\(--header-row-2\)/);
		expect(css).toMatch(/--header-row-1:\s*56px/);
		expect(css).toMatch(/--header-row-2:\s*40px/);
		expect(css).toMatch(/\[data-density="compact"\][^}]*--header-row-1:\s*52px/);
		expect(css).toMatch(/\[data-density="cozy"\][^}]*--header-row-1:\s*60px/);
	});

	it("fixes the identity column and the title block (no per-screen jump)", () => {
		// C1 — one 40px identity column, always rendered, so the title's
		// x-origin is identical on every route.
		expect(rule(".header-identity")).toMatch(/width:\s*40px/);
		expect(rule(".header-identity")).toMatch(/flex:\s*0 0 40px/);
		// the back button is sized to that frame (icon-only, no label to shed)
		expect(rule(".btn.back-button:not(:has(.btn-label))")).toMatch(/width:\s*40px/);
		expect(css).not.toMatch(/\.header-back \.btn-label/);
		// C2 — fixed 24 + 2 + 16 title block
		expect(rule(".main-title h2")).toMatch(/line-height:\s*24px/);
		expect(rule(".main-title h2")).toMatch(/height:\s*24px/);
		expect(rule(".main-title .crumbs")).toMatch(/height:\s*16px/);
		expect(rule(".main-title .crumbs")).toMatch(/line-height:\s*16px/);
	});

	it("gives the editors' row 2 the same band as .main-subheader", () => {
		// C3 — one row-2 band app-wide: same height token, gutter, surface.
		const bar = rule(".doc-editor-bar");
		expect(bar).toMatch(/min-height:\s*var\(--header-row-2\)/);
		// F3 — the block padding is on the BASE rule, not only the wrapped
		// state: `.doc-editor-bar-left` wraps on its own at any width, and a
		// wrapped second row with 0 block padding butts the hairline below.
		expect(bar).toMatch(/padding:\s*4px var\(--pad-screen-x\)/);
		expect(bar).toMatch(/background:\s*var\(--bg-0\)/);
	});

	it("tints the header with the route's section hue", () => {
		// C6 — the section gradient is the band's "where am I" signal.
		const band = bandRule();
		// The wash is the CHROME LAMP: one radial field shared by every chrome
		// piece, offset per cell via --lamp-x/--lamp-y so the glow is continuous
		// (no per-element restarts).
		expect(band).toMatch(
			/radial-gradient\(1000px 560px at var\(--lamp-x, 0px\) var\(--lamp-y, 0px\)/,
		);
		// The wash reads through --header-wash, whose FALLBACK is the plain
		// section token (declared in the same rule, so engines without
		// relative colour syntax still get a tinted header).
		expect(band).toMatch(
			/--header-wash:\s*var\(--section-lifted, var\(--section\)\)/,
		);
		expect(band).toMatch(
			/background:[\s\S]*color-mix\(in oklab, var\(--header-wash\) 14%/,
		);
		// …and the rail continues the SAME field, offset by the strip's height.
		expect(rule(".app-rail")).toMatch(
			/radial-gradient\(1000px 560px at 0 calc\(-1 \* var\(--topbar-h\)\)/,
		);
		// The contour reads the ROUTE's section, so it must be declared on `.app`
		// and never at :root — a custom property resolves its own var()s on the
		// element that declares it, and at :root that is always the DEFAULT
		// section (every group came out the same violet, measured 101,98,125).
		expect(css).toMatch(
			/\.app\s*\{\s*--chrome-edge:\s*color-mix\(in oklab, var\(--section-lifted, var\(--section\)\) 85%, transparent\)/,
		);
		// …and specifically NOT inside the :root token block (no nested braces
		// there, so `[^}]*` is an exact scope).
		expect(css).not.toMatch(/:root\s*\{[^}]*--chrome-edge:/);
		expect(css).not.toMatch(/:root\s*\{[^}]*--panel-backlight:/);
		// F8 — the chroma lift itself: ONE consolidated `--section-lifted`
		// declaration on .app (same derivation + same @supports guard shape as
		// the rail's live glint) feeds the wash, the rail wash and the
		// chrome-edge contour, so the five section hues are actually
		// distinguishable and the border follows the selection's accent.
		expect(css).toMatch(
			/@supports \(color: oklch\(from red l c h\)\)\s*\{\s*\.app\s*\{\s*--section-lifted:\s*oklch\(from var\(--section\)/,
		);
		// The glyph chip stays on the PLAIN token (18%). (Matched against the
		// whole sheet: `.header-glyph` also carries a one-line --live-accent
		// rule that `rule()` would grab first.)
		expect(css).toMatch(
			/\.header-glyph\s*\{[^}]*background:\s*color-mix\(in oklab, var\(--section\) 18%/,
		);
	});

	it("centres the header status cluster on the row, not the title line", () => {
		// The chips are a SIBLING of `.main-title`, so the header row's own
		// `align-items: center` lands them on the buttons' centre line instead
		// of ~9px above it (where the 24px title LINE inside the 42px title
		// BLOCK used to park them).
		const status = rule(".main-header .header-status");
		expect(status).toMatch(/display:\s*inline-flex/);
		expect(status).toMatch(/align-items:\s*center/);
		expect(status).toMatch(/flex:\s*0 1 auto/);
		expect(status).toMatch(/min-width:\s*0/);
		// The actions still park hard right, with the row gap between them.
		expect(rule(".main-header-right")).toMatch(/margin-left:\s*auto/);
	});

	it("lets the title state cluster shed instead of clipping (F2)", () => {
		// The state cluster must be allowed to size below its content so its
		// children can shed under the ladder; without min-width:0 it floors at
		// max-content and gets guillotined rather than shed.
		const state = rule(".main-header .header-status .title-state");
		expect(state).toMatch(/flex-shrink:\s*0/);
		expect(state).toMatch(/min-width:\s*0/);
		// Explicit shed rungs: ambient sync chip at --bp-compact, then the
		// health chip's WORD at --bp-stack (its tone dot + tooltip remain).
		expect(css).toMatch(
			/@container appmain \(max-width: 560px\)\s*\{[\s\S]*?\.title-state \.remote-syncing-chip\s*\{\s*display:\s*none/,
		);
		expect(css).toMatch(
			/@container appmain \(max-width: 480px\)\s*\{[\s\S]*?\.title-state \.remote-health-chip \.remote-health-label\s*\{\s*display:\s*none/,
		);
	});

	it("keeps every screen gutter on the density tokens", () => {
		// C7 — no hard-coded screen padding; density toggling must not
		// desynchronise one screen's first content row from the others.
		expect(rule(".harnesses-screen")).toMatch(
			/padding:\s*var\(--pad-screen-y\) var\(--pad-screen-x\)/,
		);
		expect(rule(".backup-screen-body")).toMatch(
			/padding:\s*var\(--pad-screen-y\) var\(--pad-screen-x\)/,
		);
		expect(rule(".harness-config-screen")).toMatch(
			/padding:\s*var\(--pad-screen-y\) var\(--pad-screen-x\)/,
		);
		expect(rule(".agent-docs-strip")).toMatch(/var\(--pad-screen-x\)/);
		for (const sel of [
			".harnesses-screen",
			".backup-screen-body",
			".agent-docs-strip",
		]) {
			expect(rule(sel)).not.toMatch(/padding:[^;]*\b24px\b/);
		}
	});

	it("makes the header reflow on content-column width via container queries", () => {
		expect(rule(".app-main")).toMatch(/container-type:\s*inline-size/);
		expect(rule(".app-main")).toMatch(/container-name:\s*appmain/);
		expect(css).toMatch(/@container appmain \(max-width:/);
	});

	it("defines the state-pill variants (StatusBadge preset)", () => {
		// StatePill is now a StatusBadge preset: channel drives hue, and the
		// mono/square-border look is carried by .status-badge.state-pill*.
		expect(css).toMatch(/\.status-badge\.state-pill/);
		expect(css).toMatch(/\.status-badge\.state-pill-saved/);
	});

	it("defines the subheader-group separator", () => {
		expect(css).toMatch(
			/\.subheader-group \+ \.subheader-group\s*\{[^}]*border-left/,
		);
	});

	it("keeps the header rows on one line (nowrap, shrink 0)", () => {
		expect(rule(".main-header")).toMatch(/flex-wrap:\s*nowrap/);
		expect(bandRule()).toMatch(/flex-shrink:\s*0/);
		expect(rule(".main-subheader")).toMatch(/flex-wrap:\s*nowrap/);
	});

	// ─── The header band (nav-header-align) ──────────────────────────────────
	// The navigator's section head, the rail's title strip and the screen header
	// are ONE band across all three columns. Asserted in CSS because jsdom has
	// no layout engine: the misalignment this closes was a 32px panel head
	// butting a 56px screen header.
	describe("header band", () => {
		it("gives all three columns the same height, surface and chrome-edge line", () => {
			const band = bandRule();
			expect(band).toBeTruthy();
			expect(band).toMatch(/height:\s*var\(--header-row-1\)/);
			// The band's bottom edge is the section-hued chrome-edge line (the
			// same stroke that runs down the rail edge and around the fused tab).
			expect(band).toMatch(/border-bottom:\s*1px solid var\(--chrome-edge\)/);
			expect(band).toMatch(/var\(--bg-0\)/);
			// …and the head no longer carries a band treatment of its own.
			const head = rule(".side-head");
			expect(head).not.toMatch(/height:/);
			expect(head).not.toMatch(/border-bottom:/);
			expect(head).not.toMatch(/background:/);
			// The strip keeps the SHARED band background (identical recipe = no
			// internal seam) and merely drops its bottom edge while the rail is
			// shown — below it the rail continues the same chrome ground.
			const merged = css.match(
				/\.app\[data-rail="true"\] \.app-topbar\s*\{([^}]*)\}/,
			)?.[1];
			expect(merged).toMatch(/border-bottom:\s*0/);
			expect(merged).not.toMatch(/background:/);
			// …and the rail carries the contour line + section wash on the
			// chrome ground.
			expect(rule(".app-rail")).toMatch(/var\(--chrome-edge\)/);
			expect(rule(".app-rail")).toMatch(/var\(--section-lifted, var\(--section\)\)/);
			expect(rule(".app-rail")).toMatch(/var\(--layer-rail\)/);
		});

		it("spans the navigator across rows 1–2 like the main column", () => {
			expect(rule(".app-side")).toMatch(/grid-row:\s*1 \/ 3/);
			expect(rule(".app-main")).toMatch(/grid-row:\s*1 \/ 3/);
		});

		it("has NO column separator — the layer staircase separates", () => {
			// The shell's columns are separated by the lightness step + cast AO
			// (layer staircase), never a hairline: a seam is what would keep a
			// fused selection from blending across the boundary.
			expect(rule(".app-side")).toMatch(/border-right:\s*0/);
			// The panel column is the chrome GROUND, and the ground is the only
			// thing that paints the chrome lamp for this column — same field,
			// same offset as the band cell above it, so the glow runs straight
			// down out of the head. The plate above it is a translucent sheet,
			// and a sheet can only show a tint something behind it paints.
			expect(rule(".app-side")).toMatch(
				/radial-gradient\(1000px 560px at var\(--lamp-x, 0px\) var\(--lamp-y, 0px\)/,
			);
			expect(rule(".app-side")).toMatch(/--lamp-x:\s*calc\(-1 \* var\(--panel-x\)\)/);
			expect(rule(".app-side")).toMatch(/var\(--bg-0\)/);
			// …and the plate itself is the glass sheet over it.
			expect(rule(".side-plate")).toMatch(/var\(--plate-bg\)/);
			expect(rule(".side-plate")).toMatch(/backdrop-filter:\s*var\(--plate-blur\)/);
			// Glass cues: a diagonal sheen and a faint INNER top edge. No outer
			// rim — it doubled the chrome contour (measured, iter 4).
			expect(rule(".side-plate")).toMatch(/linear-gradient\(158deg, var\(--plate-sheen\)/);
			expect(rule(".side-plate")).toMatch(
				/box-shadow:\s*inset 0 1px 0 var\(--plate-top-hi\)/,
			);
			// …and the sheet has something to be translucent OVER: a section-hued
			// backlight on the navigator's ground, under the plate.
			// The backlight belongs to the GLASS, so it is clipped to the plate's
			// own area — from the band's bottom edge down. The band is chrome and
			// chrome wears the lamp and nothing else.
			expect(rule(".app-side")).toMatch(
				/radial-gradient\(320px 480px at 0 0, var\(--panel-backlight\), transparent 70%\)\s*0 var\(--header-row-1\) \/ 100% calc\(100% - var\(--header-row-1\)\) no-repeat/,
			);
			expect(css).toMatch(/--plate-bg:\s*color-mix\(in oklab, var\(--layer-panel\) var\(--plate-alpha\)/);
			// Both opt-outs return the flat opaque plate.
			expect(css).toMatch(
				/@supports not \(\(backdrop-filter[\s\S]*?--plate-bg:\s*var\(--layer-panel\)/,
			);
			expect(css).toMatch(
				/@media \(prefers-reduced-transparency: reduce\)[\s\S]*?--plate-bg:\s*var\(--layer-panel\)/,
			);
			// The rail's active tab carries the panel, so it wears the same glass.
			expect(css).toMatch(
				/\.rail-btn\[aria-current="true"\]\s*\{[^}]*--fuse-mid:\s*var\(--plate-bg\)/,
			);
			// 90° corner: the contour's two straight lines simply meet — no
			// fillet, no plate radius (rounded-vs-square language is later work).
			expect(rule(".side-plate")).not.toMatch(/border-top-left-radius/);
			expect(css).not.toMatch(/\.app-side::after/);
			expect(rule(".app-rail")).toMatch(/var\(--layer-rail\)/);
			// The cast AO is a background LAYER that starts at the band's bottom,
			// never a box-shadow: `.app-main` spans grid rows 1–2, so a shadow
			// began at y=0 and WebKit rendered it as a hairline through the
			// header band (Chromium's blur happened to hide it).
			expect(rule(".app-main")).not.toMatch(/box-shadow/);
			expect(rule(".app-main")).toMatch(/--cast-layer:\s*var\(--cast-md-layer\)/);
			expect(rule(".app-main")).toMatch(
				/var\(--cast-layer\) 0 var\(--header-row-1\) \/ 24px calc\(100% - var\(--header-row-1\)\) no-repeat/,
			);
			expect(css).toMatch(/--cast-md-layer:\s*linear-gradient\(90deg,/);
			// …and every "nothing is casting" mode still drops it.
			expect(css).toMatch(
				/\.app\[data-gate="true"\] \.app-main,\s*\.app\[data-rail="false"\]\[data-narrow="true"\] \.app-main,\s*\.app\[data-rail="false"\]\[data-nav="false"\] \.app-main\s*\{\s*--cast-layer:\s*none/,
			);
			// The narrow drawer is an overlay, not a column: it keeps a real border.
			expect(css).toMatch(
				/\.app\[data-narrow="true"\] \.app-side\s*\{[^}]*border-right:\s*1px solid var\(--border\)/,
			);
		});

		it("puts the rail's first item and the navigator's first plaque on ONE content line", () => {
			// The step the user saw: the rail reserved a bare 12px while the
			// navigator's glance layer reserved 18px, and the two numbers had no
			// relationship. Both are now `--content-line` ± the column's own
			// anatomy constant, so they cannot drift apart again.
			// 13px, not 16px: the active Projects tab's ring must land flush on
			// the band's bottom edge (padding-top 1px, ring top 1−1=0), not
			// 3px below it — dropping the token by 3px raises the navigator's
			// first plaque the same 3px, which is the point (one shared line).
			expect(css).toMatch(/--content-line:\s*12px/);
			// The rail starts on the band's contour row so the first tab's ring can
			// share it (the rail's overflow would otherwise clip the stroke).
			expect(rule(".app-rail")).toMatch(/margin-top:\s*-1px/);
			expect(css).toMatch(/--rail-glyph-rise:\s*12px/);
			expect(css).toMatch(/--legend-rise:\s*7px/);
			expect(rule(".app-rail")).toMatch(
				/padding:\s*calc\(var\(--content-line\) - var\(--rail-glyph-rise\)\) 0 14px/,
			);
			expect(rule(".side-dash")).toMatch(
				/padding:\s*calc\(var\(--content-line\) \+ var\(--legend-rise\)\) 8px 0/,
			);
			// Neither first child may re-introduce a top margin over that.
			expect(rule(".side-attn")).toMatch(/margin:\s*0 2px 0/);
			expect(rule(".side-stats")).toMatch(/margin:\s*0 2px 6px/);
			// …and the air under an attention plaque is its own, larger figure.
			expect(css).toMatch(
				/\.side-attn \+ \.side-stats\s*\{\s*margin-top:\s*19px/,
			);
		});

		it("makes the rail's active tab the SAME sheet over the SAME ground", () => {
			// The tab is not "like" the navigator plate — it is the same recipe
			// over the same field. The rail column carries the backlight too, and
			// the tab paints the ground itself with `background-attachment:
			// fixed`, which positions a layer against the VIEWPORT — the only way
			// a tile that can sit at ten different y's can reproduce a field it
			// cannot measure. Measured ΔRGB ≤ 1 across the seam (PROOFS §iter6).
			// TWO GROUNDS. The chrome (band ∪ rail) wears ONLY the chrome lamp —
			// a backlight on the rail turned its top into a saturated pool with a
			// hard edge against the band. The tab still matches the plate because
			// it paints the whole recipe itself over a ground it fully covers.
			expect(rule(".app-rail")).not.toMatch(/--panel-backlight/);
			expect(rule(".app-rail")).toMatch(
				/radial-gradient\(1000px 560px at 0 calc\(-1 \* var\(--topbar-h\)\),\s*color-mix\(in oklab, var\(--section-lifted, var\(--section\)\) 14%, transparent\), transparent 70%\),\s*var\(--layer-rail\)/,
			);
			const tab = css.match(
				/\.rail-btn\[aria-current="true"\]::after\s*\{([\s\S]*?)\n\}/,
			)?.[1];
			expect(tab).toBeTruthy();
			expect(tab).toMatch(/background-attachment:\s*fixed, scroll, fixed, fixed/);
			expect(tab).toMatch(/var\(--panel-backlight\)/);
			expect(tab).toMatch(/linear-gradient\(158deg, var\(--plate-sheen\)/);
			expect(tab).toMatch(/background-color:\s*var\(--layer-rail\)/);
			// …and the plate's sheen is the same viewport-fixed field.
			expect(rule(".side-plate")).toMatch(/background-attachment:\s*fixed/);
			// The sheet's backdrop filter may not SATURATE: that would be a
			// treatment only the plate can apply, and the tab would fall short at
			// the seam. The saturation lives in --panel-backlight instead.
			expect(css).toMatch(/--plate-blur:\s*blur\(22px\);/);
			expect(css).not.toMatch(/--plate-blur:[^;]*saturate/);
			// The fused targets (nav hidden / narrow → the screen) stay intact.
			expect(css).toMatch(
				/\.app\[data-narrow="true"\] \.rail-btn\[aria-current="true"\]\s*\{\s*--fuse-mid:\s*var\(--atmo-tint\)/,
			);
			// The sticky group legend rebuilds the same sheet the same way: an
			// OPAQUE ground (so no row text can read through) with the lamp, the
			// backlight and the --plate-bg sheet composited on top of it, the
			// ground layers viewport-fixed so any scroll offset still matches.
			const head = rule(".side-group-head");
			expect(head).toMatch(/background-attachment:\s*fixed, scroll, fixed, fixed/);
			expect(head).toMatch(/linear-gradient\(var\(--plate-bg\), var\(--plate-bg\)\)/);
			expect(head).toMatch(/var\(--panel-backlight\)/);
			expect(head).toMatch(/background-color:\s*var\(--layer-rail\)/);
			expect(css).not.toMatch(/--plate-sticky/);
			// …and a floating drawer has no lit ground, so the legend has none.
			expect(css).toMatch(
				/\.app\[data-narrow="true"\] \.side-group-head\s*\{\s*background-image:\s*none;\s*background-color:\s*var\(--layer-panel\)/,
			);
		});

		it("has NO vertical seam INSIDE the band either", () => {
			// The band is one row across three columns, so no cell in it — and no
			// column reaching into it — may draw a vertical edge, and nothing may
			// CAST into it either (the screen's AO starts at the band's bottom,
			// above). A 1px line there cuts the one horizontal contour the band
			// exists to carry. Pixel-verified in
			// DESIGN-NAV-DASHBOARD/PROOFS-iter4.md.
			for (const sel of [".app-topbar", ".side-head", ".main-header"]) {
				expect(bandRule() + rule(sel), sel).not.toMatch(
					/border-(left|right|inline)/,
				);
			}
			expect(rule(".app-main")).not.toMatch(/border-left/);
			expect(rule(".side-plate")).not.toMatch(/border-(left|right)/);
		});

		it("insets the head clear of the traffic lights, per mode", () => {
			expect(rule(".side-head")).toMatch(
				/padding:\s*0 8px 0 var\(--side-head-inset\)/,
			);
			// Rail shown: only the part of the inset the rail does not already
			// cover, clamped so an expanded rail can't go negative.
			expect(rule(".app")).toMatch(
				/--side-head-inset:\s*max\(10px, calc\(var\(--titlebar-inset\) - var\(--rail-w\)\)\)/,
			);
			// Rail hidden: the panel starts at the window edge → the whole inset.
			expect(css).toMatch(
				/\.app\[data-rail="false"\]\s*\{[^}]*--side-head-inset:\s*var\(--titlebar-inset\)/,
			);
			// Fullscreen (lights auto-hide) + narrow (overlay drawer) → normal gutter.
			expect(css).toMatch(
				/\.app\[data-fullscreen="true"\],\s*\.app\[data-narrow="true"\]\s*\{\s*--side-head-inset:\s*10px/,
			);
		});

		it("keeps the title strip inside the rail column", () => {
			// It reserves the traffic lights for the RAIL only now; the sidebar
			// column's row-1 cell belongs to `.side-head`. `min-width: 0` is
			// load-bearing: a grid item's automatic minimum size widened the 56px
			// track and bled the strip 42px into the panel's cell.
			expect(css).toMatch(
				/\.app\[data-rail="true"\]\s+\.app-topbar\s*\{\s*grid-column:\s*1 \/ 2/,
			);
			expect(rule(".app-topbar")).toMatch(/min-width:\s*0/);
			// Band block included: padding added there would widen the 56px strip
			// exactly the way the old --titlebar-inset did.
			expect(bandRule() + rule(".app-topbar")).not.toMatch(/padding:/);
		});

		it("drops the title strip when the panel takes over its cell", () => {
			// Rail hidden + navigator docked: `.app-side` owns column 1 AND row 1,
			// so a strip in the same cell would paint over the panel head.
			expect(css).toMatch(
				/\.app\[data-rail="false"\]\[data-nav="true"\]:not\(\[data-narrow="true"\]\)\s*\{\s*--topbar-h:\s*0px/,
			);
			expect(css).toMatch(
				/\.app\[data-rail="false"\]\[data-nav="true"\]:not\(\[data-narrow="true"\]\) \.app-topbar\s*\{\s*display:\s*none/,
			);
			// Fullscreen already collapsed it (macOS auto-hides the lights).
			expect(css).toMatch(
				/\.app\[data-fullscreen="true"\]\s*\{\s*--topbar-h:\s*0px/,
			);
		});

		it("keeps the band over the rail column in fullscreen", () => {
			// The reported mode. Collapsing the strip here left the rail's top 56px
			// outside the band, with its full-height border-right crossing the one
			// row that must read as continuous.
			expect(css).toMatch(
				/\.app\[data-fullscreen="true"\]\[data-rail="true"\]\s*\{\s*--topbar-h:\s*var\(--header-row-1\)/,
			);
			expect(css).toMatch(
				/\.app\[data-fullscreen="true"\]\[data-rail="true"\] \.app-topbar\s*\{\s*display:\s*block/,
			);
			// …and NOT extended to the rail-hidden layouts, where the panel or main
			// owns the band's leftmost cell.
			expect(css).not.toMatch(
				/\.app\[data-fullscreen="true"\]\[data-rail="false"\]\s*\{\s*--topbar-h:\s*var\(--header-row-1\)/,
			);
		});

		it("keeps the window-spanning strip a title bar, not a second band", () => {
			// Rail off + panel out of flow: the strip spans the window and main
			// starts in ROW 2 beneath it. Wearing the band's wash + section
			// underline there stacked two identical 56px bands, the top one blank.
			const strip = css.match(
				/\.app\[data-rail="false"\]\[data-narrow="true"\] \.app-topbar,\s*\.app\[data-rail="false"\]\[data-nav="false"\] \.app-topbar\s*\{([^}]*)\}/,
			);
			expect(strip).not.toBeNull();
			expect(strip![1]).toMatch(/grid-column:\s*1 \/ -1/);
			expect(strip![1]).toMatch(/background:\s*var\(--bg-0\)/);
			expect(strip![1]).toMatch(/box-shadow:\s*none/);
		});

		it("makes the docked head a drag region, but not the narrow drawer", () => {
			expect(rule(".side-head")).toMatch(/-webkit-app-region:\s*drag/);
			expect(rule(".side-head-add")).toMatch(/-webkit-app-region:\s*no-drag/);
			// The drawer floats over page content at y=--topbar-h, nowhere near the
			// title bar. (NavPanel also omits the ATTRIBUTE there — Tauri reads
			// that, not this property; pinned in NavPanel.test.tsx.)
			expect(css).toMatch(
				/\.app\[data-narrow="true"\] \.side-head\s*\{\s*-webkit-app-region:\s*no-drag/,
			);
		});

		it("parks the sticky group legend flush with the scroller's top edge", () => {
			// A sticky legend stops at the scroll container's PADDING edge, so any
			// padding-top on `.side-scroll` is a slit above the stuck legend in
			// which rows scrolling past stay visible (seen in the installed app:
			// a skill row peeking out between the tiles and "SKILLS 173"). The
			// list's top air lives on the first group instead.
			expect(rule(".side-scroll")).toMatch(/padding:\s*0 /);
			expect(rule(".side-scroll")).not.toMatch(/padding-top/);
			expect(css).toMatch(/\.side-group:first-child\s*\{\s*margin-top:\s*6px/);
			expect(rule(".side-group-head")).toMatch(/position:\s*sticky/);
			expect(rule(".side-group-head")).toMatch(/top:\s*0/);
		});

		it("keeps the navigator's `.side-group` family out of every other stylesheet", () => {
			// Seen in the installed app: BUNDLES and SNIPPETS rendered as a label
			// column beside a row column. A `.sf-group, .side-group { display:
			// flex }` rule written for the skill editor's USED BY labels had
			// landed on the navigator's `<section class="side-group">`, whose
			// head + items then sat side by side. The editor's labels are
			// `.equip-group` now; the navigator's classes belong to the shell
			// sheets alone.
			const dir = path.join(__dirname, "..", "styles");
			const owners = new Set(["shell-nav.css", "shell-scaffold.css"]);
			const offenders: string[] = [];
			const walk = (d: string) => {
				for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
					const full = path.join(d, entry.name);
					if (entry.isDirectory()) walk(full);
					else if (entry.name.endsWith(".css") && !owners.has(entry.name)) {
						const text = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
						if (/\.side-group[\w-]*/.test(text)) {
							offenders.push(path.relative(dir, full));
						}
					}
				}
			};
			walk(dir);
			expect(offenders).toEqual([]);
		});

		it("lights the active nav row as a slot instead of bleeding it into the screen", () => {
			// Selection is a GUILD LIT SLOT now: the row keeps its place on the
			// plate and lights up inside a hairline ring in its own shape. The
			// old fusion (a negative right margin carrying the row across the
			// panel's edge onto the screen's material) is gone — no bleed, no
			// screen-surface gradient.
			expect(rule(".app-side")).not.toMatch(/padding-right/);
			const active = css.match(
				/\.side-item\[data-active="true"\]\s*\{([^}]*)\}/,
			)?.[1];
			expect(active).toBeTruthy();
			expect(active).not.toMatch(/margin-right/);
			expect(active).not.toMatch(/layer-screen-edge/);
			expect(active).toMatch(/background:\s*var\(--slot-fill\)/);
			expect(active).toMatch(/box-shadow:\s*var\(--slot-glow\)/);
			expect(active).toMatch(/border-radius:\s*var\(--radius-frame\)/);
			// The ring is a pseudo-element (a real border would shift every row
			// by a pixel on selection).
			expect(css).toMatch(
				/\.side-item\[data-active="true"\]::before\s*\{[^}]*border:\s*1px solid var\(--slot-ring\)/,
			);
			// An expanded row + its detail block are ONE compartment: the row
			// drops the ring's bottom stroke, the block carries sides + bottom.
			expect(css).toMatch(
				/\.side-item\[data-expanded="true"\]::before\s*\{\s*border-bottom:\s*0/,
			);
			expect(css).toMatch(
				/\.side-item-detail::before\s*\{[^}]*border-top:\s*0/,
			);
			expect(rule(".side-item-detail")).not.toMatch(/margin-right/);
			// …and a nested row inside it never gets a ring of its own.
			expect(css).toMatch(
				/\.side-item\.is-nested\[data-active="true"\]::before\s*\{\s*display:\s*none/,
			);
			// Keyboard focus stays a DIFFERENT mark from selection.
			expect(css).toMatch(
				/\.side-item-main:focus-visible,[\s\S]*?outline-offset:\s*-3px/,
			);
		});

		it("lets the StatusBar brand give ground before anything else", () => {
			expect(css).toMatch(
				/\.app-status > \.status-segment:not\(\[title\]\):not\(\.status-brand\)/,
			);
			const brand = css.match(
				/\.app-status > \.status-brand\s*\{([^}]*)\}/,
			);
			expect(brand).not.toBeNull();
			expect(brand![1]).toMatch(/flex-shrink:\s*1/);
			expect(brand![1]).toMatch(/text-overflow:\s*ellipsis/);
			// …and it is still culled outright at the narrow tier.
			expect(css).toMatch(
				/@media \(max-width: 680px\)\s*\{[\s\S]*?\.app-status > \.status-brand\s*\{\s*display:\s*none/,
			);
		});
	});

	it("uses the gutter token on the header rows", () => {
		expect(rule(".main-header")).toMatch(/padding:\s*0 var\(--pad-screen-x\)/);
		expect(rule(".main-subheader")).toMatch(
			/padding:\s*0 var\(--pad-screen-x\)/,
		);
	});

	it("models the editor as a height-filling grid (no grid-level scroll)", () => {
		const grid = rule(".editor-grid");
		expect(grid).toMatch(/display:\s*grid/);
		expect(grid).not.toMatch(/overflow-y:\s*auto/);
	});

	it("makes the code area the editor's scroller", () => {
		const code = rule(".code-area");
		expect(code).toMatch(/overflow:\s*auto/);
		expect(code).toMatch(/overscroll-behavior:\s*contain/);
		expect(code).not.toMatch(/calc\(100vh/);
	});

	it("keeps the editor pane from competing with the code-area scroller", () => {
		const main = rule(".editor-main");
		expect(main).toMatch(/overflow-y:\s*auto/);
		expect(main).toMatch(/overflow-x:\s*hidden/);
		expect(main).not.toMatch(/overflow:\s*auto/);
	});

	it("lets the CodeMirror editor fill the code-area scroller in edit mode", () => {
		// Edit mode is owned by CodeMirror 6 (one layer — no overlay), so the
		// .code-area wrapper stays the single scroll owner and CM fills it.
		expect(rule(".code-area--edit .cm-editor")).toMatch(/height:\s*100%/);
		expect(rule(".code-area--edit .cm-scroller")).toMatch(/overflow:\s*auto/);
	});

	it("has no editor-scoped scrollbar override", () => {
		expect(css).not.toMatch(/\.editor-side\s*\{[^}]*scrollbar-color/);
		expect(css).not.toMatch(/\.editor-grid::-webkit-scrollbar/);
	});

	it("keeps a single global scrollbar style", () => {
		expect(css).toMatch(
			/::-webkit-scrollbar-thumb\s*\{\s*background:\s*var\(--bg-3\)/,
		);
	});

	it("drops the permissions stat-grid and header bands", () => {
		expect(css).not.toMatch(/\.perm-stat-grid\s*\{/);
		expect(css).not.toMatch(/\.perm-header\s*\{/);
		expect(css).not.toMatch(/\.perm-save-state\s*\{/);
	});

	it("gives each permissions pane its own scroller (no sticky hack)", () => {
		expect(rule(".perm-main")).toMatch(/overflow:\s*auto/);
		expect(rule(".perm-side")).toMatch(/overflow-y:\s*auto/);
		expect(rule(".perm-side")).not.toMatch(/position:\s*sticky/);
		expect(rule(".perm-side")).not.toMatch(/calc\(100vh/);
	});

	it("spaces project workspace bands with twice the vertical gutter", () => {
		expect(css).toMatch(
			/\.ws-band \+ \.ws-band\s*\{\s*margin-top:\s*calc\(var\(--pad-screen-y\) \* 2\)/,
		);
	});
});
