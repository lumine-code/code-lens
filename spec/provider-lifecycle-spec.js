const path = require("path");
const { CompositeDisposable, Emitter } = require("lumine");

async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

describe("code-lens provider connection lifetime", () => {
  let main, editor, hub, consumer, disposables;
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    editor = await lumine.workspace.open();
    editor.setText("function example() {}\n");
    ({ mainModule: main } = await lumine.packages.activatePackage(path.join(__dirname, "..")));
    hub = new lumine.packages.serviceHub.constructor();
    consumer = hub.consume("code-lens.provider", "^1.0.0", (provider) =>
      main.consumeCodeLens(provider),
    );
    disposables = new CompositeDisposable(consumer);
  });
  afterEach(async () => {
    disposables.dispose();
    await lumine.packages.deactivatePackage("code-lens");
    for (const open of lumine.workspace.getTextEditors()) open.destroy();
  });
  function provider() {
    const emitter = new Emitter();
    disposables.add(emitter);
    let title = "first";
    const callbacks = [];
    const payload = {
      codeLenses: jasmine.createSpy("codeLenses").and.callFake(async () => [
        {
          title,
          range: [
            [0, 0],
            [0, 1],
          ],
        },
      ]),
      onDidInvalidate(callback) {
        callbacks.push(callback);
        return emitter.on("invalidate", callback);
      },
    };
    return {
      payload,
      callbacks,
      listeners: () => emitter.listenerCountForEventName("invalidate"),
      invalidate(nextTitle) {
        title = nextTitle;
        emitter.emit("invalidate", { editor });
      },
    };
  }
  function provide(payload) {
    const lease = hub.provide("code-lens.provider", "1.0.0", payload);
    disposables.add(lease);
    return lease;
  }
  const titles = () =>
    [...editor.getElement().querySelectorAll(".code-lens a")].map((item) => item.textContent);

  it("shares one rendered provider and invalidation subscription until the final hub edge ends", async () => {
    const entry = provider();
    const first = provide(entry.payload),
      second = provide(entry.payload);
    await settle();
    expect(entry.listeners()).toBe(1);
    expect(titles()).toEqual(["first"]);
    first.dispose();
    expect(entry.listeners()).toBe(1);
    entry.invalidate("updated");
    await settle();
    expect(titles()).toEqual(["updated"]);
    second.dispose();
    await settle();
    expect(entry.listeners()).toBe(0);
    expect(titles()).toEqual([]);
  });

  it("retires all subscriptions and ignores saved callbacks after package deactivation", async () => {
    const entry = provider();
    provide(entry.payload);
    provide(entry.payload);
    await settle();
    const registry = main.manager.registry;
    const invalidate = jasmine.createSpy("retired invalidation");
    disposables.add(registry.onDidInvalidate(invalidate));
    await lumine.packages.deactivatePackage("code-lens");
    expect(entry.listeners()).toBe(0);
    entry.callbacks.forEach((callback) => callback({ editor }));
    expect(invalidate).not.toHaveBeenCalled();
    expect(titles()).toEqual([]);
  });

  it("keeps a replacement registration when an old manual lease is disposed", async () => {
    const entry = provider();
    const registry = main.manager.registry;
    const oldLease = registry.addProvider(entry.payload);
    disposables.add(oldLease);
    registry.removeProvider(entry.payload);
    provide(entry.payload);
    oldLease.dispose();
    await settle();
    expect(entry.listeners()).toBe(1);
    expect(titles()).toEqual(["first"]);
    entry.payload.codeLenses.calls.reset();
    entry.callbacks[0]({ editor });
    await settle();
    expect(entry.payload.codeLenses).not.toHaveBeenCalled();
  });

  it("keeps a current package generation independent of retained old leases", async () => {
    const entry = provider();
    const oldLease = main.consumeCodeLens(entry.payload);
    disposables.add(oldLease);
    await lumine.packages.deactivatePackage("code-lens");
    ({ mainModule: main } = await lumine.packages.activatePackage(path.join(__dirname, "..")));
    provide(entry.payload);
    oldLease.dispose();
    await settle();
    expect(entry.listeners()).toBe(1);
    expect(titles()).toEqual(["first"]);
  });

  it("reads changing grammar scopes and priorities without replacing shared subscriptions", async () => {
    const first = provider(),
      second = provider();
    let scopes = [],
      priority = 1;
    Object.defineProperties(first.payload, {
      grammarScopes: { get: () => scopes },
      priority: { get: () => priority },
    });
    second.payload.priority = 2;
    provide(first.payload);
    provide(first.payload);
    provide(second.payload);
    second.invalidate("second");
    await settle();
    expect(titles()).toEqual(["second"]);
    scopes = [editor.getGrammar().scopeName];
    first.invalidate("first");
    await settle();
    expect(titles()).toEqual(["second", "first"]);
    priority = 3;
    first.invalidate("higher");
    await settle();
    expect(titles()).toEqual(["higher", "second"]);
    expect(first.listeners()).toBe(1);
    expect(second.listeners()).toBe(1);
  });

  it("releases a subscription returned after its package was deactivated during registration", async () => {
    const entry = provider();
    const subscribe = entry.payload.onDidInvalidate;
    let deactivation;
    entry.payload.onDidInvalidate = (callback) => {
      const subscription = subscribe(callback);
      deactivation = lumine.packages.deactivatePackage("code-lens");
      return subscription;
    };
    provide(entry.payload);
    await deactivation;
    await settle();
    expect(entry.listeners()).toBe(0);
    expect(titles()).toEqual([]);
  });

  it("rolls back a failed invalidation registration and allows a later retry", async () => {
    const entry = provider();
    const subscribe = entry.payload.onDidInvalidate;
    entry.payload.onDidInvalidate = () => {
      throw new Error("cannot subscribe");
    };
    expect(() => main.consumeCodeLens(entry.payload)).toThrowError("cannot subscribe");
    expect(main.manager.registry.getAllProvidersForEditor(editor)).toEqual([]);
    entry.payload.onDidInvalidate = subscribe;
    provide(entry.payload);
    await settle();
    expect(entry.listeners()).toBe(1);
    expect(titles()).toEqual(["first"]);
  });

  it("does not retain a provider when its validation getter deactivates the package", async () => {
    const registry = main.manager.registry;
    const payload = {
      get codeLenses() {
        main.deactivate();
        return () => [];
      },
    };
    disposables.add(main.consumeCodeLens(payload));
    expect(registry.getAllProvidersForEditor(editor)).toEqual([]);
  });
});
