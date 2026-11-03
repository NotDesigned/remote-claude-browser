import { render } from "preact";
import { App } from "./app";

// WebKit suppresses parent-installed input listeners in script-disabled frames. All modules
// are loaded now. Lock subsequent script execution and frame navigation before creating mirrors.
const replayPolicy = document.createElement("meta");
replayPolicy.httpEquiv = "Content-Security-Policy";
replayPolicy.content =
  "script-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
document.head.appendChild(replayPolicy);

render(<App />, document.getElementById("root")!);
