import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Popover } from "@/components/Popover";
import type { ClassificationContribution } from "@/lib/skillClassification";

export function SkillHeaderClasses({ items, onInspect }: {
  items: ClassificationContribution[];
  onInspect: (value: string) => void;
}) {
  const strip = useRef<HTMLSpanElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [layout, setLayout] = useState({ count: items.length, width: 0 });
  const [open, setOpen] = useState(false);
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const cancelClose = () => clearTimeout(timer.current);
  useEffect(() => () => clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (!strip.current || !measure.current) return;
    const update = () => {
      const row = measure.current!;
      const widths = Array.from(row.children, (child) => child.getBoundingClientRect().width);
      const moreWidth = widths.pop() ?? 0;
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const width = widths.reduce((sum, value) => sum + value, 0) + gap * Math.max(0, widths.length - 1);
      const available = strip.current!.getBoundingClientRect().width;
      let count = widths.length;
      if (width > available) {
        let used = moreWidth;
        count = 0;
        for (const chip of widths) {
          if (used + gap + chip > available) break;
          used += gap + chip;
          count++;
        }
      }
      setLayout((prev) => prev.count === count && prev.width === width ? prev : { count, width });
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(strip.current);
    observer.observe(measure.current);
    return () => observer.disconnect();
  }, [items]);

  const overflow = layout.count < items.length;
  const chipClass = (item: ClassificationContribution) => `classification-header-value classification-value classification-value-${item.provenance}`;
  const chip = (item: ClassificationContribution) => (
    <button type="button" className={chipClass(item)} key={item.value}
      title={`${item.value} · ${item.provenance}`} aria-label={`${item.value}, ${item.provenance}`}
      onClick={() => { setOpen(false); onInspect(item.value); }}>{item.value}</button>
  );
  if (!items.length) return null;
  return (
    <span ref={strip} className="skill-header-classes" style={{ width: layout.width || undefined }}
      onMouseEnter={cancelClose}
      onMouseLeave={() => { cancelClose(); timer.current = setTimeout(() => setOpen(false), 180); }}>
      <span className="skill-header-classes-measure" ref={measure} aria-hidden="true">
        {items.map((item) => <span key={item.value} className={chipClass(item).replace("classification-header-value", "skill-header-class-measure-value")}>{item.value}</span>)}
        <span className="classification-header-value skill-header-classes-more">...</span>
      </span>
      {items.slice(0, layout.count).map(chip)}
      {overflow && <button ref={anchor} type="button" className="classification-header-value skill-header-classes-more"
        aria-label="Show all classes" aria-haspopup="dialog" aria-expanded={open}
        onMouseEnter={() => { setFocusOnOpen(false); setOpen(true); }}
        onFocus={(event) => {
          if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest(".skill-header-classes-popover")) {
            setFocusOnOpen(false); setOpen(true);
          }
        }}
        onBlur={(event) => {
          if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest(".skill-header-classes-popover")) setOpen(false);
        }}
        onClick={() => { setFocusOnOpen(true); setOpen(true); }}>...</button>}
      <Popover open={open && overflow} onClose={() => setOpen(false)} anchorRef={anchor}
        focusOnOpen={focusOnOpen} label="All classes" className="skill-header-classes-popover">
        <div className="skill-header-classes-list">{items.map(chip)}</div>
      </Popover>
    </span>
  );
}
