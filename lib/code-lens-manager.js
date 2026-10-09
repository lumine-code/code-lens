const { CompositeDisposable } = require("lumine");
const ProviderRegistry = require("./provider-registry");
const ViewportTracker = require("./viewport-tracker");

// Extra settle time on top of the buffer's own stopped-changing delay: lens
// positions are anchored markers, so refetching lazily is fine.
const FETCH_DEBOUNCE_MS = 1000;

const PLACEHOLDER = "…";

// A provider may return a Range or a bare point-pair array, and only the start
// row places the lens.
const startRow = (range) => {
  if (!range) return null;
  const start = Array.isArray(range) ? range[0] : range.start;
  if (!start) return null;
  const row = Array.isArray(start) ? start[0] : start.row;
  return Number.isInteger(row) && row >= 0 ? row : null;
};

// A titleless lens is a placeholder waiting to be resolved, so one from a
// provider that cannot resolve it would read "…" for good.
const isRenderable = ({ lens, provider }) =>
  !!lens && (lens.title != null || typeof provider.resolveCodeLens === "function");

// Renders the registered providers' lenses as block decorations above the rows
// they annotate. Unresolved lenses show a placeholder and resolve lazily when
// their row scrolls into view. The gate is the scoped config code-lens.enabled
// — on by default, so it can be switched off per language.
module.exports = class CodeLensManager {
  constructor() {
    this.disposed = false;
    this.registry = new ProviderRegistry();
    this.tracker = new ViewportTracker();
    this.states = new Map();
    this.subscriptions = new CompositeDisposable(
      lumine.workspace.observeTextEditors((editor) => this.watchEditor(editor)),
      this.registry.onDidChange(() => this.fetchAll()),
      this.registry.onDidInvalidate(({ editor }) =>
        editor ? this.fetchEditor(editor) : this.fetchAll(),
      ),
      this.tracker.onDidBecomeStale(({ editor, range }) => this.resolveVisible(editor, range)),
      lumine.config.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("code-lens.enabled")) this.fetchAll();
      }),
      lumine.commands.add("lumine-workspace", {
        "code-lens:toggle": {
          description: "Show or hide the lens links above your code.",
          didDispatch: () => this.toggle(),
        },
        "code-lens:refresh": {
          description: "Ask the providers for this file's lenses again.",
          didDispatch: () => this.refresh(),
        },
      }),
    );
  }

  // The global value, which is what the settings page shows. A language with an
  // override of its own keeps it, and says so rather than appearing to ignore
  // the command.
  toggle() {
    const next = !lumine.config.get("code-lens.enabled");
    lumine.config.set("code-lens.enabled", next);
    const editor = lumine.workspace.getActiveTextEditor();
    if (!editor) return;
    const scoped = lumine.config.get("code-lens.enabled", {
      scope: editor.getRootScopeDescriptor(),
    });
    if (scoped === next) return;
    lumine.notifications.addWarning(`Code lenses stay ${scoped ? "on" : "off"} for this language`, {
      description:
        "This language has a setting of its own, which wins over the one just changed. Change it on the Code Lens settings page.",
    });
  }

  refresh() {
    const editor = lumine.workspace.getActiveTextEditor();
    if (editor) this.fetchEditor(editor);
  }

  watchEditor(editor) {
    if (this.disposed || this.states.has(editor) || editor.isMini?.()) return;
    const state = {
      editor,
      rows: new Map(),
      timer: null,
      generation: 0,
      subscriptions: new CompositeDisposable(),
    };
    this.states.set(editor, state);
    state.subscriptions.add(
      editor.onDidStopChanging(() => this.scheduleFetch(state)),
      // A grammar change swaps which providers serve the editor.
      editor.onDidChangeGrammar(() => this.fetch(state)),
      editor.onDidDestroy(() => this.detachEditor(editor)),
    );
    this.fetch(state);
  }

  detachEditor(editor) {
    const state = this.states.get(editor);
    if (!state) return;
    this.states.delete(editor);
    if (state.timer) clearTimeout(state.timer);
    state.generation++;
    state.subscriptions.dispose();
    this.clear(state);
  }

  enabledFor(editor) {
    return !!lumine.config.get("code-lens.enabled", {
      scope: editor.getRootScopeDescriptor(),
    });
  }

  scheduleFetch(state) {
    if (this.disposed || this.states.get(state.editor) !== state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      this.fetch(state);
    }, FETCH_DEBOUNCE_MS);
  }

  fetchAll() {
    for (const state of this.states.values()) this.fetch(state);
  }

  fetchEditor(editor) {
    const state = this.states.get(editor);
    if (state) this.fetch(state);
  }

  async fetch(state) {
    const { editor } = state;
    if (this.disposed || this.states.get(editor) !== state || editor.isDestroyed()) return;
    const generation = ++state.generation;
    const owns = () =>
      !this.disposed &&
      this.states.get(editor) === state &&
      state.generation === generation &&
      !editor.isDestroyed();
    // Nothing is asked while the feature is off, so an expensive provider costs
    // nothing until someone wants it.
    if (!this.enabledFor(editor)) return this.clear(state);
    const providers = this.registry.getAllRegistrationsForEditor(editor);
    if (!owns()) return;
    if (!providers.length) return this.clear(state);
    const available = new Set(providers);
    for (const [row, entry] of state.rows) {
      const current = entry.items.filter((item) => available.has(item.record));
      if (current.length === entry.items.length) continue;
      if (current.length) {
        entry.items = current;
        this.renderRowItem(entry);
      } else {
        entry.retired = true;
        state.rows.delete(row);
        entry.marker.destroy();
      }
      if (!owns()) return;
    }
    const collected = await Promise.all(
      providers.map(async (record) => {
        if (!owns() || !this.registry.isRegistered(record)) return [];
        const { provider } = record;
        try {
          const lenses = await provider.codeLenses(editor);
          if (!owns() || !this.registry.isRegistered(record)) return [];
          return (lenses || []).map((lens) => ({ lens, provider, record }));
        } catch {
          // One provider failing is not the others' problem.
          return [];
        }
      }),
    );
    if (!owns()) return;
    const items = collected
      .flat()
      .filter((item) => this.registry.isRegistered(item.record) && isRenderable(item));
    if (!owns()) return;
    this.render(state, items);
  }

  // Refresh in place: block-decoration insertion has no scroll anchoring, so
  // destroying and recreating an item whose row survives would make the
  // viewport jump. Surviving rows keep their marker, decoration, and item;
  // only their anchors are updated.
  render(state, items) {
    const generation = state.generation;
    const owns = () =>
      !this.disposed &&
      this.states.get(state.editor) === state &&
      state.generation === generation &&
      !state.editor.isDestroyed();
    if (!owns()) return;
    const byRow = new Map();
    for (const item of items) {
      const row = startRow(item.lens.range);
      if (!owns()) return;
      if (row == null) continue;
      let group = byRow.get(row);
      if (!group) byRow.set(row, (group = []));
      group.push(item);
    }
    for (const [row, entry] of state.rows) {
      if (byRow.has(row)) continue;
      entry.retired = true;
      state.rows.delete(row);
      entry.marker.destroy();
      if (!owns()) return;
    }
    for (const [row, group] of byRow) {
      let entry = state.rows.get(row);
      if (!entry) {
        entry = this.createRowEntry(state, row);
        if (!owns()) {
          entry.retired = true;
          entry.marker.destroy();
          return;
        }
        state.rows.set(row, entry);
      } else if (entry.marker.getStartBufferPosition().row !== row) {
        // The marker drifted with edits since the last fetch; the freshly
        // fetched row is authoritative.
        entry.marker.setBufferRange([
          [row, 0],
          [row, 0],
        ]);
      }
      if (!owns() || entry.retired) return;
      entry.items = group;
      entry.resolving.clear();
      this.renderRowItem(entry);
      if (!owns()) return;
    }
    // A fetch can finish after the viewport's visibility notification. Resolve
    // rows that are already on screen without waiting for another scroll.
    const visibleRange = this.tracker.visibleRangeForEditor(state.editor);
    if (owns() && visibleRange) this.resolveVisible(state.editor, visibleRange);
  }

  createRowEntry(state, row) {
    // Block decorations tolerate empty ranges (only text decorations skip
    // them), so the marker sits collapsed at the start of the row.
    const marker = state.editor.markBufferRange(
      [
        [row, 0],
        [row, 0],
      ],
      { invalidate: "touch" },
    );
    const item = document.createElement("div");
    item.className = "code-lens";
    const entry = { marker, item, state, retired: false, items: [], resolving: new Set() };
    item.addEventListener("click", (event) => this.didClick(entry, event));
    entry.decoration = state.editor.decorateMarker(marker, {
      type: "block",
      position: "before",
      order: 0,
      item,
    });
    return entry;
  }

  renderRowItem(entry) {
    const { item, items } = entry;
    while (item.childNodes.length > items.length) item.lastChild.remove();
    items.forEach(({ lens }, index) => {
      let anchor = item.childNodes[index];
      if (!anchor) {
        anchor = document.createElement("a");
        item.appendChild(anchor);
      }
      this.renderAnchor(anchor, lens);
    });
  }

  renderAnchor(anchor, lens) {
    anchor.textContent = lens.title ?? PLACEHOLDER;
    if (lens.tooltip) anchor.title = lens.tooltip;
    else anchor.removeAttribute("title");
    // A lens with nothing to run is a label, not a link.
    anchor.classList.toggle("code-lens-inert", typeof lens.execute !== "function");
  }

  didClick(entry, event) {
    if (this.disposed || entry.retired || this.states.get(entry.state.editor) !== entry.state)
      return;
    const anchor = event.target.closest("a");
    if (!anchor || !entry.item.contains(anchor)) return;
    const index = Array.prototype.indexOf.call(entry.item.childNodes, anchor);
    const rowItem = entry.items[index];
    const lens = rowItem?.lens;
    if (!this.registry.isRegistered(rowItem?.record)) return;
    if (typeof lens?.execute !== "function") return;
    event.preventDefault();
    // Through a promise so a provider that throws synchronously is reported the
    // same way as one that rejects.
    Promise.resolve()
      .then(() => {
        if (
          !this.disposed &&
          !entry.retired &&
          this.registry.isRegistered(rowItem.record) &&
          entry.items[index] === rowItem
        )
          return lens.execute();
      })
      .catch((error) =>
        lumine.notifications.addError("Code lens command failed", {
          detail: error.message,
          dismissable: true,
        }),
      );
  }

  // Lazily resolve placeholder lenses whose rows entered the viewport.
  resolveVisible(editor, [firstRow, lastRow]) {
    const state = this.states.get(editor);
    if (this.disposed || !state) return;
    const generation = state.generation;
    for (const entry of state.rows.values()) {
      const row = entry.marker.getStartBufferPosition().row;
      if (row < firstRow || row > lastRow) continue;
      entry.items.forEach((item, index) => {
        const { lens, provider, record } = item;
        if (!this.registry.isRegistered(record)) return;
        if (lens.title != null || entry.resolving.has(lens)) return;
        if (typeof provider.resolveCodeLens !== "function") return;
        // Held whatever the outcome: a lens is attempted once, and a failure
        // waits for the next fetch rather than retrying on every scroll.
        entry.resolving.add(lens);
        Promise.resolve()
          .then(() => {
            if (
              !this.disposed &&
              !entry.retired &&
              state.generation === generation &&
              this.registry.isRegistered(record)
            )
              return provider.resolveCodeLens(lens, editor);
          })
          .then((resolved) => {
            // A refetch may have replaced the row's lenses meanwhile.
            if (
              this.disposed ||
              entry.retired ||
              state.generation !== generation ||
              !this.registry.isRegistered(record) ||
              !resolved?.title ||
              entry.items[index]?.lens !== lens
            )
              return;
            item.lens = resolved;
            const anchor = entry.item.childNodes[index];
            if (anchor) this.renderAnchor(anchor, resolved);
          })
          .catch(() => {});
      });
    }
  }

  clear(state) {
    for (const entry of state.rows.values()) entry.retired = true;
    if (!state.editor.isDestroyed())
      for (const entry of state.rows.values()) entry.marker.destroy();
    state.rows.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const editor of [...this.states.keys()]) this.detachEditor(editor);
    this.subscriptions.dispose();
    this.tracker.dispose();
    this.registry.dispose();
  }
};
