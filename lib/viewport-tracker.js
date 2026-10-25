const { Emitter, CompositeDisposable } = require("lumine");

// Emit only after scrolling settles so a flick through a long file does not
// fire a resolve per frame.
const SCROLL_SETTLE_MS = 150;
// Rows reported beyond the visible range, so small scrolls are already covered.
const MARGIN_ROWS = 50;

// Per-editor visible-row-range watcher driving lazy lens resolution. Emits
// "stale" with the visible screen-row range converted to buffer rows, padded by
// MARGIN_ROWS and clamped to the buffer.
module.exports = class ViewportTracker {
  constructor() {
    this.emitter = new Emitter();
    this.states = new Map();
    this.subscriptions = new CompositeDisposable(
      lumine.workspace.observeTextEditors((editor) => this.watchEditor(editor)),
    );
  }
  // fn({editor, range: [startBufferRow, endBufferRow]})
  onDidBecomeStale(fn) {
    return this.emitter.on("stale", fn);
  }
  watchEditor(editor) {
    if (this.states.has(editor) || editor.isMini?.()) return;
    const element = editor.getElement();
    const state = { editor, timer: null, visible: null, subscriptions: new CompositeDisposable() };
    this.states.set(editor, state);
    state.subscriptions.add(
      element.onDidChangeScrollTop(() => this.scheduleEmit(state)),
      // The buffer already debounces this event (~300 ms after typing stops),
      // so no extra timer is layered on top.
      editor.onDidStopChanging(() => this.emitStale(state)),
      editor.onDidDestroy(() => this.unwatchEditor(editor)),
    );
    for (const [event, callback] of [
      ["onDidAttach", () => this.bindEditorWindow(state)],
      ["onDidDetach", () => this.releaseEditorWindow(state)],
    ]) {
      const subscription = element[event]?.(callback);
      if (subscription) state.subscriptions.add(subscription);
    }
    this.bindEditorWindow(state);
  }
  bindEditorWindow(state) {
    if (this.states.get(state.editor) !== state) return;
    const element = state.editor.getElement();
    const ownerWindow = element.ownerDocument.defaultView;
    if (state.ownerWindow === ownerWindow) return;
    const initialBinding = state.presentationGeneration == null;
    this.releaseEditorWindow(state);
    state.ownerWindow = ownerWindow;
    if (initialBinding) state.visible = null;

    const generation = state.presentationGeneration;
    const current = () =>
      this.states.get(state.editor) === state &&
      state.ownerWindow === ownerWindow &&
      state.presentationGeneration === generation;
    // A background pane reports a meaningless viewport; emit when the editor
    // is revealed so placeholders scrolled past while hidden catch up. The
    // observer fires after the component's reveal update (didShow renders
    // synchronously), so the measurements read here are current.
    const observer = new ownerWindow.IntersectionObserver((entries) => {
      if (!current()) return;
      const { intersectionRect } = entries[entries.length - 1];
      const visible = intersectionRect.width > 0 || intersectionRect.height > 0;
      const becameVisible = visible && state.visible !== true;
      state.visible = visible;
      if (becameVisible) this.emitStale(state);
    });
    observer.observe(element);
    state.intersectionObserver = observer;
  }
  releaseEditorWindow(state) {
    state.presentationGeneration = (state.presentationGeneration ?? 0) + 1;
    this.clearTimers(state);
    state.ownerWindow = null;
    state.intersectionObserver?.disconnect();
    state.resizeObserver?.disconnect();
    state.intersectionObserver = null;
    state.resizeObserver = null;
    state.visible = false;
  }
  clearTimers(state) {
    for (const key of ["timer"]) {
      if (state[key] != null) state.ownerWindow?.clearTimeout(state[key]);
      state[key] = null;
    }
  }

  unwatchEditor(editor) {
    const state = this.states.get(editor);
    if (!state) return;
    this.releaseEditorWindow(state);
    state.subscriptions.dispose();
    this.states.delete(editor);
  }
  scheduleEmit(state) {
    if (state.editor.getGrammar?.() === lumine.grammars.nullGrammar) return;
    if (this.states.get(state.editor) !== state || !state.ownerWindow) return;
    const ownerWindow = state.ownerWindow;
    const generation = state.presentationGeneration;
    if (state.timer != null) state.ownerWindow?.clearTimeout(state.timer);
    const timer = ownerWindow.setTimeout(() => {
      if (
        state.ownerWindow !== ownerWindow ||
        state.presentationGeneration !== generation ||
        state.timer !== timer
      )
        return;
      state.timer = null;
      this.emitStale(state);
    }, SCROLL_SETTLE_MS);
    state.timer = timer;
  }
  emitStale(state) {
    if (state.editor.getGrammar?.() === lumine.grammars.nullGrammar) return;
    if (this.states.get(state.editor) !== state || !state.ownerWindow) return;
    if (state.editor.isDestroyed()) return;
    this.emitter.emit("stale", { editor: state.editor, range: this.rangeForEditor(state.editor) });
  }
  rangeForEditor(editor) {
    if (editor.getGrammar?.() === lumine.grammars.nullGrammar) return [0, 0];
    const lastBufferRow = editor.getBuffer().getLastRow();
    // An editor that has never been rendered — one opened in a background tab,
    // or observed before its element is attached — reports no visible rows at
    // all. Treat it as showing the top of the buffer rather than converting
    // NaN into a screen position.
    const firstScreenRow = editor.getFirstVisibleScreenRow();
    const lastScreenRow = editor.getLastVisibleScreenRow();
    if (!Number.isFinite(firstScreenRow) || !Number.isFinite(lastScreenRow))
      return [0, Math.min(lastBufferRow, MARGIN_ROWS)];
    const first = editor.bufferRowForScreenRow(firstScreenRow);
    const last = editor.bufferRowForScreenRow(lastScreenRow);
    return [Math.max(0, first - MARGIN_ROWS), Math.min(lastBufferRow, last + MARGIN_ROWS)];
  }
  visibleRangeForEditor(editor) {
    return this.states.get(editor)?.visible === true ? this.rangeForEditor(editor) : null;
  }
  dispose() {
    for (const editor of [...this.states.keys()]) this.unwatchEditor(editor);
    this.subscriptions.dispose();
    this.emitter.dispose();
  }
};
