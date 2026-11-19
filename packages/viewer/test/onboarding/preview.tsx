import { render } from "preact";
import { useState } from "preact/hooks";
import { AppleRegistrationFields } from "../../src/apple-registration-fields";
import "../../src/app.css";
import "../../src/shell.css";
import "../../src/user-panel.css";
import "../../src/account-onboarding.css";
import "./preview.css";

function Preview() {
  const [submitted, setSubmitted] = useState(false);
  return (
    <div class="user-panel-backdrop">
      <section class="user-panel account-onboarding">
        <header class="user-panel-heading">
          <h2>注册表单测试</h2>
        </header>
        {submitted ? (
          <section class="user-panel-form" role="status">
            <p>本地模拟提交成功。</p>
            <button type="button" onClick={() => setSubmitted(false)}>
              重新测试
            </button>
          </section>
        ) : (
          <form
            class="user-panel-form"
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(true);
            }}
          >
            <AppleRegistrationFields
              preview
              options={{
                countries: [
                  ["USA", "美国"],
                  ["CHN", "中国大陆"],
                ],
                phoneCodes: [
                  ["CN", "+86 China Mainland"],
                  ["US", "+1 United States"],
                ],
              }}
            />
            <button class="user-panel-save" type="submit">
              模拟提交
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
render(<Preview />, document.getElementById("root")!);
