import { render } from "preact";
import { AccountOnboarding } from "../../src/account-onboarding";
import "../../src/app.css";
import "../../src/shell.css";
import "./preview.css";

render(
  <AccountOnboarding
    open
    sid="preview"
    profileKey="preview"
    profileName="预览配置"
    storage={sessionStorage}
    tabs={[]}
    browserConnected={false}
    onClose={() => location.reload()}
    onOpenTab={() => {}}
  />,
  document.getElementById("root")!,
);
