const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// These guards also precede activation in the existing package specs.
beforeEach(() => {
  for (const operation of ["openExternal", "openPath", "showItemInFolder", "openApplication"]) {
    if (!jasmine.isSpy(lumine.shell[operation])) spyOn(lumine.shell, operation).and.resolveTo();
  }
  if (!jasmine.isSpy(lumine.application.openWindow))
    spyOn(lumine.application, "openWindow").and.resolveTo();
});

describe("Code Lens editor identity", () => {
  let first, second, firstPane, scratch, tempRoot, lease;
  const settle = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  const lens = (title) => ({
    range: [
      [0, 0],
      [0, 4],
    ],
    title,
  });
  const titles = (editor = first) =>
    [...editor.getElement().querySelectorAll(".code-lens a")].map((anchor) => anchor.textContent);

  beforeEach(async () => {
    if (lumine.packages.isPackageLoaded("code-lens"))
      await lumine.packages.unloadPackage("code-lens");
    tempRoot = fs.realpathSync.native(os.tmpdir());
    scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tempRoot, "code-lens-identity-")));
    for (const name of ["before.txt", "after.txt"])
      fs.writeFileSync(path.join(scratch, name), "symbol\n");
    jasmine.attachToDOM(lumine.workspace.getElement());
    first = await lumine.workspace.open(path.join(scratch, "before.txt"));
    first.getElement().setUpdatedSynchronously(true);
    firstPane = lumine.workspace.paneForItem(first);
    await lumine.packages.activatePackage("code-lens");
    await settle();
  });

  afterEach(async () => {
    lease?.dispose();
    lease = null;
    if (lumine.packages.isPackageLoaded("code-lens"))
      await lumine.packages.unloadPackage("code-lens");
    first?.destroy();
    second?.destroy();
    second = null;
    await lumine.fileWatchClient.settlePendingTeardown();
    const resolved = fs.realpathSync.native(scratch);
    const relative = path.relative(tempRoot, resolved);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !path.basename(resolved).startsWith("code-lens-identity-")
    )
      throw new Error("Owned fixture cleanup escaped its temporary root");
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function provide(codeLenses) {
    lease = lumine.packages.serviceHub.provide("code-lens.provider", "1.0.0", { codeLenses });
  }

  it("refreshes the inactive split editor that dispatched the command", async () => {
    firstPane.splitRight();
    second = await lumine.workspace.open(path.join(scratch, "after.txt"));
    second.getElement().setUpdatedSynchronously(true);
    firstPane.activate();
    const calls = [];
    provide((editor) => {
      calls.push(editor);
      return [lens(path.basename(editor.getPath()))];
    });
    await settle();
    calls.length = 0;

    lumine.commands.dispatch(second.getElement(), "code-lens:refresh");
    await settle();

    expect(lumine.workspace.getActiveTextEditor()).toBe(first);
    expect(calls).toEqual([second]);
    expect(titles(second)).toEqual(["after.txt"]);
  });

  it("does not refresh an editor for an unrelated workspace target", async () => {
    const calls = [];
    provide((editor) => {
      calls.push(editor);
      return [lens("ordinary")];
    });
    await settle();
    calls.length = 0;
    lumine.commands.dispatch(lumine.workspace.getElement(), "code-lens:refresh");
    await settle();
    expect(calls).toEqual([]);
    expect(titles()).toEqual(["ordinary"]);
  });

  it("refetches path-dependent lenses when the path changes without a text edit", async () => {
    provide((editor) => [lens(path.basename(editor.getPath()))]);
    await settle();
    expect(titles()).toEqual(["before.txt"]);
    const oldText = first.getText();
    const oldGrammar = first.getGrammar();

    first.getBuffer().setPath(path.join(scratch, "after.txt"));
    await settle();

    expect(first.getText()).toBe(oldText);
    expect(first.getGrammar()).toBe(oldGrammar);
    expect(titles()).toEqual(["after.txt"]);
  });

  it("rejects a pending response for the old path after the document is renamed", async () => {
    const requests = [];
    provide(
      (editor) =>
        new Promise((resolve) => requests.push({ file: path.basename(editor.getPath()), resolve })),
    );
    await settle();
    const oldRequest = requests.find((request) => request.file === "before.txt");
    first.getBuffer().setPath(path.join(scratch, "after.txt"));
    await settle();
    const currentRequest = requests.findLast((request) => request.file === "after.txt");
    currentRequest?.resolve([lens("after.txt")]);
    await settle();
    oldRequest.resolve([lens("before.txt")]);
    await settle();

    expect(currentRequest).toBeDefined();
    expect(titles()).toEqual(["after.txt"]);
  });
});
