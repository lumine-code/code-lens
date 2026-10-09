describe("Code Lens resolution in an already visible viewport", () => {
  let editor, main, lease;
  const settle = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  const lens = () => ({
    range: [
      [0, 0],
      [0, 4],
    ],
  });

  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"]) {
      spyOn(lumine.shell, method).and.resolveTo();
    }
    spyOn(lumine.application, "openWindow").and.resolveTo();
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "800px";
    workspace.style.height = "400px";
    jasmine.attachToDOM(workspace);
    editor = await lumine.workspace.open();
    editor.setText("visible symbol\n");
    main = (await lumine.packages.activatePackage("code-lens")).mainModule;
    await waitForFrames(() => main.manager.tracker.states.get(editor).visible === true);
    await settle();
    expect(main.manager.tracker.states.get(editor).visible).toBe(true);
  });

  afterEach(() => {
    lease?.dispose();
    lease = null;
  });

  it("resolves an asynchronous result without requiring scrolling or typing", async () => {
    let finish;
    const resolve = jasmine
      .createSpy("resolve visible lens")
      .and.callFake(async (item) => ({ ...item, title: "3 references" }));
    lease = lumine.packages.serviceHub.provide("code-lens.provider", "1.0.0", {
      codeLenses: () =>
        new Promise((done) => {
          finish = done;
        }),
      resolveCodeLens: resolve,
    });
    await settle();
    finish([lens()]);
    await settle();
    expect(resolve.calls.count()).toBe(1);
    expect(main.manager.states.get(editor).rows.get(0).item.textContent).toBe("3 references");
  });

  it("resolves a refreshed placeholder while retaining the visible row", async () => {
    let current = { ...lens(), title: "Before refresh" };
    const resolve = jasmine
      .createSpy("resolve refreshed lens")
      .and.callFake(async (item) => ({ ...item, title: "After refresh" }));
    lease = lumine.packages.serviceHub.provide("code-lens.provider", "1.0.0", {
      codeLenses: () => [current],
      resolveCodeLens: resolve,
    });
    await settle();
    const entry = main.manager.states.get(editor).rows.get(0);
    current = lens();
    lumine.commands.dispatch(editor.getElement(), "code-lens:refresh");
    await settle();
    expect(main.manager.states.get(editor).rows.get(0)).toBe(entry);
    expect(resolve.calls.count()).toBe(1);
    expect(entry.item.textContent).toBe("After refresh");
  });

  it("defers a hidden editor's placeholder until its tab is revealed", async () => {
    await lumine.workspace.open();
    await waitForFrames(() => main.manager.tracker.states.get(editor).visible === false);
    const resolve = jasmine
      .createSpy("resolve revealed lens")
      .and.callFake(async (item) => ({ ...item, title: "Revealed" }));
    lease = lumine.packages.serviceHub.provide("code-lens.provider", "1.0.0", {
      codeLenses: (target) => (target === editor ? [lens()] : []),
      resolveCodeLens: resolve,
    });
    await settle();
    expect(resolve).not.toHaveBeenCalled();
    await lumine.workspace.open(editor);
    await waitForFrames(() => resolve.calls.count() === 1);
    await settle();
    expect(main.manager.states.get(editor).rows.get(0).item.textContent).toBe("Revealed");
  });
});
