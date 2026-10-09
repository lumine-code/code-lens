const { Emitter, Disposable } = require("lumine");

// Keeps the providers of one service. `grammarScopes` is read through on every
// call: hub providers expose it as a getter whose value changes as language
// server sessions come and go, so it must never be snapshotted.
module.exports = class ProviderRegistry {
  constructor() {
    this.emitter = new Emitter();
    this.providers = [];
    this.records = new Map();
    this.disposed = false;
  }

  addProvider(provider) {
    if (this.disposed || !provider || typeof provider.codeLenses !== "function") {
      return new Disposable(() => {});
    }
    // Validation can invoke a getter that retires this registry.
    if (this.disposed) return new Disposable(() => {});
    let record = this.records.get(provider);
    if (record) {
      record.leases++;
    } else {
      record = { provider, leases: 1, subscription: null };
      this.records.set(provider, record);
      this.providers.push(provider);
      // Identical hub payloads share one subscription and one rendered source.
      // Publish the record before calling the provider, which may reenter us.
      let subscription;
      try {
        subscription = provider.onDidInvalidate?.((event) => {
          if (!this.disposed && this.records.get(provider) === record) {
            this.emitter.emit("invalidate", { provider, editor: event?.editor ?? null });
          }
        });
      } catch (error) {
        this.removeProvider(provider, record);
        throw error;
      }
      if (this.disposed || this.records.get(provider) !== record) {
        subscription?.dispose();
      } else {
        record.subscription = subscription;
        this.emitter.emit("change");
      }
    }
    return new Disposable(() => {
      if (this.disposed || this.records.get(provider) !== record) return;
      if (--record.leases === 0) this.removeProvider(provider, record);
    });
  }

  removeProvider(provider, record = this.records.get(provider)) {
    if (!record || this.records.get(provider) !== record) return;
    this.records.delete(provider);
    const index = this.providers.indexOf(provider);
    if (index !== -1) this.providers.splice(index, 1);
    // Unpublish before opaque cleanup so an old lease cannot remove a re-add.
    const subscription = record.subscription;
    record.subscription = null;
    subscription?.dispose();
    if (!this.disposed) this.emitter.emit("change");
  }

  // All providers claiming the editor's grammar, highest priority first. The
  // sort is stable, so equal priorities keep registration order, which is what
  // decides the left-to-right order of the lenses sharing a row.
  getAllProvidersForEditor(editor) {
    return this.getAllRegistrationsForEditor(editor).map((record) => record.provider);
  }

  isRegistered(record) {
    return !this.disposed && record != null && this.records.get(record.provider) === record;
  }

  getAllRegistrationsForEditor(editor) {
    const scopeName = editor.getGrammar()?.scopeName;
    return [...this.records.values()]
      .filter((record) => {
        if (!this.isRegistered(record)) return false;
        const { provider } = record;
        const scopes = provider.grammarScopes;
        const matches = !scopes || Array.from(scopes).includes(scopeName);
        return this.isRegistered(record) && matches;
      })
      .sort((a, b) => (b.provider.priority ?? 0) - (a.provider.priority ?? 0))
      .filter((record) => this.isRegistered(record));
  }

  // fn() — a provider was added or removed.
  onDidChange(fn) {
    return this.emitter.on("change", fn);
  }

  // fn({provider, editor}) — a provider says its lenses went stale. A null
  // editor means every editor it serves.
  onDidInvalidate(fn) {
    return this.emitter.on("invalidate", fn);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const records = [...this.records.values()];
    this.records.clear();
    this.providers = [];
    for (const record of records) record.subscription?.dispose();
    this.emitter.dispose();
  }
};
