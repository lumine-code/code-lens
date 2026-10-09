const CodeLensManager = require("./code-lens-manager");

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "code-lens",
      tips: [
        "{% if keys['code-lens:toggle'] %}You can show or hide the actionable links above your code with {{ 'code-lens:toggle' | keystroke }}{% else %}You can show reference counts and run buttons above your functions by enabling Code Lens for a language in the settings.{% endif %}",
      ],
    };
  },

  activate() {
    this.manager = new CodeLensManager();
  },

  deactivate() {
    const manager = this.manager;
    this.manager = null;
    manager?.dispose();
  },

  consumeCodeLens(provider) {
    return this.manager.registry.addProvider(provider);
  },
};
