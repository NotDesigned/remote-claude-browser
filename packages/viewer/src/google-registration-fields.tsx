const exampleFirstNames = "Ottilie Melvin Amelia Eino Olga Luisa Manuel Ryann Jarod Thalia".split(
  " ",
);
const exampleLastNames =
  "Zulauf Kessler Haag Durgan Koch Hane Kuhlman MacGyver Feil Mitchell".split(" ");

function registrationExample() {
  const firstName = exampleFirstNames[Math.floor(Math.random() * exampleFirstNames.length)]!;
  const lastName = exampleLastNames[Math.floor(Math.random() * exampleLastNames.length)]!;
  const birthday = new Date(Date.UTC(1995, 0, 1) + Math.random() * 11 * 365.25 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const username = `${firstName}.${lastName}${Math.floor(10 + Math.random() * 90)}`.toLowerCase();
  return { firstName, lastName, birthday, username };
}

export function GoogleRegistrationFields({ busy = false }: { busy?: boolean }) {
  return (
    <>
      <div class="user-panel-actions">
        <button
          type="button"
          disabled={busy}
          class="generate-example"
          onClick={(event) => {
            const form = event.currentTarget.form!;
            for (const [name, sample] of Object.entries(registrationExample())) {
              const input = form.elements.namedItem(name) as HTMLInputElement;
              if (!input.value || input.value === input.dataset.example) {
                input.value = sample;
                input.dataset.example = sample;
              }
            }
          }}
        >
          生成示例
        </button>
      </div>
      <div class="account-onboarding-fields">
        <ExampleField name="lastName" label="姓氏" autoComplete="family-name" />
        <ExampleField name="firstName" label="名字" autoComplete="given-name" />
        <ExampleField name="username" label="Gmail 用户名" autoComplete="username" />
        <ExampleField name="birthday" label="出生日期" autoComplete="bday" type="date" />
        <label>
          性别
          <select name="gender" required>
            <option value="female">女性</option>
            <option value="male">男性</option>
            <option value="other">其他</option>
            <option value="unspecified">不愿说明</option>
          </select>
        </label>
        <label>
          手机号
          <input name="phone" type="tel" autoComplete="tel" maxLength={40} />
        </label>
        <label>
          恢复邮箱
          <input name="recoveryEmail" type="email" autoComplete="email" maxLength={254} />
        </label>
      </div>
      <div class="account-onboarding-password">
        <label for="google-onboarding-password">密码</label>
        <input
          id="google-onboarding-password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
          disabled={busy}
        />
        <label for="google-onboarding-password-confirmation">确认密码</label>
        <input
          id="google-onboarding-password-confirmation"
          name="passwordConfirmation"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
          disabled={busy}
        />
      </div>
    </>
  );
}

function ExampleField({
  name,
  label,
  autoComplete,
  type = "text",
}: {
  name: "firstName" | "lastName" | "username" | "birthday";
  label: string;
  autoComplete: string;
  type?: string;
}) {
  return (
    <label>
      {label}
      <input
        name={name}
        type={type}
        autoComplete={autoComplete}
        maxLength={type === "date" ? undefined : name === "username" ? 30 : 100}
        onInput={(event) => {
          const field = event.currentTarget;
          if (field.value !== field.dataset.example) delete field.dataset.example;
        }}
        required
      />
    </label>
  );
}
