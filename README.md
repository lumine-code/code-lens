# code-lens

Show actionable command links above the code they describe.

Lenses come from provider packages — typically language-server backends — and are drawn on their own line above the symbol they annotate, where a click runs whatever the provider attached to them.

## Features

- **Inline actions**: renders each lens as a link above its symbol, so a reference count or a run button sits where the code it describes is.
- **Every source at once**: stacks the lenses of all providers claiming a row side by side, ordered by provider priority.
- **Lazy resolution**: shows a placeholder for a lens whose label is still being computed and fills it in when the row scrolls into view.
- **In-place refresh**: reconciles a refetch row by row, so lenses that survive keep their decoration and the viewport never jumps.
- **Per language**: stays off until enabled, and can be enabled for one language and not the rest through scoped settings.
- **Edit tracking**: anchors every lens to a marker, so it keeps pace with edits above it between fetches.

## Installation

To install `code-lens` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/code-lens`.

## Commands

Commands available in `lumine-workspace`:

- `code-lens:toggle`: show or hide the lens links above your code,
- `code-lens:refresh`: ask the providers for the active file's lenses again.

## Customization

The lens row can be adjusted in the `styles.css` file, e.g. make the links stand out more:

```css
.code-lens a {
  color: var(--text-color-info);
  font-style: italic;
}
```

## Services

- [`code-lens.provider`](docs/code-lens.provider.md): consumed to collect the lenses shown above the code, from providers such as IDE backend packages.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
