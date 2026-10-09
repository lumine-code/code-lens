const { Disposable } = require("lumine");

describe("Code Lens manager request ownership", () => {
  let main, manager, editor, leases;
  const lens = (title, extra = {}) => ({
    range: [
      [0, 0],
      [0, 1],
    ],
    ...(title ? { title } : {}),
    ...extra,
  });
  const settle = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    editor = await lumine.workspace.open();
    editor.setText("owned lens\n");
    main = (await lumine.packages.activatePackage("code-lens")).mainModule;
    manager = main.manager;
    leases = [];
    await settle();
  });
  afterEach(async () => {
    leases.forEach((lease) => lease.dispose());
    await lumine.packages.deactivatePackage("code-lens");
  });
  function provide(provider) {
    const lease = lumine.packages.serviceHub.provide("code-lens.provider", "1.0.0", provider);
    leases.push(lease);
    return lease;
  }

  it("does not invoke a provider after its documented scope getter retires the manager", async () => {
    let armed = false;
    const codeLenses = jasmine.createSpy("retired lens fetch").and.resolveTo([]);
    provide({
      get grammarScopes() {
        if (armed) main.deactivate();
        return [editor.getGrammar().scopeName];
      },
      codeLenses,
    });
    await settle();
    codeLenses.calls.reset();
    armed = true;

    manager.fetchEditor(editor);
    await settle();

    expect(codeLenses).not.toHaveBeenCalled();
  });

  it("does not execute a withdrawn visible source while another refetch remains pending", async () => {
    let delayed = false,
      finish;
    provide({ codeLenses: () => (delayed ? new Promise((resolve) => (finish = resolve)) : []) });
    const execute = jasmine.createSpy("withdrawn command");
    const old = provide({ codeLenses: () => [lens("Old action", { execute })] });
    await settle();
    const entry = manager.states.get(editor).rows.get(0);
    const anchor = entry.item.firstChild;
    delayed = true;

    old.dispose();
    expect(entry.marker.isDestroyed()).toBe(true);
    expect(manager.states.get(editor).rows.has(0)).toBe(false);
    manager.didClick(entry, { target: anchor, preventDefault() {} });
    await settle();

    expect(execute).not.toHaveBeenCalled();
    finish([]);
    await settle();
  });

  it("does not publish a retired lazy resolve into the still-visible old row", async () => {
    let delayed = false,
      finishFetch,
      finishResolve;
    provide({
      codeLenses: () => (delayed ? new Promise((resolve) => (finishFetch = resolve)) : []),
    });
    const placeholder = lens(null);
    const old = provide({
      codeLenses: () => [placeholder],
      resolveCodeLens: () => new Promise((resolve) => (finishResolve = resolve)),
    });
    await settle();
    const entry = manager.states.get(editor).rows.get(0);
    manager.resolveVisible(editor, [0, 1]);
    await settle();
    delayed = true;
    old.dispose();

    finishResolve(lens("Retired resolve"));
    await settle();

    expect(entry.item.textContent).not.toContain("Retired resolve");
    finishFetch([]);
    await settle();
  });

  it("does not lose a replacement manager created from old provider cleanup", () => {
    let replacement;
    provide({
      codeLenses: () => [],
      onDidInvalidate: () =>
        new Disposable(() => {
          main.activate();
          replacement = main.manager;
        }),
    });

    main.deactivate();

    expect(main.manager).toBe(replacement);
    if (main.manager !== replacement) replacement.dispose();
  });

  it("does not create a block after a returned range getter retires the manager", async () => {
    provide({
      codeLenses: () => [
        {
          get range() {
            main.deactivate();
            return [
              [0, 0],
              [0, 1],
            ];
          },
          title: "Retired range",
        },
      ],
    });
    await settle();

    expect(
      editor
        .getDecorations({ type: "block" })
        .filter((item) => item.getProperties().item?.classList?.contains("code-lens")),
    ).toEqual([]);
    expect(manager.states.size).toBe(0);
  });
});
