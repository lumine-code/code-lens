const os = require("os");
const path = require("path");
const { CompositeDisposable, Emitter } = require("lumine");

const packageRoot = path.join(__dirname, "..");

// Flushes pending microtasks so the fetch/resolve chains settle without
// advancing the fake clock.
async function microtasks(count = 40) {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

const lensAt = (row, title, extra = {}) => ({
  range: [
    [row, 0],
    [row, 1],
  ],
  ...(title == null ? {} : { title }),
  ...extra,
});

describe("code-lens", () => {
  let mainModule, manager, editor, disposables;

  beforeEach(async () => {
    const workspaceElement = lumine.workspace.getElement();
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "400px";
    jasmine.attachToDOM(workspaceElement);
    disposables = new CompositeDisposable();
    lumine.notifications.clear();

    editor = await lumine.workspace.open(path.join(os.tmpdir(), "code-lens-example.js"));
    editor.setText("function one() {}\nfunction two() {}\nfunction three() {}\n");

    const pack = await lumine.packages.activatePackage(packageRoot);
    mainModule = pack.mainModule;
    manager = mainModule.manager;
    lumine.config.set("code-lens.enabled", true);
    await microtasks();
  });

  afterEach(async () => {
    disposables.dispose();
    await lumine.packages.deactivatePackage("code-lens");
    for (const open of lumine.workspace.getTextEditors()) open.destroy();
  });

  // A provider following the code-lens.provider contract: `grammarScopes` is a
  // getter, `codeLenses` answers for the whole buffer, and `resolveCodeLens`
  // only exists when the provider can complete a placeholder.
  function addProvider({ codeLenses, resolveCodeLens, priority } = {}) {
    const emitter = new Emitter();
    const provider = {
      get grammarScopes() {
        return [editor.getGrammar().scopeName];
      },
      priority,
      codeLenses,
      onDidInvalidate: (fn) => emitter.on("invalidate", fn),
      invalidate: (event) => emitter.emit("invalidate", event),
    };
    if (resolveCodeLens) provider.resolveCodeLens = resolveCodeLens;
    disposables.add(mainModule.consumeCodeLens(provider));
    return provider;
  }

  const rowItems = () => editor.getElement().querySelectorAll(".code-lens");
  const textsByRow = () =>
    [...rowItems()].map((item) => [...item.children].map((a) => a.textContent));

  it("renders lenses as block decorations grouped per row", async () => {
    addProvider({
      codeLenses: async () => [
        lensAt(0, "3 references", { execute() {} }),
        lensAt(0, "run test", { execute() {} }),
        lensAt(2, "1 reference", { execute() {} }),
      ],
    });
    await microtasks();

    expect(rowItems().length).toBe(2);
    expect(textsByRow()).toContain(["3 references", "run test"]);
    expect(textsByRow()).toContain(["1 reference"]);

    const state = manager.states.get(editor);
    expect([...state.rows.keys()].sort()).toEqual([0, 2]);
    expect(state.rows.get(0).decoration.getProperties().type).toBe("block");
    expect(state.rows.get(0).decoration.getProperties().position).toBe("before");
  });

  it("stacks the lenses of several providers on one row, highest priority first", async () => {
    addProvider({ priority: 1, codeLenses: async () => [lensAt(0, "from low")] });
    addProvider({ priority: 5, codeLenses: async () => [lensAt(0, "from high")] });
    await microtasks();

    expect(textsByRow()).toEqual([["from high", "from low"]]);
  });

  it("shows a placeholder for an unresolved lens and resolves it on viewport entry", async () => {
    const resolveCodeLens = jasmine
      .createSpy("resolveCodeLens")
      .and.callFake(async (lens) => ({ ...lens, title: "Resolved", execute() {} }));
    addProvider({ codeLenses: async () => [lensAt(1, null, { data: 7 })], resolveCodeLens });
    await microtasks();

    const entry = manager.states.get(editor).rows.get(1);
    expect(entry.item.children[0].textContent).toBe("…");
    expect(resolveCodeLens).not.toHaveBeenCalled();

    // What the viewport tracker calls once the row is on screen.
    manager.resolveVisible(editor, [0, 2]);
    await microtasks();
    expect(resolveCodeLens).toHaveBeenCalled();
    expect(entry.item.children[0].textContent).toBe("Resolved");

    // A second pass must not resolve the same lens again.
    manager.resolveVisible(editor, [0, 2]);
    await microtasks();
    expect(resolveCodeLens.calls.count()).toBe(1);
  });

  it("drops a titleless lens from a provider that cannot resolve it", async () => {
    addProvider({ codeLenses: async () => [lensAt(0, null), lensAt(1, "kept")] });
    await microtasks();

    expect(textsByRow()).toEqual([["kept"]]);
  });

  it("refreshes in place on invalidation, keeping the marker and item of a surviving row", async () => {
    let lenses = [lensAt(0, "2 references"), lensAt(2, "old row")];
    const provider = addProvider({ codeLenses: async () => lenses });
    await microtasks();

    const state = manager.states.get(editor);
    const survivor = state.rows.get(0);
    const removed = state.rows.get(2);

    lenses = [lensAt(0, "3 references"), lensAt(1, "new row")];
    provider.invalidate({ editor });
    await microtasks();

    expect(state.rows.get(0)).toBe(survivor);
    expect(state.rows.get(0).marker.isDestroyed()).toBe(false);
    expect(state.rows.get(0).decoration).toBe(survivor.decoration);
    expect(state.rows.get(0).item.children[0].textContent).toBe("3 references");
    expect(removed.marker.isDestroyed()).toBe(true);
    expect([...state.rows.keys()].sort()).toEqual([0, 1]);
  });

  it("runs the lens on click, and does nothing for a lens with nothing to run", async () => {
    const execute = jasmine.createSpy("execute");
    addProvider({
      codeLenses: async () => [lensAt(0, "run test", { execute }), lensAt(1, "a label")],
    });
    await microtasks();

    const click = (node) =>
      node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    click(editor.getElement().querySelector(".code-lens a"));
    await microtasks();
    expect(execute.calls.count()).toBe(1);

    const label = manager.states.get(editor).rows.get(1).item.children[0];
    expect(label.classList.contains("code-lens-inert")).toBe(true);
    click(label);
    await microtasks();
    expect(execute.calls.count()).toBe(1);
  });

  it("reports a failing lens command in one dismissable error notification", async () => {
    addProvider({
      codeLenses: async () => [
        lensAt(0, "boom", {
          execute() {
            throw new Error("no can do");
          },
        }),
      ],
    });
    await microtasks();

    editor
      .getElement()
      .querySelector(".code-lens a")
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await microtasks();

    const notifications = lumine.notifications.getNotifications();
    expect(notifications.length).toBe(1);
    expect(notifications[0].getType()).toBe("error");
    expect(notifications[0].isDismissable()).toBe(true);
    expect(notifications[0].getOptions().detail).toBe("no can do");
  });

  it("asks no provider and renders nothing while the scoped setting is off", async () => {
    lumine.config.set("code-lens.enabled", false);
    const codeLenses = jasmine.createSpy("codeLenses").and.resolveTo([lensAt(0, "hidden")]);
    addProvider({ codeLenses });
    await microtasks();

    expect(codeLenses).not.toHaveBeenCalled();
    expect(manager.states.get(editor).rows.size).toBe(0);

    // Turning it back on fetches without waiting for an edit.
    lumine.config.set("code-lens.enabled", true);
    await microtasks();
    expect(codeLenses).toHaveBeenCalled();
    expect(textsByRow()).toEqual([["hidden"]]);
  });

  it("keeps the other providers rendering when one throws", async () => {
    addProvider({
      priority: 5,
      codeLenses: async () => {
        throw new Error("provider is broken");
      },
    });
    addProvider({ priority: 1, codeLenses: async () => [lensAt(0, "still here")] });
    await microtasks();

    expect(textsByRow()).toEqual([["still here"]]);
  });

  it("drops everything a provider rendered once it is disposed", async () => {
    const subscription = mainModule.consumeCodeLens({
      codeLenses: async () => [lensAt(0, "temporary")],
    });
    await microtasks();
    expect(rowItems().length).toBe(1);

    subscription.dispose();
    await microtasks();
    expect(rowItems().length).toBe(0);
  });
});
