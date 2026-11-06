"use strict";

const vscode = require("vscode");

function t(message, ...args) {
  return vscode.l10n.t(message, ...args);
}

function webviewL10nScript() {
  const json = JSON.stringify(vscode.l10n.bundle || {}).replace(/</g, "\\u003c");
  return `<script>
    const l10nBundle = ${json};
    function t(message, ...args) {
      let text = Object.prototype.hasOwnProperty.call(l10nBundle, message) ? l10nBundle[message] : message;
      args.forEach((arg, index) => {
        text = text.split("{" + index + "}").join(String(arg));
      });
      return text;
    }
  </script>`;
}

module.exports = { t, webviewL10nScript };
