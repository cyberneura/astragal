/** チャットの title を即時更新できるツールチップに置き換える。 */
export function initChatTooltips(roots: HTMLElement[]): void {
  const tooltip = document.createElement("div");
  tooltip.id = "chat-tooltip";
  tooltip.className = "chat-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  document.body.append(tooltip);
  let anchor: HTMLElement | null = null;
  let described: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function hide(): void {
    clearTimeout(timer);
    tooltip.hidden = true;
    if (described) {
      const ids = (described.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(id => id && id !== tooltip.id);
      if (ids.length) described.setAttribute("aria-describedby", ids.join(" "));
      else described.removeAttribute("aria-describedby");
    }
    anchor = null;
    described = null;
  }
  function show(): void {
    if (!anchor?.isConnected || !anchor.getClientRects().length || !anchor.dataset.tooltip) { hide(); return; }
    tooltip.textContent = anchor.dataset.tooltip;
    tooltip.hidden = false;
    tooltip.style.left = "0px";
    tooltip.style.top = "0px";
    const rect = anchor.getBoundingClientRect();
    const { width, height } = tooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left + (rect.width - width) / 2, window.innerWidth - width - 8));
    const below = rect.bottom + 6;
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - 6);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    if (described) {
      const ids = new Set((described.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
      ids.add(tooltip.id);
      described.setAttribute("aria-describedby", [...ids].join(" "));
    }
  }
  function adoptTitles(node: Element): void {
    for (const target of [node, ...node.querySelectorAll("[title]")]) {
      if (!(target instanceof HTMLElement) || !target.hasAttribute("title")) continue;
      target.dataset.tooltip = target.title;
      target.removeAttribute("title");
    }
  }
  function enter(event: Event): void {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const candidate = target?.closest<HTMLElement>("[data-tooltip]") ?? null;
    if (!candidate || !roots.some(root => root.contains(candidate))) { hide(); return; }
    if (anchor === candidate) {
      if (event.type === "focusin") { hide(); anchor = candidate; described = target; show(); }
      return;
    }
    hide();
    anchor = candidate;
    described = event.type === "focusin" ? target : candidate;
    if (event.type === "focusin") show();
    else timer = setTimeout(show, 80);
  }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof Element) adoptTitles(record.target);
      for (const node of record.addedNodes) if (node instanceof Element) adoptTitles(node);
    }
    if (anchor && !tooltip.hidden) show();
  });
  for (const root of roots) {
    adoptTitles(root);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["title", "hidden", "data-tooltip"] });
    root.addEventListener("pointerover", enter);
    root.addEventListener("focusin", enter);
    root.addEventListener("pointerout", event => {
      if (!(event.relatedTarget instanceof Node) || !anchor?.contains(event.relatedTarget)) hide();
    });
    root.addEventListener("focusout", hide);
    root.addEventListener("pointerdown", hide, true);
    root.addEventListener("keydown", hide, true);
  }
  window.addEventListener("blur", hide);
  window.addEventListener("resize", hide);
  document.addEventListener("scroll", hide, true);
}
