# code-lens.provider

Supplies the actionable links rendered above the code they describe.

|             |                                                         |
| ----------- | ------------------------------------------------------- |
| Version     | `1.0.0`                                                 |
| Provided by | `provideCodeLens()` returning one provider              |
| Consumed by | `consumeCodeLens(provider)` returning a `Disposable`    |
| Owner       | [`code-lens`](https://github.com/lumine-code/code-lens) |

If your lenses come from a language server, register an adapter with `ide-client` instead — it already provides this service on every adapter's behalf. Implement this directly only for a source that is not LSP: a test runner, a blame reader, a build system.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "code-lens.provider": {
      "versions": { "1.0.0": "provideCodeLens" }
    }
  }
}
```

## Contract

```ts
type CodeLensProvider = {
  codeLenses(editor: TextEditor): Promise<CodeLens[] | null> | CodeLens[] | null;
  resolveCodeLens?(lens: CodeLens, editor: TextEditor): Promise<CodeLens | null> | CodeLens | null;
  onDidInvalidate?(callback: (event: { editor?: TextEditor }) => void): Disposable;
  grammarScopes?: string[] | Set<string>;
  priority?: number;
};

type CodeLens = {
  range: Range | [[number, number], [number, number]];
  title?: string;
  tooltip?: string;
  execute?(): void | Promise<void>;
};
```

Required members:

| Member               | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `codeLenses(editor)` | The lenses for the whole buffer, or `null` to decline this editor. |

Optional members:

| Member                          | Description                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `resolveCodeLens(lens, editor)` | Fill in a placeholder lens when its row scrolls into view. See Lazy resolution.               |
| `onDidInvalidate(callback)`     | Announce that your lenses went stale. Pass `{editor}` to refetch one, nothing to refetch all. |
| `grammarScopes`                 | Scope names you serve. **Omitting it means every grammar.** May be a getter — see Behavior.   |
| `priority`                      | Higher sorts first within a row. Defaults to `0`; `ide-client` uses `2`.                      |

Only the **start row** of `range` decides placement: the lens is drawn on its own line above that buffer row, and the column is ignored. Return the range of the symbol anyway — it is what keeps the lens on the right line as the buffer is edited.

`title` is the text rendered. `execute` is what a click runs; a lens with a `title` and no `execute` renders as plain text rather than a link, which is how a purely informational lens is written. `tooltip` becomes the link's `title` attribute.

## Lazy resolution

A lens without a `title` is a **placeholder**: it renders as `…` and holds its row while the expensive half of the answer is still being computed. When its row scrolls into view, `resolveCodeLens(lens, editor)` is asked for the finished lens, and the result replaces the placeholder in place.

This exists because counting references for every symbol in a file is far more work than locating the symbols. Split the work when yours splits the same way, and return complete lenses from `codeLenses` when it does not.

A provider that declares no `resolveCodeLens` should always return a `title`. A titleless lens from such a provider can never be completed, so it is dropped rather than left as a permanent `…`.

Resolution is attempted once per lens. A rejection leaves the placeholder on screen and is not retried until the next fetch, so a provider whose resolve can fail transiently should return a lens describing the failure rather than rejecting.

## Minimal example

```js
module.exports = {
  provideCodeLens() {
    return {
      grammarScopes: ["source.mylang"],
      async codeLenses(editor) {
        const tests = await findTests(editor.getText());
        return tests.map((test) => ({
          range: test.range,
          title: "Run test",
          tooltip: `Run ${test.name}`,
          execute: () => runTest(test),
        }));
      },
    };
  },
};
```

## Behavior

Every provider serving the editor's grammar is asked, and **all of their lenses are shown together** — a reference count from a language server and a run button from a test runner belong on the same line. Lenses landing on one row are laid out side by side, ordered by descending provider `priority` and then by the order the provider returned them. Priority orders a row; it does not silence anyone.

Fetching is debounced: a refetch happens one second after the buffer stops changing, so typing does not put a request in flight per keystroke. Between fetches the lenses ride anchored markers, so they keep pace with edits above them.

A refresh reconciles in place rather than rebuilding. A row that survives keeps its marker, its decoration and its DOM, and only its text is updated. This matters because a block decoration has no scroll anchoring: destroying and recreating the item for a row that was going to exist anyway makes the viewport jump under the reader.

`grammarScopes` is **read through on every call, never snapshotted**. That is deliberate: a hub provider exposes it as a getter whose value changes as language server sessions come and go. A plain array is fine for a fixed set of grammars, but do not assume the registry cached it.

Rendering is off by default and is switched on with the scoped `code-lens.enabled` setting, so a user can enable it for one language and not for the rest. While it is off no provider is asked at all — `codeLenses` is never called, so an expensive provider costs nothing until someone wants it.

A provider that throws is skipped for that fetch; the other providers still render.

## Teardown

`consumeCodeLens` returns a `Disposable` that removes the provider from the registry and drops whatever it had rendered. Return it from your own consumer method or add it to your collection; nothing else is held on your behalf.

The `Disposable` returned by `onDidInvalidate` is disposed for you when the provider is removed.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
