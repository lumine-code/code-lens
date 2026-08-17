const CodeLensManager = require("./code-lens-manager");

module.exports = {
  activate() {
    this.manager = new CodeLensManager();
  },

  deactivate() {
    this.manager?.dispose();
    this.manager = null;
  },

  consumeCodeLens(provider) {
    return this.manager.registry.addProvider(provider);
  },
};
